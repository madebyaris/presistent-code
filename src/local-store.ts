import Database from "better-sqlite3";
import { minimatch } from "minimatch";
import path from "node:path";
import { writeFile } from "node:fs/promises";

import type {
  CreatePackInput,
  CreateShareTokenInput,
  DigestReport,
  ExportedPack,
  ImportConflict,
  ImportDiff,
  ImportDiffPack,
  ImportSuggestion,
  LintIssue,
  LintResult,
  LintSummary,
  RemoteProfile,
  ResolvedRule,
  ResolvedRuleExplanation,
  Rule,
  RuleActivityEntry,
  RuleActivitySummary,
  RuleExplanation,
  SearchResult,
  ShareToken,
  StoreMetadata,
  StoreStats,
  StylePack,
  StylePackSummary,
  SyncOptions,
  UpsertRuleInput,
} from "./types.js";
import {
  APP_VERSION,
  DB_FILENAME,
  METADATA_FILENAME,
  SCHEMA_VERSION,
  defaultStoreDir,
  ensureDir,
  makeId,
  nowIso,
  readJsonFile,
  slugify,
  writeJsonAtomic,
  yamlString,
} from "./utils.js";

type PackRow = {
  id: string;
  name: string;
  slug: string;
  description: string;
  visibility: StylePack["visibility"];
  created_at: string;
  updated_at: string;
  rule_count?: number;
};

type RuleRow = {
  id: string;
  pack_id: string;
  title: string;
  body_markdown: string;
  globs_json: string;
  always_apply: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
  score?: number;
};

type ShareTokenRow = {
  id: string;
  pack_id: string;
  token: string;
  permission: ShareToken["permission"];
  expires_at: string | null;
  max_uses: number | null;
  created_at: string;
};

export class LocalStore {
  readonly storeDir: string;
  readonly dbPath: string;
  readonly metadataPath: string;

  #db: Database.Database;
  #metadata: StoreMetadata;

  private constructor(storeDir: string, db: Database.Database, metadata: StoreMetadata) {
    this.storeDir = storeDir;
    this.dbPath = path.join(storeDir, DB_FILENAME);
    this.metadataPath = path.join(storeDir, METADATA_FILENAME);
    this.#db = db;
    this.#metadata = metadata;
  }

  static async open(storeDir = defaultStoreDir()): Promise<LocalStore> {
    await ensureDir(storeDir);

    const metadataPath = path.join(storeDir, METADATA_FILENAME);
    const metadata = await readJsonFile<StoreMetadata>(metadataPath, {
      schemaVersion: SCHEMA_VERSION,
      appVersion: APP_VERSION,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      remotes: {},
    });

    const dbPath = path.join(storeDir, DB_FILENAME);
    const db = new Database(dbPath);
    const store = new LocalStore(storeDir, db, metadata);
    store.initializeSchema();
    await store.saveMetadata();
    return store;
  }

  close(): void {
    this.#db.close();
  }

