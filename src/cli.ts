#!/usr/bin/env node
import { Command } from "commander";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { LocalStore } from "./local-store.js";
import { runMcpServer } from "./mcp.js";
import { provisionTiDbZero, pullRemoteIntoStore, pushLocalStore, renewTiDbFromLocal, resolveShareTokenFromRemote, searchRemoteRules } from "./tidb.js";
import type { ExportedPack } from "./types.js";
import { APP_NAME, defaultStoreDir } from "./utils.js";

type GlobalOptions = { store?: string };

const program = new Command();

program
  .name("persistent-code")
  .description("Persistent code style packs for MCP-enabled IDEs and CLI workflows.")
  .option("--store <path>", "Override the machine-wide store path.");

program
  .command("init")
  .description("Initialize the local store and print the resolved paths.")
  .action(async () => {
    await withStore(program.opts<GlobalOptions>(), async (store) => {
      const metadata = store.getMetadata();
      console.log(
        JSON.stringify(
          {
            app: APP_NAME,
            storeDir: store.storeDir,
            dbPath: store.dbPath,
            metadataPath: store.metadataPath,
            defaultRemoteProfile: metadata.defaultRemoteProfile ?? null,
          },
          null,
          2,
        ),
      );
    });
  });

const pack = program.command("pack").description("Create, list, and fork style packs.");

pack
  .command("create")
  .argument("<name>", "Pack name")
  .option("--slug <slug>", "Explicit slug")
  .option("--description <description>", "Pack description")
  .option("--visibility <visibility>", "private | link | public", "private")
  .action(async (name, options) => {
    await withStore(program.opts<GlobalOptions>(), async (store) => {
      const created = store.createPack({
        name,
        slug: options.slug,
        description: options.description,
        visibility: options.visibility,
      });
      printJson(created);
    });
  });

pack.command("list").action(async () => {
  await withStore(program.opts<GlobalOptions>(), async (store) => {
    printJson(store.listPacks());
  });
});

pack
  .command("fork")
  .argument("<source>", "Source pack id or slug")
  .argument("<name>", "New pack name")
  .action(async (source, name) => {
    await withStore(program.opts<GlobalOptions>(), async (store) => {
      printJson(store.forkPack(source, name));
    });
  });

const rule = program.command("rule").description("Manage rules inside a style pack.");

rule
  .command("upsert")
  .argument("<pack>", "Pack id or slug")
  .argument("<title>", "Rule title")
  .requiredOption("--body <body>", "Rule body markdown")
  .option("--globs <glob...>", "One or more glob patterns")
  .option("--always-apply", "Apply regardless of file path")
  .option("--sort-order <number>", "Sorting priority", parseInt)
  .option("--id <ruleId>", "Update a specific rule id")
  .action(async (packId, title, options) => {
    await withStore(program.opts<GlobalOptions>(), async (store) => {
      const updated = store.upsertRule({
        pack: packId,
        ruleId: options.id,
        title,
        bodyMarkdown: options.body,
        globs: options.globs,
        alwaysApply: options.alwaysApply,
        sortOrder: options.sortOrder,
      });
      printJson(updated);
    });
  });

rule.command("list").argument("<pack>", "Pack id or slug").action(async (packId) => {
  await withStore(program.opts<GlobalOptions>(), async (store) => {
    printJson(store.listRules(packId));
  });
});

program
  .command("rules-for-glob")
  .argument("<targetPath>", "Path or glob to match against stored rules")
  .option("--pack <pack>", "Limit matching to a pack")
  .action(async (targetPath, options) => {
    await withStore(program.opts<GlobalOptions>(), async (store) => {
      printJson(store.getRulesForGlob(targetPath, options.pack));
    });
  });

program
  .command("search")
  .argument("<query>", "Search query")
  .option("--pack <pack>", "Limit to a pack")
  .option("--limit <number>", "Maximum results", parseInt, 10)
  .option("--remote", "Search the configured TiDB remote instead of local SQLite")
  .action(async (query, options) => {
    await withStore(program.opts<GlobalOptions>(), async (store) => {
      const results = options.remote
        ? await searchRemoteRules(store, query, { pack: options.pack, limit: options.limit })
        : store.searchRules(query, { pack: options.pack, limit: options.limit });
      printJson(results);
    });
  });

program
  .command("export")
  .argument("<pack>", "Pack id or slug")
  .option("--format <format>", "json | mdc", "json")
  .option("--out <path>", "Output file or directory")
  .action(async (packId, options) => {
    await withStore(program.opts<GlobalOptions>(), async (store) => {
      if (options.format === "mdc") {
        const outDir = path.resolve(options.out ?? path.join(process.cwd(), ".cursor", "rules"));
        await mkdir(outDir, { recursive: true });
        const files = await store.exportPackAsMdc(packId, outDir);
        printJson({ outDir, files });
        return;
      }

      const snapshot = store.exportPackSnapshot(packId);
      if (options.out) {
        await writeFile(path.resolve(options.out), JSON.stringify(snapshot, null, 2), "utf8");
        printJson({ written: path.resolve(options.out) });
        return;
      }

      printJson(snapshot);
    });
  });

