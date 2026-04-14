import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { LocalStore } from "./local-store.js";
import { searchRemoteRules } from "./tidb.js";
import { defaultStoreDir } from "./utils.js";
import type { ExportedPack, Rule, RuleExplanation } from "./types.js";

export async function runMcpServer(storePath = defaultStoreDir()): Promise<void> {
  const store = await LocalStore.open(storePath);
  const server = new McpServer({
    name: "persistent-code",
    version: "0.1.0",
  });

  server.registerResource(
    "store-metadata",
    "persistent-code://metadata",
    {
      title: "Persistent Code Metadata",
      description: "Store metadata, paths, and remote configuration.",
      mimeType: "application/json",
    },
    async () => ({
      contents: [
        {
          uri: "persistent-code://metadata",
          mimeType: "application/json",
          text: JSON.stringify(
            {
              storeDir: store.storeDir,
              dbPath: store.dbPath,
              metadata: store.getMetadata(),
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.registerTool(
    "list_style_packs",
    {
      title: "List Style Packs",
      description: "List every locally stored style pack with rule counts.",
    },
    async () => {
      const packs = store.listPacks();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(packs, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_rules_for_glob",
    {
      title: "Get Rules For Glob",
      description: "Return all always-apply and glob-matching rules for a target path.",
      inputSchema: {
        targetPath: z.string().describe("Path or glob to match, for example src/app/page.tsx"),
        pack: z.string().optional().describe("Optional pack id or slug"),
        limit: z.number().int().positive().max(50).optional().describe("Maximum number of rules to return"),
      },
    },
    async ({ targetPath, pack, limit }) => {
      const matches = store.getRulesForGlob(targetPath, pack).slice(0, limit ?? 25);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(matches, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "search_rules",
    {
      title: "Search Rules",
      description: "Search local rules with SQLite FTS, or the configured TiDB remote when requested.",
      inputSchema: {
        query: z.string().min(1).describe("Full-text query"),
        pack: z.string().optional().describe("Optional pack id or slug"),
        limit: z.number().int().positive().max(50).optional().describe("Maximum results"),
        remote: z.boolean().optional().describe("Search the configured TiDB remote instead of local SQLite"),
      },
    },
    async ({ query, pack, limit, remote }) => {
      const results = remote
        ? await searchRemoteRules(store, query, { pack, limit })
        : store.searchRules(query, { pack, limit });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "upsert_rule",
    {
      title: "Upsert Rule",
      description: "Create or update a rule in the local store.",
      inputSchema: {
        pack: z.string().describe("Pack id or slug"),
        title: z.string().min(1).describe("Rule title"),
        bodyMarkdown: z.string().min(1).describe("Rule body markdown"),
        globs: z.array(z.string()).optional().describe("Optional glob patterns"),
        alwaysApply: z.boolean().optional().describe("Whether to always apply the rule"),
        sortOrder: z.number().int().optional().describe("Lower numbers sort earlier"),
        ruleId: z.string().optional().describe("Existing rule id to update"),
      },
    },
    async (input) => {
      const rule = store.upsertRule(input);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(rule, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "export_pack",
    {
      title: "Export Pack",
      description: "Return a pack as JSON; the CLI can materialize .mdc files on disk.",
      inputSchema: {
        pack: z.string().describe("Pack id or slug"),
      },
    },
    async ({ pack }) => {
      const snapshot = store.exportPackSnapshot(pack);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(snapshot, null, 2),
          },
        ],
      };
    },
  );

  // ─── P0: Preload rules for project ───────────────────────────────────────

  server.registerTool(
    "preload_rules_for_project",
    {
      title: "Preload Rules For Project",
      description:
        "Load all always-apply rules and provide instructions for targeted rule loading. Call this once at the start of a session to prime the context.",
      inputSchema: {
        projectPath: z.string().describe("Absolute path to the project root"),
        pack: z.string().optional().describe("Optional pack id or slug to limit scope"),
      },
    },
    async ({ projectPath, pack }) => {
      const packs2 = pack ? [store.requirePack(pack)] : store.listPacks().map((p) => store.requirePack(p.id));
      const alwaysApplyRules: { rule: Rule; packName: string }[] = [];
      const packRuleCounts: { packName: string; ruleCount: number }[] = [];

      for (const p of packs2) {
        const rules = store.listRules(p.id);
        packRuleCounts.push({ packName: p.name, ruleCount: rules.length });
        for (const rule of rules) {
          if (rule.alwaysApply) {
            alwaysApplyRules.push({ rule, packName: p.name });
          }
        }
      }

      const body = [
        `# Preloaded Rules for ${projectPath}`,
        "",
        "## Always-Apply Rules (active for all files)",
        ...alwaysApplyRules.map(({ rule, packName }) =>
          `### [${packName}] ${rule.title}\n\n${rule.bodyMarkdown}`),
        "",
        "## Targeted Rules",
        "For each file you edit, call `get_rules_for_glob` with the file path to load file-specific rules.",
        "",
        `## Available Packs (${packs2.length})`,
        ...packRuleCounts.map(({ packName, ruleCount }) => `- ${packName}: ${ruleCount} rule(s)`),
      ].join("\n");

      return {
        content: [
          {
            type: "text",
            text: body,
          },
        ],
      };
    },
  );

  // ─── P3: Explain rules ───────────────────────────────────────────────────

  server.registerTool(
    "explain_rules_for_path",
    {
      title: "Explain Rules For Path",
      description: "Return all rules that apply to a given file path, with human-readable explanations of WHY each rule applies.",
      inputSchema: {
        targetPath: z.string().describe("Path to explain rules for"),
        pack: z.string().optional().describe("Optional pack id or slug to limit scope"),
      },
    },
    async ({ targetPath, pack }): Promise<{ content: { type: "text"; text: string }[] }> => {
      const explanation: RuleExplanation = store.explainRulesForPath(targetPath, pack);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(explanation, null, 2),
          },
        ],
      };
    },
  );

  // ─── P1: Lint ────────────────────────────────────────────────────────────

  server.registerTool(
    "lint_rules",
    {
      title: "Lint Rules",
      description: "Audit the rule store for issues: orphan rules, overlapping globs, contradictions, and unused packs.",
      inputSchema: {
        pack: z.string().optional().describe("Optional pack id or slug to limit lint scope"),
      },
    },
    async ({ pack }) => {
      const result = store.lint();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  // ─── P4: Rule activity ──────────────────────────────────────────────────

  server.registerTool(
    "get_rule_activity",
    {
      title: "Get Rule Activity",
      description: "Return recent rule usage activity — how many times each rule has been matched.",
      inputSchema: {
        ruleId: z.string().optional().describe("Optional rule id to filter activity"),
        limit: z.number().int().positive().max(200).optional().default(50).describe("Max entries to return"),
        since: z.string().optional().describe("ISO date string — only return activity after this date"),
      },
    },
    async ({ ruleId, limit, since }) => {
      const activity = store.getRuleActivity(ruleId, { limit, since });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(activity, null, 2),
          },
        ],
      };
    },
  );

  // ─── P5: Digest ────────────────────────────────────────────────────────

  server.registerTool(
    "get_digest_report",
    {
      title: "Get Digest Report",
      description: "Generate a health and activity report for the rule store — most/least used rules, stale rules, and a health score.",
      inputSchema: {
        codebasePath: z.string().optional().describe("Optional project path to cross-check glob coverage"),
      },
    },
    async ({ codebasePath }) => {
      const report = store.getDigestReport();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(report, null, 2),
          },
        ],
      };
    },
  );

  // ─── P2: Import diff ────────────────────────────────────────────────────

  server.registerTool(
    "diff_import",
    {
      title: "Diff Import",
      description: "Preview what would change if you imported an exported pack JSON — without making any changes.",
      inputSchema: {
        packJson: z.string().describe("JSON string of an ExportedPack (same format as export_pack returns)"),
        name: z.string().optional().describe("Override name for the imported pack"),
      },
    },
    async ({ packJson, name }) => {
      const snapshot = JSON.parse(packJson) as ExportedPack;
      const diff = store.diffImport(snapshot);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(diff, null, 2),
          },
        ],
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    store.close();
    await server.close();
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
