# Persistent Code

Local-first, shareable code-style packs for AI coding tools.

The project stores style packs on your computer, serves them to IDEs through one MCP stdio server, exposes the same behavior through a CLI, and can optionally sync or rotate a TiDB Cloud Zero remote for sharing and backup.

## What ships here

- Machine-wide local store:
  - macOS: `~/Library/Application Support/persistent-code`
  - Linux: `~/.config/persistent-code`
  - Windows: `%APPDATA%/persistent-code`
- SQLite-backed style packs, rules, rule history, rule activity tracking, and share tokens.
- MCP stdio server for Cursor, Windsurf, and other MCP hosts.
- CLI for `init`, `pack`, `rule`, `search`, `export`, `share`, `sync`, `doctor`, `renew-tidb`, `lint`, `explain`, `digest`, `activity`, `init-cursor`, and `generate-cursor-rules`.
- Optional TiDB Cloud Zero sync plus automatic rotate-and-repush workflow.
- Auto-injection layer with `CLAUDE.md` generation and per-project rule preloading.
- Store health auditing (lint), import diffing, and digest reporting.

## Install

```bash
npm install
npm run build
```

For local development without building every change:

```bash
npm run cli -- --help
npm run mcp
```

## Quick start

```bash
npm run cli -- init
npm run cli -- pack create "Team Defaults" --description "Shared coding rules"
npm run cli -- rule upsert team-defaults "TypeScript imports" --body "Use explicit imports and keep them grouped." --globs "src/**/*.ts" "src/**/*.tsx"
npm run cli -- rules-for-glob "src/app/page.tsx"
npm run cli -- export team-defaults --format mdc --out ".cursor/rules"
```

## Auto-injection setup (Leo-style proactive context)

The AI needs rules loaded **before** it starts editing — not after you ask. Run this once per project:

```bash
npm run cli -- init-cursor
```

This writes a `CLAUDE.md` to the current directory that instructs any AI agent to call `get_rules_for_glob` before touching files.

For a self-contained setup, also export rules as `.mdc` files that Cursor loads automatically:

```bash
npm run cli -- generate-cursor-rules --dir .cursor/rules
```

## Supported clients

### Cursor

Example MCP config:

```json
{
  "mcpServers": {
    "persistent-code": {
      "command": "node",
      "args": [
        "/absolute/path/to/presistent-code/dist/cli.js",
        "mcp-stdio"
      ]
    }
  }
}
```

If you install the tool globally later, the command can become:

```json
{
  "mcpServers": {
    "persistent-code": {
      "command": "persistent-code",
      "args": ["mcp-stdio"]
    }
  }
}
```

### Windsurf

Use the same stdio command in Windsurf's MCP server settings:

```json
{
  "name": "persistent-code",
  "command": "node",
  "args": [
    "/absolute/path/to/presistent-code/dist/cli.js",
    "mcp-stdio"
  ]
}
```

### Any MCP host

Any host that supports MCP stdio can run the same command:

```bash
node /absolute/path/to/presistent-code/dist/cli.js mcp-stdio
```

### CLI-only

The CLI works without any IDE integration:

```bash
npm run cli -- pack list
npm run cli -- search "imports"
npm run cli -- doctor
```

## Sharing and export

Create a local share token:

```bash
npm run cli -- share create team-defaults --permission fork
```

Export a pack as JSON or `.mdc` files:

```bash
npm run cli -- export team-defaults --format json --out ./team-defaults.json
npm run cli -- export team-defaults --format mdc --out ./.cursor/rules
```

Import a pack from a URL serving exported JSON:

```bash
npm run cli -- import-url https://example.com/team-defaults.json
```

Preview an import without applying it:

```bash
npm run cli -- import-url https://example.com/team-defaults.json --dry-run
```

If a TiDB remote is configured, you can also import from a share token:

```bash
npm run cli -- share import <token> --name "Forked Pack"
```

## TiDB Cloud Zero

Provision a Zero instance and store its connection info locally:

```bash
npm run cli -- tidb provision --tag persistent-code-dev
```

Push local data to the remote:

```bash
npm run cli -- sync push
```

Pull remote data back into the local store:

```bash
npm run cli -- sync pull
```

Inspect expiry and rotation status:

```bash
npm run cli -- doctor
```

Rotate to a fresh TiDB Zero instance and repush the local authoritative copy:

```bash
npm run cli -- renew-tidb
```

## Health auditing (lint)

Audit the rule store for issues — orphan rules, overlapping globs, contradictions, and unused packs:

```bash
npm run cli -- lint
npm run cli -- lint --pack team-defaults
npm run cli -- lint --codebase ./my-project  # cross-check globs against real files
```

The linter detects:
- **orphan_rule**: a rule that has never been matched (info)
- **overlapping_glob**: two rules in the same pack match the same files (warning)
- **contradiction**: two rules match the same files but say different things (error)
- **unused_pack**: a pack with zero rules (info)

## Understanding rules (explain)

Ask why a rule applies to a specific file:

```bash
npm run cli -- explain src/app/page.tsx
npm run cli -- explain src/app/page.tsx --pack team-defaults
```

Returns the matched rules with human-readable explanations of why each one applies.

## Import diffing

Before importing from a URL, preview what would change without modifying anything:

```bash
npm run cli -- import-url https://example.com/team-defaults.json --dry-run
```

The diff shows new rules, updated rules, conflicts, and merge suggestions. Apply with `--apply`.

## Rule activity tracking

Persistent Code records every time a rule is matched via `get_rules_for_glob`. View usage history:

```bash
npm run cli -- activity
npm run cli -- activity --rule rule_abc123 --limit 20 --since 2026-01-01
```

## Digest report

Generate a comprehensive health and activity report:

```bash
npm run cli -- digest
npm run cli -- digest --codebase ./my-project
npm run cli -- digest --out ./rule-health-report.json
```

The digest includes:
- Health score (0–100)
- Most/least matched rules
- Rules that have never been matched (stale)
- Recently active rules
- All lint issues

## Store documentation (CLAUDE.md)

Generate a self-documenting CLAUDE.md inside the store directory:

```bash
npm run cli -- generate-store-md
```

This documents all packs, rules, MCP tools, schema, and conventions for writing good rules.

## MCP tools

The MCP server exposes these tools:

| Tool | Description |
|------|-------------|
| `list_style_packs` | List every locally stored style pack with rule counts |
| `get_rules_for_glob` | Return all always-apply and glob-matching rules for a target path |
| `search_rules` | Full-text search across rules (local or remote TiDB) |
| `upsert_rule` | Create or update a rule in the local store |
| `export_pack` | Return a pack as JSON |
| `preload_rules_for_project` | Load all always-apply rules for a session start |
| `explain_rules_for_path` | Explain why each rule applies to a file |
| `lint_rules` | Audit the store for issues |
| `get_rule_activity` | View rule usage history |
| `get_digest_report` | Health and activity digest |
| `diff_import` | Preview what would change if you imported a pack |

It also exposes one resource:

- `persistent-code://metadata`

## Verification

The repo includes automated tests:

```bash
npm test
```

Type-check:

```bash
npm run check
```