  getMetadata(): StoreMetadata {
    return structuredClone(this.#metadata);
  }

  async setDefaultRemoteProfile(profile: RemoteProfile): Promise<void> {
    this.#metadata.remotes[profile.name] = profile;
    this.#metadata.defaultRemoteProfile = profile.name;
    this.#metadata.updatedAt = nowIso();
    await this.saveMetadata();
  }

  async updateRemoteProfile(name: string, updates: Partial<RemoteProfile>): Promise<RemoteProfile> {
    const existing = this.#metadata.remotes[name];
    if (!existing) {
      throw new Error(`Remote profile "${name}" not found.`);
    }

    const next = { ...existing, ...updates, name };
    this.#metadata.remotes[name] = next;
    this.#metadata.updatedAt = nowIso();
    await this.saveMetadata();
    return next;
  }

  getRemoteProfile(name?: string): RemoteProfile {
    const profileName = name ?? this.#metadata.defaultRemoteProfile;
    if (!profileName) {
      throw new Error("No remote profile configured. Run `persistent-code remote set-default` first.");
    }

    const profile = this.#metadata.remotes[profileName];
    if (!profile) {
      throw new Error(`Remote profile "${profileName}" not found.`);
    }

    return profile;
  }

  listPacks(): StylePackSummary[] {
    const rows = this.#db
      .prepare(
        `select p.*, count(r.id) as rule_count
         from packs p
         left join rules r on r.pack_id = p.id
         group by p.id
         order by p.updated_at desc`,
      )
      .all() as PackRow[];

    return rows.map((row) => ({
      ...this.mapPack(row),
      ruleCount: Number(row.rule_count ?? 0),
    }));
  }

  getPack(identifier: string): StylePack | null {
    const row = this.#db
      .prepare("select * from packs where id = ? or slug = ? limit 1")
      .get(identifier, identifier) as PackRow | undefined;

    return row ? this.mapPack(row) : null;
  }

  createPack(input: CreatePackInput): StylePack {
    const createdAt = nowIso();
    const slugBase = input.slug ? slugify(input.slug) : slugify(input.name);
    const slug = this.uniquePackSlug(slugBase);
    const pack: StylePack = {
      id: makeId("pack"),
      name: input.name.trim(),
      slug,
      description: input.description?.trim() ?? "",
      visibility: input.visibility ?? "private",
      createdAt,
      updatedAt: createdAt,
    };

    this.#db
      .prepare(
        `insert into packs (id, name, slug, description, visibility, created_at, updated_at)
         values (@id, @name, @slug, @description, @visibility, @createdAt, @updatedAt)`,
      )
      .run(pack);

    return pack;
  }

  forkPack(sourceIdentifier: string, newName: string): StylePack {
    const snapshot = this.exportPackSnapshot(sourceIdentifier);
    return this.importPackSnapshot(snapshot, { name: newName });
  }

  listRules(packIdentifier: string): Rule[] {
    const pack = this.requirePack(packIdentifier);
    const rows = this.#db
      .prepare("select * from rules where pack_id = ? order by sort_order asc, updated_at desc")
      .all(pack.id) as RuleRow[];

    return rows.map((row) => this.mapRule(row));
  }

  upsertRule(input: UpsertRuleInput): Rule {
    const pack = this.requirePack(input.pack);
    const existing = input.ruleId
      ? ((this.#db.prepare("select * from rules where id = ? limit 1").get(input.ruleId) as RuleRow | undefined) ??
        undefined)
      : ((this.#db
          .prepare("select * from rules where pack_id = ? and title = ? limit 1")
          .get(pack.id, input.title) as RuleRow | undefined) ?? undefined);
    const timestamp = nowIso();

    const globs = [...new Set((input.globs ?? []).map((glob) => glob.trim()).filter(Boolean))];
    const rule: Rule = {
      id: existing?.id ?? input.ruleId ?? makeId("rule"),
      packId: pack.id,
      title: input.title.trim(),
      bodyMarkdown: input.bodyMarkdown.trim(),
      globs,
      alwaysApply: input.alwaysApply ?? Boolean(existing?.always_apply),
      sortOrder: input.sortOrder ?? existing?.sort_order ?? 100,
      createdAt: existing?.created_at ?? timestamp,
      updatedAt: timestamp,
    };

    const transaction = this.#db.transaction(() => {
      if (existing) {
        this.#db
          .prepare(
            `insert into rule_versions (id, rule_id, body_markdown, metadata_json, created_at)
             values (?, ?, ?, ?, ?)`,
          )
          .run(makeId("rv"), existing.id, existing.body_markdown, JSON.stringify({
            title: existing.title,
            globs: JSON.parse(existing.globs_json),
            alwaysApply: Boolean(existing.always_apply),
            sortOrder: existing.sort_order,
          }), timestamp);

        this.#db
          .prepare(
            `update rules
             set title = @title,
                 body_markdown = @bodyMarkdown,
                 globs_json = @globsJson,
                 globs_text = @globsText,
                 always_apply = @alwaysApply,
                 sort_order = @sortOrder,
                 updated_at = @updatedAt
             where id = @id`,
          )
          .run({
            id: rule.id,
            title: rule.title,
            bodyMarkdown: rule.bodyMarkdown,
            globsJson: JSON.stringify(rule.globs),
            globsText: rule.globs.join(" "),
            alwaysApply: rule.alwaysApply ? 1 : 0,
            sortOrder: rule.sortOrder,
            updatedAt: rule.updatedAt,
          });
      } else {
        this.#db
          .prepare(
            `insert into rules
             (id, pack_id, title, body_markdown, globs_json, globs_text, always_apply, sort_order, created_at, updated_at)
             values (@id, @packId, @title, @bodyMarkdown, @globsJson, @globsText, @alwaysApply, @sortOrder, @createdAt, @updatedAt)`,
          )
          .run({
            id: rule.id,
            packId: rule.packId,
            title: rule.title,
            bodyMarkdown: rule.bodyMarkdown,
            globsJson: JSON.stringify(rule.globs),
            globsText: rule.globs.join(" "),
            alwaysApply: rule.alwaysApply ? 1 : 0,
            sortOrder: rule.sortOrder,
            createdAt: rule.createdAt,
            updatedAt: rule.updatedAt,
          });
      }

      this.#db.prepare("delete from rule_search where rule_id = ?").run(rule.id);
      this.#db
        .prepare(
          `insert into rule_search (rule_id, pack_id, title, body_markdown, globs_text)
           values (?, ?, ?, ?, ?)`,
        )
        .run(rule.id, rule.packId, rule.title, rule.bodyMarkdown, rule.globs.join(" "));

      this.#db.prepare("update packs set updated_at = ? where id = ?").run(timestamp, pack.id);
    });

    transaction();
    return rule;
  }

