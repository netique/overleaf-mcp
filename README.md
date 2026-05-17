# overleaf-mcp

An MCP server for [Overleaf](https://www.overleaf.com) that lets a Claude or other agent navigate projects, read/edit `.tex` files, compile, and work with review-panel comments — over Overleaf's **real web/Socket.IO API**, the same channel the official web editor uses.

The one feature no existing Overleaf MCP can deliver: when a project has **track-changes** enabled, the agent's edits appear as **pending suggestions in the Review panel**, the same way a human collaborator's edits do. You and your collaborators can accept or reject each suggestion. You can also ask the agend to accept/reject them (e.g. *"accept all suggestions about typos"*).

## Why a new MCP

The three existing Overleaf MCPs ([mjyoo2/overleafmcp](https://github.com/mjyoo2/overleafmcp), [YounesBensafia/overleaf-mcp-server](https://github.com/YounesBensafia/overleaf-mcp-server), [GhoshSrinjoy/Overleaf-mcp](https://github.com/GhoshSrinjoy/Overleaf-mcp)) all write through Overleaf's **Git bridge**, which has two problems for collaborative academic work:

1. Commits show up in Overleaf with delay (the bridge polls).
2. Git-bridge writes **bypass tracked changes entirely** — even when track-changes mode is on, edits land as direct overwrites, not as suggestions for review.

The [`overleaf-workshop`](https://github.com/overleaf-workshop/overleaf-workshop) VSCode extension already uses Overleaf's Socket.IO API rather than Git, but doesn't yet emit tracked changes ([issue #94](https://github.com/overleaf-workshop/overleaf-workshop/issues/94)).

`overleaf-mcp` solves both: a minimal Socket.IO 0.9 client over `fetch` + `ws@8`, plus the `meta.tc` ID seed on `applyOtUpdate` that flips Overleaf's server-side `RangesTracker` into track-changes mode.

## Status

Working end-to-end against `overleaf.com` — 16 tools, tracked-changes edits and review-panel comments both verified. Published on npm as [`@netique/overleaf-mcp`](https://www.npmjs.com/package/@netique/overleaf-mcp).

## Tools

| Tool | Description |
|---|---|
| `ping` | Health check. Does not contact Overleaf. |
| `list_projects` | Lists projects on the configured account, sorted by most recently updated. Supports `name_contains`, `include_archived`, `include_trashed`, `limit`. |
| `open_project` | Joins a project's real-time session and caches its file tree. Returns rich metadata: `root_doc_path`, `compiler`, `spell_check_language`, `public_access_level`, owner + members (with privileges), and whether track-changes is on for your user. |
| `list_files` | Lists the file tree of the open project (cached, no network). Filter by `kind` and `path_contains`. |
| `read_file` | Reads a doc (returns text + OT version + a summary of tracked changes / comments) or a binary file (base64 + MIME). `path` is optional — defaults to the project's root doc. |
| `edit_file` | Replaces a doc's contents. Computes a minimal diff via `diff-match-patch`, submits it as an OT operation, and adds `meta.tc` so the edit lands as a pending suggestion in the Review panel by default. Pass `track: "off"` to write directly or `track: "auto"` to honor the project's track-changes setting. `path` is optional — defaults to the project's root doc. |
| `find_and_replace` | Surgical edit: replace one occurrence (or all, with `replace_all: true`) of `old_string` with `new_string` without re-emitting the rest of the doc. Cheaper in tokens than `edit_file` for targeted changes and avoids whitespace drift from re-emitting surrounding text. By default `old_string` must be unique; ambiguous matches return a list of line:col locations so you can extend the match. Same `track` defaults and OT path as `edit_file`, so it lands as a pending suggestion in the Review panel. |
| `list_tracked_changes` | Enumerates every pending tracked-change suggestion across the open project, with author name + email, doc path, op kind (insert/delete), position, op text, change_id. Filter by `author_email`, `author_id_endswith`, `path_contains`, `kind`, `text_contains`, `limit`. |
| `accept_changes` | Accepts one or more tracked changes by `change_id` (from `list_tracked_changes`). Multi-doc groups are batched automatically. Irreversible. |
| `reject_changes` | Rejects one or more tracked changes by `change_id`. Implemented as `applyOtUpdate` with the inverse op + `u:true` (same pathway Overleaf's web client uses). Irreversible. |
| `compile` | Triggers an Overleaf compile and returns a unified summary: `status`, `built_cleanly` (true iff PDF + zero LaTeX errors), `error_count`, `warning_count`, `first_errors` (sample), `output_files`, timings. Already fetches and parses `output.log` inline — no extra `read_log` call needed for the happy path. Pass `root_doc`, `draft`, `stop_on_first_error` to control. |
| `read_log` | Returns the full `output.log` from the most recent compile, with `!`-prefixed error lines surfaced at the top. Use when `compile`'s inline summary isn't enough context. |
| `list_comments` | Lists review-panel comment threads with doc path, quoted text, author, latest-message preview. Supports `include_resolved`, `path_contains`, `full`. |
| `read_comment_thread` | Returns the full message history of one thread. |
| `reply_comment` | Posts a new message to an existing thread. |
| `resolve_comment` | Marks a thread resolved. |
| `reopen_comment` | Reopens a resolved thread. |

## Typical workflow

Things to ask Claude once `overleaf-mcp` is connected:

- _"Accept every pending tracked change by John Doe that's only adjusting punctuation or whitespace."_ — uses `list_tracked_changes(author_email: "...")` → LLM filters by op text → `accept_changes(...)`.
- _"List my recent Overleaf projects."_
- _"Open my thesis project and show me what comments my collaborators have left."_
- _"Read intro.tex and fix the missing comma in the second paragraph."_  → with track-changes on, this lands as a tracked suggestion.
- _"Compile the project and tell me what the LaTeX errors mean."_  → uses `compile` then `read_log` automatically.
- _"For each open comment thread, suggest a fix and reply with what you did."_  → end-to-end review workflow.

## Requirements

- Node ≥ 20
- An Overleaf account (overleaf.com or self-hosted Community Edition)

## Quick start

No local install needed — `npx` fetches and runs the latest version. Add this to your Claude Desktop / Claude Code MCP config:

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "npx",
      "args": ["-y", "@netique/overleaf-mcp"]
    }
  }
}
```

The first MCP tool call (or `npx @netique/overleaf-mcp login` run ahead of time) opens a Chrome window pointed at Overleaf — log in normally and the session cookie is captured and saved to a file under your config dir. No DevTools paste, no cookie in your MCP config. When the cookie expires (~5 days), the next tool call re-opens the window and refreshes it.

For self-hosted Community Edition: set `OL_BASE_URL`:

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "npx",
      "args": ["-y", "@netique/overleaf-mcp"],
      "env": { "OL_BASE_URL": "https://overleaf.mylab.edu" }
    }
  }
}
```

Useful one-shot commands:

```sh
npx @netique/overleaf-mcp login              # opens Chrome, captures cookie
npx @netique/overleaf-mcp status             # who am I logged in as
npx @netique/overleaf-mcp logout --confirm   # clear the saved cookie
```

<details>
<summary>From source (for development)</summary>

```sh
git clone https://github.com/netique/overleaf-mcp.git
cd overleaf-mcp
npm install
npm run build
```

Then point your MCP config at the built file:

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "node",
      "args": ["/absolute/path/to/overleaf-mcp/dist/index.js"]
    }
  }
}
```
</details>

## Authentication

The session cookie lives in a plaintext file at `<configDir>/overleaf-mcp/cookie.json` (mode 0600), where `<configDir>` is `~/Library/Application Support` on macOS, `$XDG_CONFIG_HOME` (or `~/.config`) on Linux, `%APPDATA%` on Windows. The CSRF token is auto-discovered from the `/project` page on each session — no separate copy needed.

### How the cookie gets there

`npx @netique/overleaf-mcp login` — or an MCP tool call that finds no stored cookie — spawns Chrome with a **dedicated browser profile** at `<configDir>/overleaf-mcp/chrome-profile/`, points it at `${OL_BASE_URL}/project`, and reads the session cookie via the Chrome DevTools Protocol once the dashboard loads. Why a dedicated profile:

- We don't touch your real Chrome profile, so there's no macOS Keychain prompt for your everyday browser.
- It's a real interactive Chrome window, so captcha, Google OAuth, ORCID, institutional SSO and 2FA all work out of the box.
- The profile persists. Re-logins are usually a flash: window opens → /project loads → cookie captured → window closes.

When the cookie expires (Overleaf cookies last ~5 days), the next request hits a 302 to `/login`, overleaf-mcp evicts the stale entry, re-launches Chrome and captures a fresh one. If your browser session also expired, the Chrome window waits for you to log in (up to 5 minutes).

Any Chromium-family browser works — Chrome, Brave, Edge, Arc, Chromium. If `findChrome` can't locate one automatically, set `OL_BROWSER` to a binary path.

> ⚠️ The session cookie grants full account access. The cookie file is mode 0600 but plaintext on disk. Treat it like a password. Remove it with `overleaf-mcp logout --confirm`.

### Environment variables

| Var | Default | Notes |
|---|---|---|
| `OL_BASE_URL` | `https://www.overleaf.com` | Override for self-hosted Overleaf. |
| `OL_BROWSER` | auto-detected | Path to a Chromium-family browser if auto-detection fails (Chrome / Brave / Edge / Arc / Chromium). |
| `OL_INSECURE` | — | Set to `1` to pass `--ignore-certificate-errors` to the captured Chrome instance — for self-hosted CE with a self-signed cert. |
| `OL_CSRF` | auto-discovered | Force a specific CSRF token. Only needed if your server doesn't ship the `ol-csrfToken` meta tag. |
| `OL_MCP_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. Goes to stderr; stdout is reserved for MCP JSON-RPC. |

## Troubleshooting

**`OverleafAuthError: Session cookie rejected (redirected to /login)`** — your stored cookie has expired. overleaf-mcp relaunches Chrome automatically on the next tool call to refresh; you should only see this surface as a user-facing error if Chrome itself failed to start.

**`No Chromium-family browser found`** — install Chrome (or Brave/Edge/Arc/Chromium), or set `OL_BROWSER` to a binary path.

**`Socket.IO handshake returned 502`** — Overleaf's load balancer rejected the WebSocket upgrade. Usually means the cookie was rejected — `overleaf-mcp` should auto-recover on the next tool call.

**`Could not find ol-csrfToken meta tag`** — your Overleaf server doesn't expose the CSRF meta tag (rare; mostly very old Community Edition). Set `OL_CSRF` explicitly.

**Edits land but don't show up as tracked suggestions** — confirm track-changes is on for *your user* on this project (Menu → Settings → Track Changes → "For me" or "For everyone"). `open_project` reports the detected state under `track_changes_on_for_me`. To force tracking regardless, pass `track: "on"` to `edit_file`.

**Compile succeeds but `read_log` returns 404** — Overleaf needs `?clsiserverid=...` to route to the right CLSI worker; we add this automatically from the previous compile response. If you see this, the previous compile may not have completed; re-run `compile` and then `read_log`.

## Acknowledgements

- [`overleaf-workshop`](https://github.com/overleaf-workshop/overleaf-workshop) by @iamhyc and contributors — protocol reference for the HTTP + Socket.IO flow, comment thread endpoints. The `94-review-panel` branch was the source for the comment data shapes.
- [`overleaf/overleaf`](https://github.com/overleaf/overleaf) — `libraries/ranges-tracker/index.cjs` and `services/document-updater/RangesManager.js` are the authoritative source for how tracked changes are emitted (the `update.meta.tc` flag and ID seed format).
- [`googlecolab/colab-mcp`](https://github.com/googlecolab/colab-mcp) — UX reference for what an agent-friendly MCP into a hosted editor should feel like.

## License

**AGPL-3.0-or-later** — see [`LICENSE`](./LICENSE).

overleaf-mcp incorporates code ported from two AGPL-3.0 projects (overleaf-workshop and overleaf/overleaf — see Acknowledgements), so the combined work is distributed under the same terms. Practical implications:

- You can use, study, and modify overleaf-mcp freely.
- If you redistribute it, modified or not, recipients must also receive the source under AGPL-3.0.
- If you run a **modified** version as a network service that users interact with, you must make the modified source available to those users. Running unmodified overleaf-mcp as your own personal MCP server is unaffected.
