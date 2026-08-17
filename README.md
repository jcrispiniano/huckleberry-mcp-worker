# huckleberry-mcp-worker

A [Model Context Protocol](https://modelcontextprotocol.io) server for the
[Huckleberry](https://huckleberrycare.com) baby-tracking app, running as a
Cloudflare Worker.

This is a TypeScript port of
[`bckenstler/py-huckleberry-mcp`](https://github.com/bckenstler/py-huckleberry-mcp).
The original is a Python stdio server that talks to Firestore through
`google-cloud-firestore`, which speaks gRPC and therefore cannot run on Workers.
This port reaches the same backend over the Firebase REST API using `fetch`, and
serves MCP over Streamable HTTP.

The practical difference: it is always on. No laptop has to be awake for a
client to log a nap.

## Tools

All 23 tools from the Python server are implemented, plus `delete_record`.

| Area | Tools |
| --- | --- |
| Children | `list_children`, `get_child_name` |
| Sleep | `log_sleep`, `start_sleep`, `pause_sleep`, `resume_sleep`, `complete_sleep`, `cancel_sleep`, `get_sleep_history` |
| Feeding | `log_breastfeeding`, `log_bottle_feeding`, `start_breastfeeding`, `pause_feeding`, `resume_feeding`, `switch_feeding_side`, `complete_feeding`, `cancel_feeding`, `get_feeding_history` |
| Diaper | `log_diaper`, `get_diaper_history` |
| Growth | `log_growth`, `get_latest_growth`, `get_growth_history` |
| Records | `delete_record` |

Every history tool reports each record's `interval_id`, which is what
`delete_record` takes.

## Fixes relative to the Python server

Four defects were found while porting and are corrected here.

**Breastfeeding durations were written in the wrong unit.** The backend stores
`leftDuration` / `rightDuration` in seconds — that is what the app's own timer
writes — but `log_breastfeeding` passed the caller's *minutes* straight through.
Logging a 5 minute feed recorded 5 seconds. Callers previously had to pass 300
to mean 5 minutes; here `left_duration_minutes: 5` means five minutes.

**Single-day history queries returned nothing.** Both ends of a date range were
resolved to midnight, so `start_date == end_date` produced an empty window and
the server reported no records for a day that had plenty. Ranges are now
half-open `[start_of_start_date, start_of_end_date + 1 day)`, making both ends
inclusive.

**`end_time` in sleep history was always null.** The code read an `end` field
that the backend never writes. It is now derived from `start + duration`.

**`birth_date` in `list_children` was always null.** The backend field is
`birthdate`; the server read `birthDate`.

`get_feeding_history` also now returns each record's `mode`, which distinguishes
breastfeeding from bottle and solids entries. Without it, a solids record is
indistinguishable from a zero-length nursing session.

## Setup

Requires Node 18+ and a Cloudflare account.

```bash
npm install
npx wrangler login
```

Set the secrets — they are stored encrypted by Cloudflare and never live in the
repository:

```bash
npx wrangler secret put HUCKLEBERRY_EMAIL
npx wrangler secret put HUCKLEBERRY_PASSWORD
npx wrangler secret put MCP_AUTH_TOKEN     # a long random string you generate
npx wrangler secret put HUCKLEBERRY_TIMEZONE   # e.g. America/Sao_Paulo
```

`HUCKLEBERRY_TIMEZONE` defaults to `America/New_York`. It decides how naive
datetimes like `"2026-08-17T15:47:00"` are interpreted, so setting it correctly
matters.

Deploy:

```bash
npm run deploy
```

## Authentication

The Worker URL is public, and the server holds credentials to a child's health
record, so every request must carry the bearer token:

```
Authorization: Bearer <MCP_AUTH_TOKEN>
```

Requests without a valid token get a 401 before any Huckleberry call is made.
Generate a token with something like `openssl rand -base64 32`.

## Client configuration

For Claude Code:

```bash
claude mcp add --transport http huckleberry https://<your-worker>.workers.dev/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

## Local development

```bash
cp .dev.vars.example .dev.vars   # then fill it in; .dev.vars is gitignored
npm run dev
```

```bash
curl -X POST http://localhost:8787/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Design notes

**Stateless.** Each request builds a fresh `McpServer` via `createMcpHandler`
from Cloudflare's `agents` SDK. No Durable Objects and no session storage are
involved, because every tool is a self-contained read or write.

**Token caching.** Firebase ID tokens last an hour and are cached in module
scope, so requests landing on a warm isolate skip re-authentication. A cold
isolate costs one extra round trip. A token rejected mid-flight triggers one
re-authentication and retry.

**Numeric types.** Firestore distinguishes integers from doubles, and the app
writes some fields as one and some as the other. Values that must be stored as
doubles are wrapped in `dbl()` so records written here match records written by
the app.

**Multi-entry documents.** History lives in two shapes: ordinary documents with
a top-level `start`, and batch documents holding many entries under `data`.
Nested starts cannot be filtered server-side, so batch documents are fetched
whole and filtered in the Worker. Records report which shape they came from via
`is_multi_entry`.

## Deleting records

The Python server had no delete, and the received wisdom was that the backend
did not allow one. It does: a `DELETE` on the document path returns 200. What
was actually missing was the record's id, which the history tools never
reported.

So history tools now return `interval_id`, and `delete_record` removes the
record it names. Batched entries — several records packed into one document
under `data` — are addressed as `<documentId>#<entryKey>` and removed as a
field of their parent.

Deleting also repoints `prefs.last*` at the newest surviving record. The app
reads those pointers directly, so a delete without the repoint leaves it showing
a record that no longer exists.

## Known limitations

- **Deletes are permanent.** There is no undo. Confirm with a history query
  before calling `delete_record`.
- **Solids are read-only.** `get_feeding_history` reports `mode: "solids"`
  entries, but there is no tool to create one.
- **`start_sleep` does not guard against an already-running timer.** The Python
  server documented that it would fail in that case but never checked; the
  behaviour is preserved here rather than silently changed.
- **Notes do not round-trip into sleep records.** The `details` field is a fixed
  structure of checkboxes, not free text.

## License

MIT