  getRulesForGlob(targetPath: string, packIdentifier?: string): ResolvedRule[] {
    const rules = packIdentifier ? this.listRules(packIdentifier) : this.listRulesAcrossPacks();

    const matches: ResolvedRule[] = [];

    for (const rule of rules) {
      if (rule.alwaysApply) {
        matches.push({ ...rule, matchedBy: "alwaysApply" });
        this.recordRuleMatch(rule.id, targetPath, "alwaysApply");
        continue;
      }

      if (rule.globs.some((glob) => minimatch(targetPath, glob, { dot: true }))) {
        matches.push({ ...rule, matchedBy: "glob" });
        this.recordRuleMatch(rule.id, targetPath, "glob");
      }
    }

    return matches.sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title));
  }

  searchRules(query: string, options: { pack?: string; limit?: number } = {}): SearchResult[] {
    const limit = options.limit ?? 10;
    const pack = options.pack ? this.requirePack(options.pack) : null;

    try {
      const rows = this.#db
        .prepare(
          `select r.*, bm25(rule_search) as score
           from rule_search
           join rules r on r.id = rule_search.rule_id
           where rule_search match ?
           ${pack ? "and r.pack_id = ?" : ""}
           order by score
           limit ?`,
        )
        .all(...(pack ? [query, pack.id, limit] : [query, limit])) as RuleRow[];

      if (rows.length > 0) {
        return rows.map((row) => ({ ...this.mapRule(row), score: Number(row.score ?? 0) }));
      }
    } catch {
      // Fall back to LIKE below when FTS is unavailable or the query is invalid.
    }

    const like = `%${query}%`;
    const rows = this.#db
      .prepare(
        `select *
         from rules
         where (title like ? or body_markdown like ? or globs_text like ?)
         ${pack ? "and pack_id = ?" : ""}
         order by updated_at desc
         limit ?`,
      )
      .all(...(pack ? [like, like, like, pack.id, limit] : [like, like, like, limit])) as RuleRow[];

    return rows.map((row, index) => ({ ...this.mapRule(row), score: index + 1 }));
  }

  createShareToken(input: CreateShareTokenInput): ShareToken {
    const pack = this.requirePack(input.pack);
    const shareToken: ShareToken = {
      id: makeId("share"),
      packId: pack.id,
      token: makeId("token").replace(/_/g, ""),
      permission: input.permission ?? "read",
      expiresAt: input.expiresAt ?? null,
      maxUses: input.maxUses ?? null,
      createdAt: nowIso(),
    };

    this.#db
      .prepare(
        `insert into share_tokens (id, pack_id, token, permission, expires_at, max_uses, created_at)
         values (@id, @packId, @token, @permission, @expiresAt, @maxUses, @createdAt)`,
      )
      .run(shareToken);

    return shareToken;
  }

  listShareTokens(packIdentifier?: string): ShareToken[] {
    const rows = packIdentifier
      ? (this.#db
          .prepare("select * from share_tokens where pack_id = ? order by created_at desc")
          .all(this.requirePack(packIdentifier).id) as ShareTokenRow[])
      : ((this.#db.prepare("select * from share_tokens order by created_at desc").all() as ShareTokenRow[]) ?? []);

    return rows.map((row) => this.mapShareToken(row));
  }

  getPackByShareToken(token: string): ExportedPack | null {
    const row = this.#db
      .prepare("select * from share_tokens where token = ? limit 1")
      .get(token) as ShareTokenRow | undefined;
    if (!row) {
      return null;
    }

    return this.exportPackSnapshot(row.pack_id);
  }

  exportPackSnapshot(packIdentifier: string): ExportedPack {
    const pack = this.requirePack(packIdentifier);
    return {
      schemaVersion: SCHEMA_VERSION,
      exportedAt: nowIso(),
      pack,
      rules: this.listRules(pack.id),
      shareTokens: this.listShareTokens(pack.id),
    };
  }

  importPackSnapshot(snapshot: ExportedPack, options: { name?: string } = {}): StylePack {
    const timestamp = nowIso();
    const packId = makeId("pack");
    const packName = options.name?.trim() || snapshot.pack.name;
    const pack: StylePack = {
      id: packId,
      name: packName,
      slug: this.uniquePackSlug(slugify(packName)),
      description: snapshot.pack.description,
      visibility: snapshot.pack.visibility,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const tx = this.#db.transaction(() => {
      this.#db
        .prepare(
          `insert into packs (id, name, slug, description, visibility, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          pack.id,
          pack.name,
          pack.slug,
          pack.description,
          pack.visibility,
          pack.createdAt,
          pack.updatedAt,
        );

      for (const sourceRule of snapshot.rules) {
        const rule: Rule = {
          ...sourceRule,
          id: makeId("rule"),
          packId,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        this.#db
          .prepare(
            `insert into rules
             (id, pack_id, title, body_markdown, globs_json, globs_text, always_apply, sort_order, created_at, updated_at)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            rule.id,
            rule.packId,
            rule.title,
            rule.bodyMarkdown,
            JSON.stringify(rule.globs),
            rule.globs.join(" "),
            rule.alwaysApply ? 1 : 0,
            rule.sortOrder,
            rule.createdAt,
            rule.updatedAt,
          );

        this.#db
          .prepare(
            `insert into rule_search (rule_id, pack_id, title, body_markdown, globs_text)
             values (?, ?, ?, ?, ?)`,
          )
          .run(rule.id, rule.packId, rule.title, rule.bodyMarkdown, rule.globs.join(" "));
      }
    });

    tx();
    return pack;
  }

  async exportPackAsMdc(packIdentifier: string, outDir: string): Promise<string[]> {
    await ensureDir(outDir);
    const snapshot = this.exportPackSnapshot(packIdentifier);
    const outputPaths: string[] = [];

    for (const rule of snapshot.rules) {
      const fileName = `${slugify(rule.title)}.mdc`;
      const filePath = path.join(outDir, fileName);
      const frontmatter = [
        "---",
        `description: ${yamlString(rule.title)}`,
        rule.globs.length > 0
          ? rule.globs.length === 1
            ? `globs: ${rule.globs[0]}`
            : `globs:\n${rule.globs.map((glob) => `  - ${glob}`).join("\n")}`
          : "globs: []",
        `alwaysApply: ${rule.alwaysApply ? "true" : "false"}`,
        "---",
        "",
        `# ${rule.title}`,
        "",
        rule.bodyMarkdown,
        "",
      ].join("\n");

      await writeFile(filePath, frontmatter, "utf8");
      outputPaths.push(filePath);
    }

    return outputPaths;
  }

  exportAllData(options: SyncOptions = {}): {
    packs: StylePack[];
    rules: Rule[];
    shareTokens: ShareToken[];
  } {
    const packs = options.pack ? [this.requirePack(options.pack)] : this.listPacks();
    const packIds = new Set(packs.map((pack) => pack.id));
    const rules = packs.flatMap((pack) => this.listRules(pack.id));
    const shareTokens = this.listShareTokens().filter((token) => packIds.has(token.packId));
    return { packs, rules, shareTokens };
  }

  upsertRemoteData(data: { packs: StylePack[]; rules: Rule[]; shareTokens: ShareToken[] }): void {
    const tx = this.#db.transaction(() => {
      for (const pack of data.packs) {
        const existing = this.getPack(pack.id);
        if (!existing || existing.updatedAt <= pack.updatedAt) {
          this.#db
            .prepare(
              `insert into packs (id, name, slug, description, visibility, created_at, updated_at)
               values (?, ?, ?, ?, ?, ?, ?)
               on conflict(id) do update set
                 name = excluded.name,
                 slug = excluded.slug,
                 description = excluded.description,
                 visibility = excluded.visibility,
                 created_at = excluded.created_at,
                 updated_at = excluded.updated_at`,
            )
            .run(
              pack.id,
              pack.name,
              pack.slug,
              pack.description,
              pack.visibility,
              pack.createdAt,
              pack.updatedAt,
            );
        }
      }

      for (const rule of data.rules) {
        const existing = this.#db.prepare("select * from rules where id = ?").get(rule.id) as RuleRow | undefined;
        if (!existing || existing.updated_at <= rule.updatedAt) {
          this.#db
            .prepare(
              `insert into rules
               (id, pack_id, title, body_markdown, globs_json, globs_text, always_apply, sort_order, created_at, updated_at)
               values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               on conflict(id) do update set
                 pack_id = excluded.pack_id,
                 title = excluded.title,
                 body_markdown = excluded.body_markdown,
                 globs_json = excluded.globs_json,
                 globs_text = excluded.globs_text,
                 always_apply = excluded.always_apply,
                 sort_order = excluded.sort_order,
                 created_at = excluded.created_at,
                 updated_at = excluded.updated_at`,
            )
            .run(
              rule.id,
              rule.packId,
              rule.title,
              rule.bodyMarkdown,
              JSON.stringify(rule.globs),
              rule.globs.join(" "),
              rule.alwaysApply ? 1 : 0,
              rule.sortOrder,
              rule.createdAt,
              rule.updatedAt,
            );

          this.#db.prepare("delete from rule_search where rule_id = ?").run(rule.id);
          this.#db
            .prepare(
              `insert into rule_search (rule_id, pack_id, title, body_markdown, globs_text)
               values (?, ?, ?, ?, ?)`,
            )
            .run(rule.id, rule.packId, rule.title, rule.bodyMarkdown, rule.globs.join(" "));
        }
      }

      for (const token of data.shareTokens) {
        this.#db
          .prepare(
            `insert into share_tokens (id, pack_id, token, permission, expires_at, max_uses, created_at)
             values (?, ?, ?, ?, ?, ?, ?)
             on conflict(id) do update set
               pack_id = excluded.pack_id,
               token = excluded.token,
               permission = excluded.permission,
               expires_at = excluded.expires_at,
               max_uses = excluded.max_uses,
               created_at = excluded.created_at`,
          )
          .run(
            token.id,
            token.packId,
            token.token,
            token.permission,
            token.expiresAt,
            token.maxUses,
            token.createdAt,
          );
      }
    });

    tx();
  }

  private initializeSchema(): void {
    this.#db.pragma("journal_mode = wal");
    this.#db.exec(`
      create table if not exists packs (
        id text primary key,
        name text not null,
        slug text not null unique,
        description text not null default '',
        visibility text not null default 'private',
        created_at text not null,
        updated_at text not null
      );

      create table if not exists rules (
        id text primary key,
        pack_id text not null references packs(id) on delete cascade,
        title text not null,
        body_markdown text not null,
        globs_json text not null default '[]',
        globs_text text not null default '',
        always_apply integer not null default 0,
        sort_order integer not null default 100,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists rule_versions (
        id text primary key,
        rule_id text not null references rules(id) on delete cascade,
        body_markdown text not null,
        metadata_json text,
        created_at text not null
      );

      create table if not exists share_tokens (
        id text primary key,
        pack_id text not null references packs(id) on delete cascade,
        token text not null unique,
        permission text not null default 'read',
        expires_at text,
        max_uses integer,
        created_at text not null
      );

      create table if not exists rule_activity (
        id text primary key,
        rule_id text not null references rules(id) on delete cascade,
        matched_path text,
        matched_by text not null,
        occurred_at text not null
      );

      create index if not exists idx_rule_activity_rule_id on rule_activity(rule_id);
      create index if not exists idx_rule_activity_occurred_at on rule_activity(occurred_at);
    `);

    try {
      this.#db.exec(`
        create virtual table if not exists rule_search using fts5(
          rule_id unindexed,
          pack_id unindexed,
          title,
          body_markdown,
          globs_text
        );
      `);
    } catch {
      // Keep the rest of the store functional if SQLite is built without FTS5.
    }
  }

  private listRulesAcrossPacks(): Rule[] {
    const rows = this.#db
      .prepare("select * from rules order by sort_order asc, updated_at desc")
      .all() as RuleRow[];
    return rows.map((row) => this.mapRule(row));
  }

  private uniquePackSlug(slugBase: string): string {
    let next = slugBase;
    let attempt = 2;
    while (this.getPack(next)) {
      next = `${slugBase}-${attempt}`;
      attempt += 1;
    }
    return next;
  }

  requirePack(identifier: string): StylePack {
    const pack = this.getPack(identifier);
    if (!pack) {
      throw new Error(`Pack "${identifier}" not found.`);
    }
    return pack;
  }

  private mapPack(row: PackRow): StylePack {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      visibility: row.visibility,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapRule(row: RuleRow): Rule {
    return {
      id: row.id,
      packId: row.pack_id,
      title: row.title,
      bodyMarkdown: row.body_markdown,
      globs: JSON.parse(row.globs_json) as string[],
      alwaysApply: Boolean(row.always_apply),
      sortOrder: row.sort_order,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapShareToken(row: ShareTokenRow): ShareToken {
    return {
      id: row.id,
      packId: row.pack_id,
      token: row.token,
      permission: row.permission,
      expiresAt: row.expires_at,
      maxUses: row.max_uses,
      createdAt: row.created_at,
    };
  }

  private async saveMetadata(): Promise<void> {
    await writeJsonAtomic(this.metadataPath, this.#metadata);
  }

  // ─── Activity Tracking ──────────────────────────────────────────────────────

  recordRuleMatch(ruleId: string, matchedPath: string | null, matchedBy: "alwaysApply" | "glob"): void {
    const entry: RuleActivityEntry = {
      id: makeId("ra"),
      ruleId,
      matchedPath,
      matchedBy,
      occurredAt: nowIso(),
    };

    this.#db
      .prepare(
        `insert into rule_activity (id, rule_id, matched_path, matched_by, occurred_at)
         values (@id, @ruleId, @matchedPath, @matchedBy, @occurredAt)`,
      )
      .run(entry);
  }

  getRuleActivity(
    ruleId?: string,
    options: { limit?: number; since?: string } = {},
  ): RuleActivityEntry[] {
    const limit = options.limit ?? 100;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (ruleId) {
      conditions.push("rule_id = ?");
      params.push(ruleId);
    }
    if (options.since) {
      conditions.push("occurred_at >= ?");
      params.push(options.since);
    }

    const where = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
    const rows = this.#db
      .prepare(
        `select * from rule_activity ${where}
         order by occurred_at desc
         limit ?`,
      )
      .all(...params, limit) as Array<{
      id: string;
      rule_id: string;
      matched_path: string | null;
      matched_by: string;
      occurred_at: string;
    }>;

    return rows.map(
      (row): RuleActivityEntry => ({
        id: row.id,
        ruleId: row.rule_id,
        matchedPath: row.matched_path,
        matchedBy: row.matched_by as "alwaysApply" | "glob",
        occurredAt: row.occurred_at,
      }),
    );
  }

  getStats(): StoreStats {
    const packs = this.listPacks();
    const packCount = packs.length;
    const ruleCount = this.#db.prepare("select count(*) as cnt from rules").get() as { cnt: number };

    const totalMatches = this.#db
      .prepare("select count(*) as cnt from rule_activity")
      .get() as { cnt: number };

    const rulesWithNoMatches = this.#db
      .prepare(
        `select count(*) as cnt from rules r
         left join rule_activity a on a.rule_id = r.id
         where a.id is null`,
      )
      .get() as { cnt: number };

    return {
      packCount,
      ruleCount: Number(ruleCount.cnt),
      totalMatches: Number(totalMatches.cnt),
      rulesWithNoMatches: Number(rulesWithNoMatches.cnt),
    };
  }

  // ─── Rule Explanation ────────────────────────────────────────────────────────

  explainRulesForPath(targetPath: string, packIdentifier?: string): RuleExplanation {
    const packs = packIdentifier
      ? [this.requirePack(packIdentifier)]
      : this.listPacks().map((p) => this.requirePack(p.id));

    const packSummaries = Object.fromEntries(packs.map((p) => [p.id, p]));

    const matchedRules: ResolvedRule[] = [];
    const alwaysApplyRules: ResolvedRule[] = [];

    for (const pack of packs) {
      const rules = this.listRules(pack.id);
      for (const rule of rules) {
        if (rule.alwaysApply) {
          alwaysApplyRules.push({ ...rule, matchedBy: "alwaysApply", packId: pack.id });
        } else if (rule.globs.some((glob) => minimatch(targetPath, glob, { dot: true }))) {
          matchedRules.push({ ...rule, matchedBy: "glob", packId: pack.id });
        }
      }
    }

    const resolvedMatched = matchedRules
      .sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title))
      .map((rule, idx) => this.#explainResolvedRule(rule, targetPath, idx + 1));

    const resolvedAlways = alwaysApplyRules
      .sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title))
      .map((rule, idx) => this.#explainResolvedRule(rule, targetPath, resolvedMatched.length + idx + 1));

    return {
      path: targetPath,
      pack: { ...Object.values(packSummaries)[0]!, ruleCount: packs.length },
      matchedRules: resolvedMatched,
      alwaysApplyRules: resolvedAlways,
      totalMatched: resolvedMatched.length + resolvedAlways.length,
    };
  }

  #explainResolvedRule(rule: ResolvedRule, targetPath: string, precedence: number): ResolvedRuleExplanation {
    let whyItApplies: string;
    if (rule.matchedBy === "alwaysApply") {
      whyItApplies = "This rule has 'alwaysApply: true' — it applies to every file, regardless of path.";
    } else {
      const matchedGlobs = rule.globs.filter((glob) => minimatch(targetPath, glob, { dot: true }));
      whyItApplies = `The path "${targetPath}" matches the glob pattern(s): ${matchedGlobs.join(", ")}.`;
    }

    return { ...rule, whyItApplies, precedence };
  }

  // ─── Lint ──────────────────────────────────────────────────────────────────

  lint(codebasePaths?: string[]): LintResult {
    const issues: LintIssue[] = [];
    const packs = this.listPacks();
    const allRules = packs.flatMap((p) => this.listRules(p.id));

    const totalPacks = packs.length;
    const totalRules = allRules.length;

    // Orphan rules: rules whose pack has been deleted (already cascade, but check anyway)
    // Stale rules: never matched
    const rulesWithActivity = new Set(
      this.#db
        .prepare("select distinct rule_id from rule_activity")
        .all()
        .map((row: unknown) => (row as { rule_id: string }).rule_id),
    );

    for (const rule of allRules) {
      if (!rulesWithActivity.has(rule.id)) {
        issues.push({
          type: "orphan_rule",
          severity: "info",
          ruleId: rule.id,
          packId: rule.packId,
          message: `Rule "${rule.title}" has never been matched.`,
          details: `Consider removing it if it is no longer relevant, or use it in a project to confirm it works.`,
        });
      }
    }

    // Overlapping globs within the same pack
    const rulesByPack = new Map<string, Rule[]>();
    for (const rule of allRules) {
      if (!rulesByPack.has(rule.packId)) {
        rulesByPack.set(rule.packId, []);
      }
      rulesByPack.get(rule.packId)!.push(rule);
    }

    let overlappingGlobPairs = 0;
    for (const [packId, rules] of rulesByPack) {
      const nonAlwaysRules = rules.filter((r) => !r.alwaysApply);
      for (let i = 0; i < nonAlwaysRules.length; i++) {
        for (let j = i + 1; j < nonAlwaysRules.length; j++) {
          const a = nonAlwaysRules[i]!;
          const b = nonAlwaysRules[j]!;
          const overlap = this.#globsOverlap(a.globs, b.globs);
          if (overlap) {
            overlappingGlobPairs++;
            issues.push({
              type: "overlapping_glob",
              severity: "warning",
              ruleId: a.id,
              packId,
              message: `Rules "${a.title}" and "${b.title}" have overlapping globs.`,
              details: `Both rules could fire for the same files. Consider merging or adjusting their globs.\n  "${a.title}": ${a.globs.join(", ")}\n  "${b.title}": ${b.globs.join(", ")}`,
            });
          }
        }
      }
    }

    // Contradictions: same glob, different body
    for (const [packId, rules] of rulesByPack) {
      const nonAlwaysRules = rules.filter((r) => !r.alwaysApply);
      for (let i = 0; i < nonAlwaysRules.length; i++) {
        for (let j = i + 1; j < nonAlwaysRules.length; j++) {
          const a = nonAlwaysRules[i]!;
          const b = nonAlwaysRules[j]!;
          if (this.#globsOverlap(a.globs, b.globs) && a.bodyMarkdown !== b.bodyMarkdown) {
            issues.push({
              type: "contradiction",
              severity: "error",
              ruleId: a.id,
              packId,
              message: `Rules "${a.title}" and "${b.title}" apply to overlapping files but have different guidance.`,
              details: `These rules both match the same files but say different things. Resolve the contradiction by merging or clarifying their scopes.\n  "${a.title}": ${a.bodyMarkdown.slice(0, 80)}...\n  "${b.title}": ${b.bodyMarkdown.slice(0, 80)}...`,
            });
          }
        }
      }
    }

    // Unused packs: packs with zero rules
    const unusedPacks = packs.filter((p) => p.ruleCount === 0);
    for (const pack of unusedPacks) {
      issues.push({
        type: "unused_pack",
        severity: "info",
        packId: pack.id,
        message: `Pack "${pack.name}" has no rules.`,
        details: "Consider adding rules or removing this empty pack.",
      });
    }

    // Cross-check against real codebase paths if provided
    if (codebasePaths && codebasePaths.length > 0) {
      for (const rule of allRules) {
        if (rule.alwaysApply) continue;
        const matchesAny = rule.globs.some((glob) =>
          codebasePaths.some((p) => minimatch(p, glob, { dot: true })),
        );
        if (!matchesAny) {
          issues.push({
            type: "orphan_rule",
            severity: "warning",
            ruleId: rule.id,
            packId: rule.packId,
            message: `Rule "${rule.title}" has globs that match no files in the provided codebase paths.`,
            details: `Globs: ${rule.globs.join(", ")}\nCodebase paths checked: ${codebasePaths.length} files/dirs.`,
          });
        }
      }
    }

    const summary: LintSummary = {
      totalRules,
      totalPacks,
      orphanRules: issues.filter((i) => i.type === "orphan_rule").length,
      overlappingGlobPairs,
      contradictions: issues.filter((i) => i.type === "contradiction").length,
      staleRules: issues.filter((i) => i.type === "stale_rule").length,
      unusedPacks: unusedPacks.length,
    };

    return { issues, summary };
  }

  #globsOverlap(a: string[], b: string[]): boolean {
    if (a.length === 0 || b.length === 0) return false;
    // Check if any file matching A could match B (conservative check)
    // For simplicity: check if any glob pattern string is shared
    const intersection = a.filter((ga) => b.some((gb) => ga === gb));
    if (intersection.length > 0) return true;
    // Heuristic: check prefix overlap (e.g. src/**/*.ts vs src/components/*.ts)
    return a.some((ga) => b.some((gb) => ga.startsWith(gb.slice(0, ga.indexOf("*"))) || gb.startsWith(ga.slice(0, gb.indexOf("*")))));
  }

  // ─── Import Diff ───────────────────────────────────────────────────────────

  diffImport(snapshot: ExportedPack): ImportDiff {
    const conflicts: ImportConflict[] = [];
    const suggestions: ImportSuggestion[] = [];
    const newRules: Rule[] = [];
    const updatedRules: Array<{ local: Rule; remote: Rule }> = [];
    const unchangedRules: Rule[] = [];

    const localPack = this.getPack(snapshot.pack.slug);

    if (!localPack) {
      const packAction: ImportDiffPack = {
        name: snapshot.pack.name,
        action: "create",
        remoteVersion: snapshot.pack,
      };

      for (const rule of snapshot.rules) {
        newRules.push(rule);
        suggestions.push({
          type: "replace",
          ruleId: rule.id,
          ruleTitle: rule.title,
          reason: `New rule from imported pack "${snapshot.pack.name}".`,
        });
      }

      return { packs: [packAction], newRules, updatedRules, unchangedRules, conflicts, suggestions };
    }

    const packAction: ImportDiffPack = {
      name: snapshot.pack.name,
      action: localPack ? "skip" : "create",
      localVersion: localPack ?? undefined,
      remoteVersion: snapshot.pack,
    };

    const localRules = new Map(this.listRules(localPack.id).map((r) => [r.title, r]));

    for (const remoteRule of snapshot.rules) {
      const localRule = localRules.get(remoteRule.title);
      if (!localRule) {
        newRules.push(remoteRule);
        suggestions.push({
          type: "replace",
          ruleId: remoteRule.id,
          ruleTitle: remoteRule.title,
          reason: `New rule from imported pack.`,
        });
      } else if (localRule.bodyMarkdown !== remoteRule.bodyMarkdown || JSON.stringify(localRule.globs) !== JSON.stringify(remoteRule.globs)) {
        updatedRules.push({ local: localRule, remote: remoteRule });

        const hasConflict =
          localRule.bodyMarkdown !== remoteRule.bodyMarkdown &&
          localRule.globs.some((g) => remoteRule.globs.includes(g));

        if (hasConflict) {
          conflicts.push({
            localRule,
            remoteRule,
            field: "bodyMarkdown",
            localValue: localRule.bodyMarkdown,
            remoteValue: remoteRule.bodyMarkdown,
          });
          suggestions.push({
            type: "merge",
            ruleId: localRule.id,
            ruleTitle: localRule.title,
            reason: `Conflict detected: local and remote versions differ on "${remoteRule.title}". Review and decide which to keep.`,
          });
        } else {
          suggestions.push({
            type: "replace",
            ruleId: localRule.id,
            ruleTitle: localRule.title,
            reason: `Remote version of "${remoteRule.title}" has updates.`,
          });
        }
      } else {
        unchangedRules.push(remoteRule);
      }
    }

    return {
      packs: [packAction],
      newRules,
      updatedRules,
      unchangedRules,
      conflicts,
      suggestions,
    };
  }

  // ─── Digest Report ────────────────────────────────────────────────────────

  getDigestReport(codebasePaths?: string[]): DigestReport {
    const stats = this.getStats();
    const packs = this.listPacks();
    const allRules = this.listRulesAcrossPacks();
    const now = nowIso();

    // Get match counts per rule
    const matchCounts = new Map<string, number>();
    const lastMatch = new Map<string, { at: string; path: string | null }>();

    const activityRows = this.#db
      .prepare(
        `select rule_id, count(*) as cnt, max(occurred_at) as last_at, max(matched_path) as last_path
         from rule_activity
         group by rule_id`,
      )
      .all() as Array<{ rule_id: string; cnt: number; last_at: string; last_path: string | null }>;

    for (const row of activityRows) {
      matchCounts.set(row.rule_id, Number(row.cnt));
      lastMatch.set(row.rule_id, { at: row.last_at, path: row.last_path });
    }

    const packNames = new Map(packs.map((p) => [p.id, p.name]));
    const ruleSummaries: RuleActivitySummary[] = allRules.map((rule) => ({
      ruleId: rule.id,
      title: rule.title,
      packName: packNames.get(rule.packId) ?? "unknown",
      matchCount: matchCounts.get(rule.id) ?? 0,
      lastMatchedAt: lastMatch.get(rule.id)?.at ?? null,
      lastMatchedPath: lastMatch.get(rule.id)?.path ?? null,
    }));

    const sortedByMatches = [...ruleSummaries].sort((a, b) => b.matchCount - a.matchCount);
    const withMatches = sortedByMatches.filter((r) => r.matchCount > 0);
    const noMatches = sortedByMatches.filter((r) => r.matchCount === 0);

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const recentlyActive = ruleSummaries
      .filter((r) => r.lastMatchedAt && r.lastMatchedAt >= thirtyDaysAgo)
      .sort((a, b) => b.lastMatchedAt!.localeCompare(a.lastMatchedAt!));

    const stale = ruleSummaries.filter((r) => r.matchCount === 0).slice(0, 10);

    // Run lint to get fresh issues for health score
    const { issues } = this.lint(codebasePaths);
    const healthScore = this.#calculateHealthScore(stats, issues, sortedByMatches.length);

    return {
      generatedAt: now,
      storeDir: this.storeDir,
      packCount: stats.packCount,
      ruleCount: stats.ruleCount,
      totalRuleMatches: stats.totalMatches,
      mostMatchedRules: sortedByMatches.slice(0, 5),
      leastMatchedRules: withMatches.slice(-5).reverse(),
      rulesWithNoMatches: noMatches.map((r) => r.title),
      recentlyActiveRules: recentlyActive.slice(0, 5),
      staleRules: stale,
      healthScore,
    };
  }

  #calculateHealthScore(stats: StoreStats, issues: LintIssue[], activeRuleCount: number): number {
    let score = 100;
    score -= Math.min(stats.rulesWithNoMatches * 2, 30);
    score -= issues.filter((i) => i.type === "contradiction").length * 10;
    score -= issues.filter((i) => i.type === "overlapping_glob").length * 3;
    score -= issues.filter((i) => i.type === "unused_pack").length * 5;
    return Math.max(0, Math.min(100, score));
  }

  // ─── P6: Store CLAUDE.md ────────────────────────────────────────────────

  async generateStoreClaudeMd(outPath?: string): Promise<string> {
    const packs = this.listPacks();
    const filePath = outPath ?? path.join(this.storeDir, "CLAUDE.md");

    const packBlocks = packs
      .map((p) => {
        const rules = this.listRules(p.id);
        const ruleLines = rules
          .map(
            (r) =>
              `- **${r.title}**${r.alwaysApply ? " _(alwaysApply)_" : ""} — \`${r.globs.join(", ") || "(no globs)"}` +
              `\n  ${r.bodyMarkdown.slice(0, 120)}${r.bodyMarkdown.length > 120 ? "..." : ""}`,
          )
          .join("\n");
        return `### ${p.name} (\`${p.slug}\`)\n\n${ruleLines || "_no rules yet_"}`;
      })
      .join("\n\n");

    const content = `# Persistent Code Store — ${this.storeDir}

This directory is managed by [Persistent Code](https://github.com/madebyaris/presistent-code).
Do not edit the database files directly. Use the CLI or MCP tools to modify rules and packs.

## Style Packs

${packs.length > 0 ? packBlocks : "_No packs created yet. Run \`persistent-code pack create\` to get started._"}

## MCP Tools

This store is exposed via MCP. Available tools:

| Tool | Description |
|------|-------------|
| \`list_style_packs\` | List all packs with rule counts |
| \`get_rules_for_glob\` | Get rules matching a file path |
| \`search_rules\` | Full-text search across rules |
| \`upsert_rule\` | Create or update a rule |
| \`export_pack\` | Export a pack as JSON |
| \`explain_rules_for_path\` | Explain why rules apply to a file |
| \`lint_rules\` | Audit the store for issues |
| \`get_rule_activity\` | View rule usage history |
| \`get_digest_report\` | Health and activity digest |

## Schema

- **packs**: named collections of rules (e.g. "Team Defaults", "Frontend Guide")
- **rules**: individual coding standards with glob patterns and alwaysApply flag
- **rule_activity**: tracks which rules have fired (for health scoring)
- **share_tokens**: for sharing packs via tokens

## Conventions for Writing Rules

1. **Title**: Be specific. "TypeScript: prefer explicit return types" not "TS imports"
2. **Globs**: Use relative paths from project root, e.g. \`src/**/*.ts\`, not \`./src\`
3. **Body**: Start with the rule itself (e.g. "Do X"), then explain WHY in a second paragraph
4. **alwaysApply**: Only use for truly universal rules (e.g. "never use \`any\`")
5. **Sort order**: Lower numbers = higher priority. 1-10 for critical rules, 100+ for niche ones
`;
    await writeFile(filePath, content, "utf8");
    return filePath;
  }
}
