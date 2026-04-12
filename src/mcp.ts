import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { LocalStore } from "./local-store.js";
import { searchRemoteRules } from "./tidb.js";
import { defaultStoreDir } from "./utils.js";

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

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    store.close();
    await server.close();
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
