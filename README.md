<div align="center">

<img height="120" alt="pi-ledger" src="assets/pi-ledger.png" />

# pi-ledger

### A local work journal for [Pi](https://pi.dev)

**[Install](#install)** · **[How it works](#how-it-works)** · **[Commands](#commands)**

_A daily record of what you asked Pi to work on._

</div>

`pi-ledger` creates a local Markdown journal from your Pi sessions. Each daily record represents one session, lists its requests, and summarizes the models, tools, usage, and cost reported by Pi. Every record links back to the original session for the full conversation.

The journal is built from recorded session facts. pi-ledger does not call a model to write summaries, guess whether work was completed, or copy conversations into its database.

## Install

```bash
pi install npm:pi-ledger
```

## Features

Pi sessions preserve complete conversations. pi-ledger turns them into a work history you can scan, search, and keep outside the chat interface.

- **A daily work log:** see each Pi session, what you asked it to do, and when you worked on it across projects.
- **A way back to earlier work:** find a past request, then open its original session for the full context.
- **A usage record:** review which models and tools ran, where failures occurred, and how many tokens and dollars were spent.
- **A durable local artifact:** keep readable Markdown notes backed by a rebuildable SQLite database, without sending journal content anywhere.

Use it as a personal engineering journal, a project activity trail, or a factual record of AI-assisted work.

## How it works

pi-ledger runs quietly in the background. It records each request and renders one journal record per session for each day, including:

- the request and its local time
- the working directory
- the Pi session and initiating user-entry IDs
- the providers and models used
- input, output, cache-read, cache-write, and total tokens reported by Pi
- cost reported by Pi
- tool executions and failures

The original Pi session remains the full transcript. The journal database contains only the facts needed to render and search journal entries.

If recording or note generation fails, Pi continues normally and pi-ledger shows a warning. SQLite remains authoritative, and Markdown notes can be regenerated from it.

For the recording lifecycle, storage model, search behaviour, and failure handling, see [How pi-ledger works](docs/how-it-works.md).

## Journal

Daily notes are written to:

```text
~/.pi/agent/ledger/notes/YYYY-MM-DD.md
```

For example:

```markdown
# Daily Journal — 2026-08-12

## pi-ledger

### 14:32–14:45 — Add timezone-aware journal timestamps and tests

**Transcript:** [Open Pi session](file:///home/me/.pi/agent/sessions/project/session.jsonl) · Session `019f…`

**Requests:** 2

- **14:32** — Add timezone-aware journal timestamps and tests
- **14:45** — Run the focused tests

**Models:** `openai/gpt-5.6-sol`, `anthropic/claude-sonnet-4-6`

**Usage:** 91,071 tokens (input 12,000 · output 1,571 · cache read 67,500 · cache write 10,000) · $1.91

- `openai/gpt-5.6-sol`: 80,000 tokens (input 11,000 · output 1,500 · cache read 57,500 · cache write 10,000) · $1.80 · 6 responses
- `anthropic/claude-sonnet-4-6`: 11,071 tokens (input 1,000 · output 71 · cache read 10,000 · cache write 0) · $0.11 · 1 response

**Tools:** `read` ×10, 1 failed · `edit` ×3 · `bash` ×5
```

The first request becomes the session heading. Requests remain separate in SQLite for search, while the daily note sums model, tool, usage, and cost facts across the session. A session resumed on another day gets a record on that day's note for the requests made that day. Ephemeral sessions have no file link, so their session ID is shown instead.

Journal dates and times use the system's local timezone at the time the request is recorded. If Pi uses a custom agent directory, pi-ledger follows `PI_CODING_AGENT_DIR`.

To write Markdown notes elsewhere, set `PI_LEDGER_NOTES_DIR` to an absolute or home-relative path before starting Pi:

```bash
export PI_LEDGER_NOTES_DIR="$HOME/Documents/Pi Ledger"
```

This setting changes only the derived Markdown notes. It does not move the SQLite database or existing notes. After changing it, restart Pi and run `/ledger rebuild` to create the notes in their new location.

## Search

The extension registers two agent tools. `journal_search` provides ranked full-text search over recorded requests, with optional filters for:

- local date range
- working-directory prefix
- provider/model
- tool name

Results include the matching request, Ledger entry ID, project path, per-model and tool-reported token breakdowns, and a link to the native Pi session. Search tries to match every term first, then retries with any matching term when that finds nothing.

`journal_related` starts from a Ledger entry ID returned by search and finds other requests sharing its strongest topic terms. It ranks stronger overlaps first. It is local lexical search rather than semantic or model-generated similarity, so concrete project names, errors, symbols, and feature terms produce the best results.

Search is intentionally scoped to **what you asked Pi**. Response bodies are not copied into the index, so details mentioned only inside a conversation remain available through the linked transcript rather than journal search.

## Commands

pi-ledger records by default. One `/ledger` command shows its status, controls recording, and rebuilds the derived Markdown notes:

```text
/ledger                    show recording status and the notes directory
/ledger off                stop recording this session
/ledger on                 record this session, even if its project is disabled
/ledger off project        disable recording for this project
/ledger on project         enable recording for this project
/ledger rebuild            regenerate every daily note from SQLite
```

Session settings are the most specific and survive reloads and resumes. Project settings use the session's exact working directory and persist across sessions. When recording is disabled, a small `ledger off` footer status remains visible; search and note rebuilding continue to work.

`/ledger rebuild` is normally unnecessary. Use it after deleting a note, after fixing a note-writing problem, or whenever the Markdown output no longer matches the database.

## Roadmap

Planned improvements include:

- importing existing Pi sessions into the journal
- minimal aggregate stats for costs, models, and tools
- a quick way to open the journal notes

These additions will preserve pi-ledger's current boundary: recorded session facts, local storage, and no model-generated summaries or copied response bodies.

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