program
  .command("import-url")
  .argument("<url>", "URL serving an exported pack JSON document")
  .option("--name <name>", "Override the imported pack name")
  .action(async (url, options) => {
    await withStore(program.opts<GlobalOptions>(), async (store) => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch pack JSON from ${url}: ${response.status} ${response.statusText}`);
      }

      const snapshot = (await response.json()) as ExportedPack;
      printJson(store.importPackSnapshot(snapshot, { name: options.name }));
    });
  });

const share = program.command("share").description("Share local packs through local tokens or a synced TiDB remote.");

share
  .command("create")
  .argument("<pack>", "Pack id or slug")
  .option("--permission <permission>", "read | fork", "read")
  .option("--expires-at <iso>", "Optional expiry timestamp")
  .option("--max-uses <number>", "Optional maximum uses", parseInt)
  .action(async (packId, options) => {
    await withStore(program.opts<GlobalOptions>(), async (store) => {
      printJson(
        store.createShareToken({
          pack: packId,
          permission: options.permission,
          expiresAt: options.expiresAt,
          maxUses: options.maxUses,
        }),
      );
    });
  });

share.command("list").option("--pack <pack>", "Limit tokens to one pack").action(async (options) => {
  await withStore(program.opts<GlobalOptions>(), async (store) => {
    printJson(store.listShareTokens(options.pack));
  });
});

share
  .command("import")
  .argument("<token>", "Remote share token")
  .option("--name <name>", "Override the imported pack name")
  .action(async (token, options) => {
    await withStore(program.opts<GlobalOptions>(), async (store) => {
      printJson(await resolveShareTokenFromRemote(store, token, { name: options.name }));
    });
  });

const remote = program.command("remote").description("Configure the TiDB remote profile stored on disk.");

remote
  .command("set-default")
  .requiredOption("--connection-string <uri>", "TiDB/MySQL connection string")
  .option("--instance-id <id>", "TiDB Zero instance id")
  .option("--expires-at <iso>", "Instance expiry time")
  .option("--name <name>", "Remote profile name", "default")
  .action(async (options) => {
    await withStore(program.opts<GlobalOptions>(), async (store) => {
      await store.setDefaultRemoteProfile({
        name: options.name,
        kind: "tidb-zero",
        connectionString: options.connectionString,
        instanceId: options.instanceId,
        expiresAt: options.expiresAt,
      });
      printJson(store.getMetadata());
    });
  });

const tidb = program.command("tidb").description("Provision and rotate TiDB Cloud Zero instances.");

tidb
  .command("provision")
  .option("--tag <tag>", "Tag to send to the Zero API", APP_NAME)
  .option("--name <name>", "Remote profile name", "default")
  .action(async (options) => {
    await withStore(program.opts<GlobalOptions>(), async (store) => {
      const remoteProfile = await provisionTiDbZero(options.tag);
      remoteProfile.name = options.name;
      await store.setDefaultRemoteProfile(remoteProfile);
      printJson(remoteProfile);
    });
  });

program.command("sync").description("Push local packs to TiDB or pull them back.").argument("<direction>", "push | pull").action(
  async (direction: string) => {
    await withStore(program.opts<GlobalOptions>(), async (store) => {
      if (direction === "push") {
        await pushLocalStore(store);
      } else if (direction === "pull") {
        await pullRemoteIntoStore(store);
      } else {
        throw new Error(`Unknown sync direction "${direction}". Use "push" or "pull".`);
      }

      printJson({
        direction,
        remote: store.getMetadata().defaultRemoteProfile,
        at: new Date().toISOString(),
      });
    });
  },
);

program.command("doctor").description("Inspect store health and warn about TiDB expiry.").action(async () => {
  await withStore(program.opts<GlobalOptions>(), async (store) => {
    const metadata = store.getMetadata();
    const remote = metadata.defaultRemoteProfile ? metadata.remotes[metadata.defaultRemoteProfile] : null;
    const expiresAt = remote?.expiresAt ? new Date(remote.expiresAt) : null;
    const msRemaining = expiresAt ? expiresAt.getTime() - Date.now() : null;
    const daysRemaining = msRemaining === null ? null : Math.floor(msRemaining / (1000 * 60 * 60 * 24));

    printJson({
      app: APP_NAME,
      storeDir: store.storeDir,
      dbPath: store.dbPath,
      packCount: store.listPacks().length,
      defaultRemoteProfile: metadata.defaultRemoteProfile ?? null,
      remoteExpiry: remote?.expiresAt ?? null,
      remoteDaysRemaining: daysRemaining,
      remoteNeedsRotation: typeof daysRemaining === "number" ? daysRemaining <= 3 : false,
    });
  });
});

program.command("renew-tidb").description("Provision a new TiDB Zero instance and repush local data to it.").action(
  async () => {
    await withStore(program.opts<GlobalOptions>(), async (store) => {
      printJson(await renewTiDbFromLocal(store));
    });
  },
);

program
  .command("mcp-stdio")
  .description("Run the MCP server over stdio for Cursor, Windsurf, and other MCP hosts.")
  .action(async () => {
    await runMcpServer(program.opts<GlobalOptions>().store ?? defaultStoreDir());
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function withStore(
  options: GlobalOptions,
  fn: (store: LocalStore) => Promise<void>,
): Promise<void> {
  const store = await LocalStore.open(options.store ?? defaultStoreDir());
  try {
    await fn(store);
  } finally {
    store.close();
  }
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
