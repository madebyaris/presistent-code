import mysql from "mysql2/promise";

import type { ExportedPack, RemoteProfile, Rule, SearchResult, ShareToken, StylePack, SyncOptions } from "./types.js";
import { APP_NAME, APP_VERSION, nowIso } from "./utils.js";
import { LocalStore } from "./local-store.js";

type MySqlConn = mysql.Connection;

export async function provisionTiDbZero(tag = APP_NAME): Promise<RemoteProfile> {
  const response = await fetch("https://zero.tidbapi.com/v1beta1/instances", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ tag }),
  });

  if (!response.ok) {
    throw new Error(`TiDB Zero provisioning failed: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as {
    instance: {
      id: string;
      connectionString: string;
      expiresAt?: string;
    };
  };

  return {
    name: "default",
    kind: "tidb-zero",
    connectionString: payload.instance.connectionString,
    instanceId: payload.instance.id,
    expiresAt: payload.instance.expiresAt,
  };
}

export async function pushLocalStore(store: LocalStore, options: SyncOptions = {}): Promise<void> {
  const profile = store.getRemoteProfile(options.remoteName);
  const connection = await openRemoteConnection(profile);

  try {
    await ensureRemoteSchema(connection);
    const data = store.exportAllData(options);
    await connection.beginTransaction();

    for (const pack of data.packs) {
      await connection.execute(
        `insert into packs (id, name, slug, description, visibility, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)
         on duplicate key update
           name = values(name),
           slug = values(slug),
           description = values(description),
           visibility = values(visibility),
           created_at = values(created_at),
           updated_at = values(updated_at)`,
        [pack.id, pack.name, pack.slug, pack.description, pack.visibility, pack.createdAt, pack.updatedAt],
      );
    }

    for (const rule of data.rules) {
      await connection.execute(
        `insert into rules
         (id, pack_id, title, body_markdown, globs_json, globs_text, search_text, always_apply, sort_order, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on duplicate key update
           pack_id = values(pack_id),
           title = values(title),
           body_markdown = values(body_markdown),
           globs_json = values(globs_json),
           globs_text = values(globs_text),
           search_text = values(search_text),
           always_apply = values(always_apply),
           sort_order = values(sort_order),
           created_at = values(created_at),
           updated_at = values(updated_at)`,
        [
          rule.id,
          rule.packId,
          rule.title,
          rule.bodyMarkdown,
          JSON.stringify(rule.globs),
          rule.globs.join(" "),
          buildSearchText(rule),
          rule.alwaysApply ? 1 : 0,
          rule.sortOrder,
          rule.createdAt,
          rule.updatedAt,
        ],
      );
    }

    for (const token of data.shareTokens) {
      await connection.execute(
        `insert into share_tokens (id, pack_id, token, permission, expires_at, max_uses, created_at)
         values (?, ?, ?, ?, ?, ?, ?)
         on duplicate key update
           pack_id = values(pack_id),
           token = values(token),
           permission = values(permission),
           expires_at = values(expires_at),
           max_uses = values(max_uses),
           created_at = values(created_at)`,
        [
          token.id,
          token.packId,
          token.token,
          token.permission,
          token.expiresAt,
          token.maxUses,
          token.createdAt,
        ],
      );
    }

    await connection.commit();
    await store.updateRemoteProfile(profile.name, { lastPushAt: nowIso() });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    await connection.end();
  }
}

export async function pullRemoteIntoStore(store: LocalStore, options: SyncOptions = {}): Promise<void> {
  const profile = store.getRemoteProfile(options.remoteName);
  const connection = await openRemoteConnection(profile);

  try {
    await ensureRemoteSchema(connection);
    const [packsRows] = await connection.query("select * from packs");
    const [rulesRows] = await connection.query("select * from rules");
    const [shareRows] = await connection.query("select * from share_tokens");

    const packs = (packsRows as Array<Record<string, unknown>>)
      .map(mapRemotePack)
      .filter((pack) => !options.pack || pack.id === store.getPack(options.pack)?.id || pack.slug === options.pack);
    const allowedPackIds = new Set(packs.map((pack) => pack.id));
    const rules = (rulesRows as Array<Record<string, unknown>>)
      .map(mapRemoteRule)
      .filter((rule) => allowedPackIds.has(rule.packId));
    const shareTokens = (shareRows as Array<Record<string, unknown>>)
      .map(mapRemoteShareToken)
      .filter((token) => allowedPackIds.has(token.packId));

    store.upsertRemoteData({ packs, rules, shareTokens });
    await store.updateRemoteProfile(profile.name, { lastPullAt: nowIso() });
  } finally {
    await connection.end();
  }
}

export async function renewTiDbFromLocal(store: LocalStore, remoteName?: string): Promise<RemoteProfile> {
  const current = store.getRemoteProfile(remoteName);
  const next = await provisionTiDbZero(`${APP_NAME}-renew`);
  next.name = current.name;

  await store.setDefaultRemoteProfile(next);
  await pushLocalStore(store, { remoteName: next.name });

  return next;
}

export async function searchRemoteRules(
  store: LocalStore,
  query: string,
  options: { remoteName?: string; pack?: string; limit?: number } = {},
): Promise<SearchResult[]> {
  const profile = store.getRemoteProfile(options.remoteName);
  const connection = await openRemoteConnection(profile);
  const limit = options.limit ?? 10;

  try {
    const pack = options.pack ? store.getPack(options.pack) : null;
    const matchSql = `
      select *, match(search_text) against(? in natural language mode) as score
      from rules
      where match(search_text) against(? in natural language mode)
      ${pack ? "and pack_id = ?" : ""}
      order by score desc
      limit ?
    `;

    try {
      const [rows] = await connection.query(matchSql, pack ? [query, query, pack.id, limit] : [query, query, limit]);
      return (rows as Array<Record<string, unknown>>).map((row) => ({
        ...mapRemoteRule(row),
        score: Number(row.score ?? 0),
      }));
    } catch {
      const like = `%${query}%`;
      const [rows] = await connection.query(
        `select *
         from rules
         where (title like ? or body_markdown like ? or globs_text like ?)
         ${pack ? "and pack_id = ?" : ""}
         order by updated_at desc
         limit ?`,
        pack ? [like, like, like, pack.id, limit] : [like, like, like, limit],
      );

      return (rows as Array<Record<string, unknown>>).map((row, index) => ({
        ...mapRemoteRule(row),
        score: index + 1,
      }));
    }
  } finally {
    await connection.end();
  }
}

export async function resolveShareTokenFromRemote(
  store: LocalStore,
  token: string,
  options: { remoteName?: string; name?: string } = {},
): Promise<StylePack> {
  const profile = store.getRemoteProfile(options.remoteName);
  const connection = await openRemoteConnection(profile);

  try {
    const [shareRows] = await connection.query("select * from share_tokens where token = ? limit 1", [token]);
    const shareRow = (shareRows as Array<Record<string, unknown>>)[0];
    if (!shareRow) {
      throw new Error(`Share token "${token}" was not found on remote "${profile.name}".`);
    }

    const share = mapRemoteShareToken(shareRow);
    const [packRows] = await connection.query("select * from packs where id = ? limit 1", [share.packId]);
    const packRow = (packRows as Array<Record<string, unknown>>)[0];
    if (!packRow) {
      throw new Error(`Pack "${share.packId}" referenced by token "${token}" no longer exists.`);
    }

    const [ruleRows] = await connection.query("select * from rules where pack_id = ? order by sort_order asc", [
      share.packId,
    ]);
    const snapshot: ExportedPack = {
      schemaVersion: 1,
      exportedAt: nowIso(),
      pack: mapRemotePack(packRow),
      rules: (ruleRows as Array<Record<string, unknown>>).map(mapRemoteRule),
      shareTokens: [share],
    };

    return store.importPackSnapshot(snapshot, { name: options.name });
  } finally {
    await connection.end();
  }
}

async function ensureRemoteSchema(connection: MySqlConn): Promise<void> {
  await connection.query("create database if not exists persistent_code");
  await connection.query("use persistent_code");
  await connection.query(`
    create table if not exists packs (
      id varchar(191) primary key,
      name text not null,
      slug varchar(191) not null unique,
      description text not null,
      visibility varchar(32) not null,
      created_at datetime(3) not null,
      updated_at datetime(3) not null
    )
  `);

  await connection.query(`
    create table if not exists rules (
      id varchar(191) primary key,
      pack_id varchar(191) not null,
      title text not null,
      body_markdown longtext not null,
      globs_json json not null,
      globs_text text not null,
      search_text longtext not null,
      always_apply boolean not null default false,
      sort_order int not null default 100,
      created_at datetime(3) not null,
      updated_at datetime(3) not null,
      index idx_rules_pack_id (pack_id),
      fulltext index ftx_rules_text (search_text)
    )
  `);

  await connection.query(`
    create table if not exists share_tokens (
      id varchar(191) primary key,
      pack_id varchar(191) not null,
      token varchar(191) not null unique,
      permission varchar(32) not null,
      expires_at datetime(3) null,
      max_uses int null,
      created_at datetime(3) not null,
      index idx_share_pack_id (pack_id)
    )
  `);
}

async function openRemoteConnection(profile: RemoteProfile): Promise<MySqlConn> {
  const connection = await mysql.createConnection({
    uri: baseConnectionString(profile.connectionString),
    ssl: {
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
    },
  });

  await connection.query("create database if not exists persistent_code");
  await connection.query("use persistent_code");
  return connection;
}

function baseConnectionString(connectionString: string): string {
  const url = new URL(connectionString);
  url.pathname = "/";
  return url.toString();
}

function mapRemotePack(row: Record<string, unknown>): StylePack {
  return {
    id: String(row.id),
    name: String(row.name),
    slug: String(row.slug),
    description: String(row.description ?? ""),
    visibility: row.visibility as StylePack["visibility"],
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  };
}

function mapRemoteRule(row: Record<string, unknown>): Rule {
  return {
    id: String(row.id),
    packId: String(row.pack_id),
    title: String(row.title),
    bodyMarkdown: String(row.body_markdown),
    globs: typeof row.globs_json === "string" ? JSON.parse(row.globs_json) : (row.globs_json as string[]),
    alwaysApply: Boolean(row.always_apply),
    sortOrder: Number(row.sort_order),
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  };
}

function buildSearchText(rule: Rule): string {
  return [rule.title, rule.bodyMarkdown, rule.globs.join(" ")].filter(Boolean).join("\n");
}

function mapRemoteShareToken(row: Record<string, unknown>): ShareToken {
  return {
    id: String(row.id),
    packId: String(row.pack_id),
    token: String(row.token),
    permission: row.permission as ShareToken["permission"],
    expiresAt: row.expires_at ? asIso(row.expires_at) : null,
    maxUses: row.max_uses === null || row.max_uses === undefined ? null : Number(row.max_uses),
    createdAt: asIso(row.created_at),
  };
}

function asIso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return new Date(String(value)).toISOString();
}
