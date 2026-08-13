# pi-ledger

### A local work journal for [Pi](https://pi.dev)

**[Install](#install)** · **[How it works](#how-it-works)** · **[Technical details](docs/how-it-works.md)** · **[Journal](#journal)** · **[Search](#search)** · **[Commands](#commands)** · **[Data and privacy](#data-and-privacy)**

_A daily record of what you asked Pi to work on._

`pi-ledger` creates a local Markdown journal from your Pi sessions. It records each request, when and where it was made, which models and tools were used, and the usage and cost reported by Pi. Every entry links back to the original session for the full conversation.

The journal is built from recorded session facts. pi-ledger does not call a model to write summaries, guess whether work was completed, or copy conversations into its database.

## Install

```bash
pi install npm:pi-ledger
```

## How it works

pi-ledger runs quietly in the background and records:

- the request and its local time
- the working directory
- the Pi session and initiating user-entry IDs
- the providers and models used
- token usage and cost reported by Pi
- tool executions and failures

The original Pi session remains the full transcript. The journal database contains only the facts needed to render and search journal entries.

If recording or note generation fails, Pi continues normally and pi-ledger shows a warning. SQLite remains authoritative, and Markdown notes can be regenerated from it.

## Journal

Daily notes are written to:

```text
~/.pi/agent/ledger/notes/YYYY-MM-DD.md
```

For example:

```markdown
# Daily Journal — 2026-08-12

## pi-ledger

### 14:32 — Add timezone-aware journal timestamps and tests

**Transcript:** [Open Pi session](file:///home/me/.pi/agent/sessions/project/session.jsonl) · Session `019f…` · entry `abc123`

**Models:** `openai/gpt-5.6-sol`, `anthropic/claude-sonnet-4-6`

**Usage:** 82,491 tokens · $1.72

- `openai/gpt-5.6-sol`: 71,420 tokens · $1.61 · 4 responses
- `anthropic/claude-sonnet-4-6`: 11,071 tokens · $0.11 · 1 response

**Tools:** `read` ×8 · `edit` ×3 · `bash` ×5
```

Headings come from the request after Pi expands any skill or prompt-template invocation. Model, tool, usage, and cost details come from Pi's records. Ephemeral sessions have no file link, so their session and entry IDs are shown instead.

Journal dates and times use the system's local timezone at the time the request is recorded. If Pi uses a custom agent directory, pi-ledger follows `PI_CODING_AGENT_DIR`.

## Search

The extension registers two agent tools. `journal_search` provides ranked full-text search over recorded requests, with optional filters for:

- local date range
- working-directory prefix
- provider/model
- tool name

Results include the matching request, Ledger entry ID, project path, model and tool facts, and a link to the native Pi session. Search tries to match every term first, then retries with any matching term when that finds nothing.

`journal_related` starts from a Ledger entry ID returned by search and finds other requests sharing its most distinctive terms. It is local lexical search rather than semantic or model-generated similarity, so concrete project names, errors, symbols, and feature terms produce the best results.

Search is intentionally scoped to **what you asked Pi**. Response bodies are not copied into the index, so details mentioned only inside a conversation remain available through the linked transcript rather than journal search.

## Commands

pi-ledger records by default. One `/ledger` command shows its status, controls recording, and rebuilds the derived Markdown notes:

```text
/ledger                    show recording status for the current directory
/ledger off                stop recording this session
/ledger on                 record this session, even if its project is disabled
/ledger off project        disable recording for this project
/ledger on project         enable recording for this project
/ledger rebuild            regenerate every daily note from SQLite
```

Session settings are the most specific and survive reloads and resumes. Project settings use the session's exact working directory and persist across sessions. When recording is disabled, a small `ledger off` footer status remains visible; search and note rebuilding continue to work.

`/ledger rebuild` is normally unnecessary. Use it after deleting a note, after fixing a note-writing problem, or whenever the Markdown output no longer matches the database.

## Data and privacy

Your Pi sessions stay where Pi wrote them. The journal and its local SQLite index live under:

```text
~/.pi/agent/ledger/
├── ledger.sqlite
└── notes/
```

pi-ledger does not send journal content anywhere. On systems with POSIX permissions, the journal directory, database, and notes are readable only by the current user.

Project exclusions are stored in the journal database. Session recording overrides are stored as hidden Pi session entries and are never added to model context.

## Runtime requirements

- Node.js 24.15 or newer
- Node's built-in `node:sqlite` module
- SQLite compiled with FTS5

Bun versions before 1.4 do not implement `node:sqlite`. Pi executables compiled with those Bun versions cannot run pi-ledger; use a Node-based Pi installation instead. This is a known [Pi runtime compatibility issue](https://github.com/earendil-works/pi/issues/7594).

## Development

```bash
git clone https://github.com/rcssdy/pi-ledger.git
cd pi-ledger
npm install
npm run check
```

Try the extension from the checkout:

```bash
pi -e /path/to/pi-ledger/src/index.ts
```

## License

MIT
