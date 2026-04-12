import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LocalStore } from "../src/local-store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createStore(): Promise<LocalStore> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "persistent-code-test-"));
  tempDirs.push(dir);
  return LocalStore.open(dir);
}

describe("LocalStore", () => {
  it("creates a pack, matches glob rules, and searches them", async () => {
    const store = await createStore();
    try {
      const pack = store.createPack({ name: "Default Pack" });
      store.upsertRule({
        pack: pack.id,
        title: "Shared TS style",
        bodyMarkdown: "Prefer named exports.",
        globs: ["src/**/*.ts"],
      });

      const matches = store.getRulesForGlob("src/lib/utils.ts");
      const results = store.searchRules("named exports");

      expect(matches).toHaveLength(1);
      expect(matches[0]?.matchedBy).toBe("glob");
      expect(results[0]?.title).toBe("Shared TS style");
    } finally {
      store.close();
    }
  });

  it("exports .mdc files for a pack", async () => {
    const store = await createStore();
    try {
      const pack = store.createPack({ name: "Cursor Pack" });
      store.upsertRule({
        pack: pack.id,
        title: "Always apply",
        bodyMarkdown: "Keep functions small.",
        alwaysApply: true,
      });

      const outDir = path.join(store.storeDir, "rules");
      await store.exportPackAsMdc(pack.id, outDir);

      const files = await readdir(outDir);
      const contents = await readFile(path.join(outDir, files[0]!), "utf8");
      expect(files).toEqual(["always-apply.mdc"]);
      expect(contents).toContain("alwaysApply: true");
      expect(contents).toContain("Keep functions small.");
    } finally {
      store.close();
    }
  });

  it("forks packs by importing their snapshot", async () => {
    const store = await createStore();
    try {
      const source = store.createPack({ name: "Source Pack" });
      store.upsertRule({
        pack: source.id,
        title: "One rule",
        bodyMarkdown: "Body",
        alwaysApply: true,
      });

      const fork = store.forkPack(source.id, "Forked Pack");
      const forkRules = store.listRules(fork.id);

      expect(fork.name).toBe("Forked Pack");
      expect(forkRules).toHaveLength(1);
      expect(forkRules[0]?.title).toBe("One rule");
      expect(forkRules[0]?.packId).toBe(fork.id);
    } finally {
      store.close();
    }
  });
});
