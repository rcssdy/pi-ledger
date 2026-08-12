# pi-ledger

`pi-ledger` is a [Pi](https://pi.dev) extension that records work history and connects Pi sessions to Git commits and GitHub pull requests.

> pi-ledger is under active development and is not ready for installation yet.

## Runtime compatibility

pi-ledger requires Node.js 24.15 or newer. It uses Node's built-in `node:sqlite` module and requires an SQLite build with FTS5 enabled.

Bun versions before 1.4 do not implement `node:sqlite`. Pi executables compiled with those Bun versions cannot run pi-ledger; use a Node-based Pi installation instead. This is a known [Pi runtime compatibility issue](https://github.com/earendil-works/pi/issues/7594).

## Development

```bash
npm install
npm run check
```

The package exposes one Pi extension from `src/index.ts`. It intentionally provides no custom UI, CLI, skill, daemon, MCP server, or slash commands.
