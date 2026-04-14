#!/usr/bin/env node
import { Command } from "commander";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
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
  .option("--dry-run", "Show diff without importing")
  .option("--apply", "Apply the imported rules (use with --dry-run output to confirm)")
  .action(async (url, options) => {
    await withStore(program.opts<GlobalOptions>(), async (store) => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch pack JSON from ${url}: ${response.status} ${response.statusText}`);
      }

      const snapshot = (await response.json()) as ExportedPack;

      if (options.dryRun || options.apply) {
        const diff = store.diffImport(snapshot);
        console.log(JSON.stringify(diff, null, 2));
        if (!options.apply) {
          console.log("\n(Dry run — no changes made. Re-run with --apply to import.)");
        } else {
          const imported = store.importPackSnapshot(snapshot, { name: options.name });
          console.log("\n(Imported successfully.)");
          printJson(imported);
        }
        return;
      }

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

// ─── P0: Auto-injection ───────────────────────────────────────────────────

program
  .command("init-cursor")
  .description("Generate a CLAUDE.md in the current directory that instructs AI to load rules before editing.")
  .option("--pack <pack>", "Pack id or slug to reference in the agent instruction")
  .option("--overwrite", "Overwrite existing CLAUDE.md")
  .action(async (options) => {
    await withStore(program.opts<GlobalOptions>(), async (store) => {
      const claudeMdPath = path.resolve("CLAUDE.md");
      const fs = await import("node:fs/promises");
      let existing = false;
      try {
        await fs.access(claudeMdPath);
        existing = true;
      } catch { /* ok */ }

      if (existing && !options.overwrite) {
        console.error("CLAUDE.md already exists. Use --overwrite to replace it.");
        process.exitCode = 1;
        return;
      }

      const packs = store.listPacks();
      const packLines = packs.map((p) => `  - **${p.name}** (slug: \`${p.slug}\`) — ${p.description || `${p.ruleCount} rule(s)`}`).join("\n");

      const content = `# Persistent Code — Agent Instructions

This project uses [Persistent Code](https://github.com/madebyaris/presistent-code) to store coding standards.

## Before you edit any file

You MUST load the applicable rules for the file you are about to edit:

1. Call the \`get_rules_for_glob\` MCP tool with the file path you are editing.
2. Call the \`list_style_packs\` MCP tool to see all available packs.
3. Read the rule bodies carefully — they encode the coding standards for this project.
4. Apply those standards in your edits. Do not contradict them.

## Available style packs

${packs.length > 0 ? packLines : "  _(no packs created yet — run \`persistent-code pack create\` to get started)_"}

## How to add or update rules

- Use \`persistent-code rule upsert <pack-slug> "<title>" --body "<markdown>"\` via the CLI.
- Or call the \`upsert_rule\` MCP tool.

## For more info

See: https://github.com/madebyaris/presistent-code
`;
      await fs.writeFile(claudeMdPath, content, "utf8");
      printJson({ written: claudeMdPath, packCount: packs.length });
    });
  });

program
  .command("generate-cursor-rules")
  .description("Export all rules as .mdc files to .cursor/rules/ in the current project.")
  .option("--pack <pack>", "Limit to a specific pack")
  .option("--dir <dir>", "Output directory", ".cursor/rules")
  .option("--watch", "Watch for changes and re-export (dev mode)")
  .action(async (options) => {
    await withStore(program.opts<GlobalOptions>(), async (store) => {
      const outDir = path.resolve(options.dir);
      await mkdir(outDir, { recursive: true });

      const packs = options.pack ? [store.requirePack(options.pack)] : store.listPacks().map((p) => store.requirePack(p.id));

      const allFiles: string[] = [];
      for (const pack of packs) {
        const files = await store.exportPackAsMdc(pack.id, outDir);
        allFiles.push(...files);
      }

      printJson({ outDir, files: allFiles, packCount: packs.length, ruleCount: allFiles.length });
    });
  });

// ─── P1: Lint ─────────────────────────────────────────────────────────────

program
  .command("lint")
  .description("Audit the rule store for issues: orphan rules, overlapping globs, contradictions.")
  .option("--pack <pack>", "Limit lint to a specific pack")
  .option("--codebase <path>", "Path to a codebase to cross-check glob coverage")
  .action(async (options) => {
    await withStore(program.opts<GlobalOptions>(), async (store) => {
      let codebasePaths: string[] | undefined;
      if (options.codebase) {
        codebasePaths = await collectCodebasePaths(options.codebase);
      }
      const result = store.lint(codebasePaths);
      console.log(JSON.stringify(result, null, 2));
    });
  });

// ─── P3: Explain ───────────────────────────────────────────────────────────

program
  .command("explain")
  .argument("<path>", "Path to explain rules for")
  .option("--pack <pack>", "Limit to a specific pack")
  .action(async (targetPath, options) => {
    await withStore(program.opts<GlobalOptions>(), async (store) => {
      const explanation = store.explainRulesForPath(path.resolve(targetPath), options.pack);
      printJson(explanation);
    });
  });

// ─── P4 & P5: Stats + Digest ───────────────────────────────────────────────

program
  .command("stats")
  .description("Show quick statistics about the rule store.")
  .action(async () => {
    await withStore(program.opts<GlobalOptions>(), async (store) => {
      printJson(store.getStats());
    });
  });

program
  .command("digest")
  .description("Generate a human-readable health and activity report for the rule store.")
  .option("--codebase <path>", "Path to a codebase to cross-check glob coverage")
  .option("--out <file>", "Write report to a file instead of stdout")
  .action(async (options) => {
    await withStore(program.opts<GlobalOptions>(), async (store) => {
      let codebasePaths: string[] | undefined;
      if (options.codebase) {
        codebasePaths = await collectCodebasePaths(options.codebase);
      }
      const report = store.getDigestReport(codebasePaths);
      const output = JSON.stringify(report, null, 2);

      if (options.out) {
        await writeFile(path.resolve(options.out), output, "utf8");
        printJson({ written: options.out, healthScore: report.healthScore });
      } else {
        console.log(output);
      }
    });
  });

// ─── Activity commands ─────────────────────────────────────────────────────

program
  .command("activity")
  .description("Show rule usage activity.")
  .option("--rule <ruleId>", "Filter to a specific rule")
  .option("--limit <n>", "Max entries to show", parseInt, 50)
  .option("--since <iso>", "Only show entries after this ISO date")
  .action(async (options) => {
    await withStore(program.opts<GlobalOptions>(), async (store) => {
      printJson(store.getRuleActivity(options.rule, { limit: options.limit, since: options.since }));
    });
  });

// ─── P6: Store CLAUDE.md ─────────────────────────────────────────────────

program
  .command("generate-store-md")
  .description("Generate a CLAUDE.md inside the store directory documenting all packs and rules.")
  .option("--out <path>", "Override output path")
  .action(async (options) => {
    await withStore(program.opts<GlobalOptions>(), async (store) => {
      const written = await store.generateStoreClaudeMd(options.out);
      printJson({ written });
    });
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

async function collectCodebasePaths(rootPath: string): Promise<string[]> {
  const paths: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".git" || entry === "dist" || entry === "coverage") continue;
      const full = path.join(dir, entry);
      try {
        const s = await stat(full);
        if (s.isDirectory()) {
          await walk(full);
        } else if (s.isFile()) {
          paths.push(full);
        }
      } catch { /* skip */ }
    }
  }

  await walk(path.resolve(rootPath));
  return paths;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
