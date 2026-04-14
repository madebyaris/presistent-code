import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalStore } from "../src/local-store.js";

const tempDirs: string[] = [];

beforeEach(() => {
  // No-op — dirs are created per test via createStore()
});

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createStore(): Promise<LocalStore> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "persistent-code-test-"));
  tempDirs.push(dir);
  return LocalStore.open(dir);
}

describe("Activity Tracking (P4)", () => {
  it("records rule matches when getRulesForGlob is called", async () => {
    const store = await createStore();
    try {
      const pack = store.createPack({ name: "Test Pack" });
      store.upsertRule({
        pack: pack.id,
        title: "TS rule",
        bodyMarkdown: "Prefer named exports.",
        globs: ["src/**/*.ts"],
      });

      store.getRulesForGlob("src/lib/utils.ts"); // matches
      store.getRulesForGlob("src/lib/helper.ts"); // matches
      store.getRulesForGlob("src/lib/helper.ts"); // called twice (still records)

      const activity = store.getRuleActivity();
      expect(activity).toHaveLength(3);

      const rule = store.listRules(pack.id)[0]!;
      const ruleActivity = store.getRuleActivity(rule.id);
      expect(ruleActivity).toHaveLength(3);
    } finally {
      store.close();
    }
  });

  it("records always-apply rule matches", async () => {
    const store = await createStore();
    try {
      const pack = store.createPack({ name: "Test Pack" });
      store.upsertRule({
        pack: pack.id,
        title: "Global rule",
        bodyMarkdown: "No console.log.",
        alwaysApply: true,
      });

      store.getRulesForGlob("anything/at/all.ts");

      const activity = store.getRuleActivity();
      expect(activity).toHaveLength(1);
      expect(activity[0]!.matchedBy).toBe("alwaysApply");
      expect(activity[0]!.matchedPath).toBe("anything/at/all.ts");
    } finally {
      store.close();
    }
  });

  it("filters activity by rule id", async () => {
    const store = await createStore();
    try {
      const pack = store.createPack({ name: "Test Pack" });
      store.upsertRule({
        pack: pack.id,
        title: "Rule A",
        bodyMarkdown: "Body A",
        globs: ["src/**/*.ts"],
      });
      store.upsertRule({
        pack: pack.id,
        title: "Rule B",
        bodyMarkdown: "Body B",
        globs: ["src/**/*.js"],
      });

      store.getRulesForGlob("src/lib/utils.ts"); // matches Rule A only

      const rules = store.listRules(pack.id);
      const ruleA = rules.find((r) => r.title === "Rule A")!;
      const ruleB = rules.find((r) => r.title === "Rule B")!;

      const activityA = store.getRuleActivity(ruleA.id);
      const activityB = store.getRuleActivity(ruleB.id);

      expect(activityA).toHaveLength(1);
      expect(activityB).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("filters activity by date with --since", async () => {
    const store = await createStore();
    try {
      const pack = store.createPack({ name: "Test Pack" });
      store.upsertRule({
        pack: pack.id,
        title: "TS rule",
        bodyMarkdown: "Prefer named exports.",
        globs: ["src/**/*.ts"],
      });

      store.getRulesForGlob("src/lib/utils.ts");

      const now = new Date().toISOString();
      const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const future = "2099-01-01T00:00:00.000Z";

      const activitySinceNow = store.getRuleActivity(undefined, { since: now });
      expect(activitySinceNow).toHaveLength(1);

      const activitySinceLastWeek = store.getRuleActivity(undefined, { since: lastWeek });
      expect(activitySinceLastWeek).toHaveLength(1);

      const activityFuture = store.getRuleActivity(undefined, { since: future });
      expect(activityFuture).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("getStats returns correct counts including rules with no matches", async () => {
    const store = await createStore();
    try {
      const pack = store.createPack({ name: "Test Pack" });
      store.upsertRule({
        pack: pack.id,
        title: "Used rule",
        bodyMarkdown: "Used.",
        globs: ["src/**/*.ts"],
      });
      store.upsertRule({
        pack: pack.id,
        title: "Unused rule",
        bodyMarkdown: "Never matched.",
        globs: ["*.never.ts"],
      });

      store.getRulesForGlob("src/lib/utils.ts");

      const stats = store.getStats();
      expect(stats.packCount).toBe(1);
      expect(stats.ruleCount).toBe(2);
      expect(stats.totalMatches).toBe(1);
      expect(stats.rulesWithNoMatches).toBe(1);
    } finally {
      store.close();
    }
  });
});

describe("Rule Explanation (P3)", () => {
  it("explains why a rule applies to a path", async () => {
    const store = await createStore();
    try {
      const pack = store.createPack({ name: "Test Pack" });
      store.upsertRule({
        pack: pack.id,
        title: "TS imports",
        bodyMarkdown: "Use explicit imports.",
        globs: ["src/**/*.ts", "src/**/*.tsx"],
      });

      const explanation = store.explainRulesForPath("src/app/page.tsx");

      expect(explanation.path).toBe("src/app/page.tsx");
      expect(explanation.matchedRules).toHaveLength(1);
      expect(explanation.matchedRules[0]!.title).toBe("TS imports");
      expect(explanation.matchedRules[0]!.whyItApplies).toContain("src/app/page.tsx");
      expect(explanation.matchedRules[0]!.matchedBy).toBe("glob");
      expect(explanation.matchedRules[0]!.precedence).toBe(1);
    } finally {
      store.close();
    }
  });

  it("explains always-apply rules separately", async () => {
    const store = await createStore();
    try {
      const pack = store.createPack({ name: "Test Pack" });
      store.upsertRule({
        pack: pack.id,
        title: "No any",
        bodyMarkdown: "Never use any.",
        alwaysApply: true,
      });
      store.upsertRule({
        pack: pack.id,
        title: "TS imports",
        bodyMarkdown: "Use explicit imports.",
        globs: ["src/**/*.ts"],
      });

      const explanation = store.explainRulesForPath("src/lib/utils.ts");

      expect(explanation.matchedRules).toHaveLength(1);
      expect(explanation.alwaysApplyRules).toHaveLength(1);
      expect(explanation.alwaysApplyRules[0]!.title).toBe("No any");
      expect(explanation.alwaysApplyRules[0]!.whyItApplies).toContain("alwaysApply");
      expect(explanation.totalMatched).toBe(2);
    } finally {
      store.close();
    }
  });

  it("sorts rules by sortOrder then title", async () => {
    const store = await createStore();
    try {
      const pack = store.createPack({ name: "Test Pack" });
      store.upsertRule({
        pack: pack.id,
        title: "Zebra rule",
        bodyMarkdown: "Body Z",
        globs: ["src/**/*.ts"],
        sortOrder: 10,
      });
      store.upsertRule({
        pack: pack.id,
        title: "Alpha rule",
        bodyMarkdown: "Body A",
        globs: ["src/**/*.ts"],
        sortOrder: 1,
      });

      const explanation = store.explainRulesForPath("src/lib/utils.ts");

      expect(explanation.matchedRules[0]!.title).toBe("Alpha rule");
      expect(explanation.matchedRules[1]!.title).toBe("Zebra rule");
    } finally {
      store.close();
    }
  });

  it("explains for a specific pack only", async () => {
    const store = await createStore();
    try {
      const pack1 = store.createPack({ name: "Pack One" });
      const pack2 = store.createPack({ name: "Pack Two" });
      store.upsertRule({
        pack: pack1.id,
        title: "Pack1 Rule",
        bodyMarkdown: "Body",
        globs: ["src/**/*.ts"],
      });
      store.upsertRule({
        pack: pack2.id,
        title: "Pack2 Rule",
        bodyMarkdown: "Body",
        globs: ["src/**/*.ts"],
      });

      const explanation = store.explainRulesForPath("src/lib/utils.ts", pack1.slug);

      expect(explanation.matchedRules).toHaveLength(1);
      expect(explanation.matchedRules[0]!.title).toBe("Pack1 Rule");
    } finally {
      store.close();
    }
  });
});

describe("Lint (P1)", () => {
  it("detects overlapping glob patterns in the same pack", async () => {
    const store = await createStore();
    try {
      const pack = store.createPack({ name: "Test Pack" });
      store.upsertRule({
        pack: pack.id,
        title: "Rule A",
        bodyMarkdown: "Do X.",
        globs: ["src/**/*.ts"],
      });
      store.upsertRule({
        pack: pack.id,
        title: "Rule B",
        bodyMarkdown: "Do Y.",
        globs: ["src/components/*.ts"],
      });

      const result = store.lint();

      const overlapping = result.issues.filter((i) => i.type === "overlapping_glob");
      expect(overlapping).toHaveLength(1);
      expect(overlapping[0]!.severity).toBe("warning");
    } finally {
      store.close();
    }
  });

  it("detects contradictions when overlapping rules have different body", async () => {
    const store = await createStore();
    try {
      const pack = store.createPack({ name: "Test Pack" });
      store.upsertRule({
        pack: pack.id,
        title: "Prefer default",
        bodyMarkdown: "Use default exports.",
        globs: ["src/**/*.ts"],
      });
      store.upsertRule({
        pack: pack.id,
        title: "Prefer named",
        bodyMarkdown: "Use named exports.",
        globs: ["src/**/*.ts"],
      });

      const result = store.lint();

      const contradictions = result.issues.filter((i) => i.type === "contradiction");
      expect(contradictions).toHaveLength(1);
      expect(contradictions[0]!.severity).toBe("error");
    } finally {
      store.close();
    }
  });

  it("flags unused packs with zero rules", async () => {
    const store = await createStore();
    try {
      store.createPack({ name: "Empty Pack" });

      const result = store.lint();

      const unused = result.issues.filter((i) => i.type === "unused_pack");
      expect(unused).toHaveLength(1);
      expect(unused[0]!.message).toContain("Empty Pack");
    } finally {
      store.close();
    }
  });

  it("flags rules that have never been matched", async () => {
    const store = await createStore();
    try {
      const pack = store.createPack({ name: "Test Pack" });
      store.upsertRule({
        pack: pack.id,
        title: "Never used",
        bodyMarkdown: "This rule was never matched.",
        globs: ["**/*.nowhere"],
      });

      const result = store.lint();

      const orphans = result.issues.filter((i) => i.type === "orphan_rule");
      expect(orphans).toHaveLength(1);
      expect(orphans[0]!.severity).toBe("info");
    } finally {
      store.close();
    }
  });

  it("cross-checks globs against real codebase paths", async () => {
    const store = await createStore();
    try {
      const pack = store.createPack({ name: "Test Pack" });
      store.upsertRule({
        pack: pack.id,
        title: "Real rule",
        bodyMarkdown: "Body",
        globs: ["src/**/*.ts"],
      });
      store.upsertRule({
        pack: pack.id,
        title: "Fake rule",
        bodyMarkdown: "Body",
        globs: ["no/such/path/**/*.ts"],
      });

      const fs = await import("node:fs/promises");
      const srcDir = path.join(store.storeDir, "src");
      await fs.mkdir(srcDir, { recursive: true });
      await fs.writeFile(path.join(srcDir, "utils.ts"), "export const x = 1", "utf8");

      const codebasePaths: string[] = [];
      const { readdir, stat } = await import("node:fs/promises");
      async function walk(dir: string): Promise<void> {
        for (const entry of await readdir(dir)) {
          const full = path.join(dir, entry);
          if ((await stat(full)).isFile()) {
            codebasePaths.push(full);
          }
        }
      }
      await walk(srcDir);

      const result = store.lint(codebasePaths);

      const orphans = result.issues.filter((i) => i.type === "orphan_rule");
      const hasFake = orphans.some((o) => o.message?.includes("Fake rule"));
      expect(hasFake).toBe(true);
    } finally {
      store.close();
    }
  });

  it("produces correct summary counts", async () => {
    const store = await createStore();
    try {
      const pack = store.createPack({ name: "Test Pack" });
      store.upsertRule({
        pack: pack.id,
        title: "Rule 1",
        bodyMarkdown: "Body",
        globs: ["src/**/*.ts"],
      });

      const result = store.lint();

      expect(result.summary.totalPacks).toBe(1);
      expect(result.summary.totalRules).toBe(1);
      expect(result.summary.unusedPacks).toBe(0);
    } finally {
      store.close();
    }
  });
});

describe("Import Diff (P2)", () => {
  it("detects new rules when importing a pack that does not exist locally", async () => {
    const store = await createStore();
    try {
      const remotePack: Parameters<typeof store.diffImport>[0] = {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        pack: {
          id: "remote-pack-1",
          name: "Remote Pack",
          slug: "remote-pack",
          description: "From remote",
          visibility: "public",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        rules: [
          {
            id: "rule-1",
            packId: "remote-pack-1",
            title: "New Rule",
            bodyMarkdown: "Do this.",
            globs: ["src/**/*.ts"],
            alwaysApply: false,
            sortOrder: 100,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        shareTokens: [],
      };

      const diff = store.diffImport(remotePack);

      expect(diff.packs[0]!.action).toBe("create");
      expect(diff.newRules).toHaveLength(1);
      expect(diff.newRules[0]!.title).toBe("New Rule");
      expect(diff.suggestions[0]!.type).toBe("replace");
    } finally {
      store.close();
    }
  });

  it("detects updated rules when local and remote differ", async () => {
    const store = await createStore();
    try {
      const pack = store.createPack({ name: "Existing Pack" });
      store.upsertRule({
        pack: pack.id,
        title: "Shared Rule",
        bodyMarkdown: "Original body.",
        globs: ["src/**/*.ts"],
      });

      const remotePack: Parameters<typeof store.diffImport>[0] = {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        pack: {
          id: pack.id,
          name: "Existing Pack",
          slug: pack.slug,
          description: "",
          visibility: "private",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        rules: [
          {
            id: "rule-local-1",
            packId: pack.id,
            title: "Shared Rule",
            bodyMarkdown: "Updated body — this is different.",
            globs: ["src/**/*.ts"],
            alwaysApply: false,
            sortOrder: 100,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        shareTokens: [],
      };

      const diff = store.diffImport(remotePack);

      expect(diff.updatedRules).toHaveLength(1);
      expect(diff.updatedRules[0]!.local.bodyMarkdown).toBe("Original body.");
      expect(diff.updatedRules[0]!.remote.bodyMarkdown).toBe("Updated body — this is different.");
    } finally {
      store.close();
    }
  });

  it("detects conflicts when overlapping rules have different bodies", async () => {
    const store = await createStore();
    try {
      const pack = store.createPack({ name: "Test Pack" });
      store.upsertRule({
        pack: pack.id,
        title: "Prefer exports",
        bodyMarkdown: "Use default exports.",
        globs: ["src/**/*.ts"],
      });

      const remotePack: Parameters<typeof store.diffImport>[0] = {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        pack: {
          id: pack.id,
          name: "Test Pack",
          slug: pack.slug,
          description: "",
          visibility: "private",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        rules: [
          {
            id: "rule-remote-1",
            packId: pack.id,
            title: "Prefer exports",
            bodyMarkdown: "Use named exports instead.",
            globs: ["src/**/*.ts"],
            alwaysApply: false,
            sortOrder: 100,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        shareTokens: [],
      };

      const diff = store.diffImport(remotePack);

      expect(diff.conflicts).toHaveLength(1);
      expect(diff.conflicts[0]!.field).toBe("bodyMarkdown");
    } finally {
      store.close();
    }
  });

  it("marks unchanged rules correctly", async () => {
    const store = await createStore();
    try {
      const pack = store.createPack({ name: "Test Pack" });
      const rule = store.upsertRule({
        pack: pack.id,
        title: "Stable Rule",
        bodyMarkdown: "This body is the same.",
        globs: ["src/**/*.ts"],
      });

      const remotePack: Parameters<typeof store.diffImport>[0] = {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        pack: {
          id: pack.id,
          name: "Test Pack",
          slug: pack.slug,
          description: "",
          visibility: "private",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        rules: [
          {
            id: rule.id,
            packId: pack.id,
            title: "Stable Rule",
            bodyMarkdown: "This body is the same.",
            globs: ["src/**/*.ts"],
            alwaysApply: false,
            sortOrder: 100,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        shareTokens: [],
      };

      const diff = store.diffImport(remotePack);

      expect(diff.unchangedRules).toHaveLength(1);
      expect(diff.unchangedRules[0]!.title).toBe("Stable Rule");
    } finally {
      store.close();
    }
  });
});

describe("Digest Report (P5)", () => {
  it("generates a health report with scores and stale rules", async () => {
    const store = await createStore();
    try {
      const pack = store.createPack({ name: "Test Pack" });
      store.upsertRule({
        pack: pack.id,
        title: "Never matched rule",
        bodyMarkdown: "Body",
        globs: ["**/*.nowhere"],
      });
      store.upsertRule({
        pack: pack.id,
        title: "Used rule",
        bodyMarkdown: "Body",
        globs: ["src/**/*.ts"],
      });

      store.getRulesForGlob("src/lib/utils.ts");

      const report = store.getDigestReport();

      expect(report.healthScore).toBeLessThan(100);
      expect(report.rulesWithNoMatches).toContain("Never matched rule");
      expect(report.staleRules).toHaveLength(1);
      expect(report.totalRuleMatches).toBe(1);
      expect(report.mostMatchedRules[0]!.matchCount).toBe(1);
    } finally {
      store.close();
    }
  });

  it("returns empty arrays when there is no activity", async () => {
    const store = await createStore();
    try {
      const pack = store.createPack({ name: "Test Pack" });
      store.upsertRule({
        pack: pack.id,
        title: "A rule",
        bodyMarkdown: "Body",
        globs: ["src/**/*.ts"],
      });

      const report = store.getDigestReport();

      // One rule with no matches: health score = 100 - 2 = 98
      expect(report.healthScore).toBe(98);
      expect(report.rulesWithNoMatches).toContain("A rule");
      expect(report.totalRuleMatches).toBe(0);
    } finally {
      store.close();
    }
  });

  it("considers lint issues in health score", async () => {
    const store = await createStore();
    try {
      const pack = store.createPack({ name: "Test Pack" });
      store.upsertRule({
        pack: pack.id,
        title: "Rule A",
        bodyMarkdown: "Use default.",
        globs: ["src/**/*.ts"],
      });
      store.upsertRule({
        pack: pack.id,
        title: "Rule B",
        bodyMarkdown: "Use named.",
        globs: ["src/**/*.ts"],
      });

      const report = store.getDigestReport();

      // One contradiction deducts 10 from score
      expect(report.healthScore).toBeLessThan(100);
    } finally {
      store.close();
    }
  });
});

describe("Store CLAUDE.md generation (P6)", () => {
  it("generates a store CLAUDE.md with all packs and rules", async () => {
    const store = await createStore();
    try {
      const pack = store.createPack({ name: "Team Defaults" });
      store.upsertRule({
        pack: pack.id,
        title: "Prefer explicit types",
        bodyMarkdown: "Always annotate return types on public functions.",
        globs: ["src/**/*.ts"],
        alwaysApply: false,
        sortOrder: 5,
      });
      store.upsertRule({
        pack: pack.id,
        title: "No console.log",
        bodyMarkdown: "Use the logger instead.",
        alwaysApply: true,
      });

      const outPath = path.join(store.storeDir, "CLAUDE.md");
      const written = await store.generateStoreClaudeMd(outPath);

      expect(written).toBe(outPath);
      const content = await readFile(outPath, "utf8");
      expect(content).toContain("Team Defaults");
      expect(content).toContain("Prefer explicit types");
      expect(content).toContain("No console.log");
      expect(content).toContain("alwaysApply");
      expect(content).toContain("MCP Tools");
      expect(content).toContain("Conventions for Writing Rules");
    } finally {
      store.close();
    }
  });

  it("handles empty store gracefully", async () => {
    const store = await createStore();
    try {
      const outPath = path.join(store.storeDir, "CLAUDE.md");
      const written = await store.generateStoreClaudeMd(outPath);

      const content = await readFile(outPath, "utf8");
      expect(content).toContain("No packs created yet");
    } finally {
      store.close();
    }
  });
});

describe("getRulesForGlob records activity", () => {
  it("records match for glob-matched rules", async () => {
    const store = await createStore();
    try {
      const pack = store.createPack({ name: "Test" });
      store.upsertRule({
        pack: pack.id,
        title: "TS rule",
        bodyMarkdown: "Body",
        globs: ["src/**/*.ts"],
      });

      store.getRulesForGlob("src/lib/utils.ts");

      const stats = store.getStats();
      expect(stats.totalMatches).toBe(1);
    } finally {
      store.close();
    }
  });

  it("records match for always-apply rules", async () => {
    const store = await createStore();
    try {
      const pack = store.createPack({ name: "Test" });
      store.upsertRule({
        pack: pack.id,
        title: "Global",
        bodyMarkdown: "Body",
        alwaysApply: true,
      });

      store.getRulesForGlob("any/path/to/anything.ts");

      const stats = store.getStats();
      expect(stats.totalMatches).toBe(1);
    } finally {
      store.close();
    }
  });
});
