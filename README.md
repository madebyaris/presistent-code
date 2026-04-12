# Persistent Code

Local-first, shareable code-style packs for AI coding tools.

The project stores style packs on your computer, serves them to IDEs through one MCP stdio server, exposes the same behavior through a CLI, and can optionally sync or rotate a TiDB Cloud Zero remote for sharing and backup.

## What ships here

- Machine-wide local store:
  - macOS: `~/Library/Application Support/persistent-code`
  - Linux: `~/.config/persistent-code`
  - Windows: `%APPDATA%/persistent-code`
- SQLite-backed style packs, rules, rule history, and share tokens.
- MCP stdio server for Cursor, Windsurf, and other MCP hosts.
- CLI for `init`, `pack`, `rule`, `search`, `export`, `share`, `sync`, `doctor`, and `renew-tidb`.
- Optional TiDB Cloud Zero sync plus automatic rotate-and-repush workflow.

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

Optional tiny project rule:

```md
Load coding standards from the `persistent-code` MCP server before making edits.
```

### Windsurf

Use the same stdio command in Windsurf’s MCP server settings:

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

## MCP tools

The MCP server exposes these tools:

- `list_style_packs`
- `get_rules_for_glob`
- `search_rules`
- `upsert_rule`
- `export_pack`

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
