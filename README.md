# pi-ledger

`pi-ledger` is a [Pi](https://pi.dev) extension that records work history and connects Pi sessions to Git commits and GitHub pull requests.

> pi-ledger is under active development and is not ready for installation yet.

## Development

Requires Node.js 22.19 or newer.

```bash
npm install
npm run check
```

The package exposes one Pi extension from `src/index.ts`. It intentionally provides no custom UI, CLI, skill, daemon, MCP server, or slash commands.
