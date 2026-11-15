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

Working end-to-end against `overleaf.com` — 33 tools, tracked-changes edits and review-panel comments both verified. Published on npm as [`@netique/overleaf-mcp`](https://www.npmjs.com/package/@netique/overleaf-mcp).

## Tools

Every project-scoped tool also takes an optional `project_id` — see [Project selection across MCP sessions](#project-selection-across-mcp-sessions).

| Tool | Description |
|---|---|
| `ping` | Health check. Does not contact Overleaf. |
| `create_project` | Creates a new project (`template: "none"` or `"example"`) and returns its id. |
| `list_projects` | Lists projects on the configured account, sorted by most recently updated. Supports `name_contains`, `include_archived`, `include_trashed`, `limit`. |
| `open_project` | Joins a project's real-time session and caches its file tree. Returns rich metadata: `root_doc_path`, `compiler`, `spell_check_language`, `public_access_level`, owner + members (with privileges), and whether track-changes is on for your user. |
| `list_files` | Lists the file tree of the open project (cached, no network). Filter by `kind` and `path_contains`. |
| `read_file` | Reads a doc (returns text + OT version + a summary of tracked changes / comments) or a binary file (base64 + MIME). `path` is optional — defaults to the project's root doc. |
| `edit_file` | Replaces a doc's contents. Computes a minimal diff via `diff-match-patch`, submits it as an OT operation, and adds `meta.tc` so the edit lands as a pending suggestion in the Review panel by default. Pass `track: "off"` to write directly or `track: "auto"` to honor the project's track-changes setting. `path` is optional — defaults to the project's root doc. |
| `find_and_replace` | Surgical edit: replace one occurrence (or all, with `replace_all: true`) of `old_string` with `new_string` without re-emitting the rest of the doc. Cheaper in tokens than `edit_file` for targeted changes and avoids whitespace drift from re-emitting surrounding text. By default `old_string` must be unique; ambiguous matches return a list of line:col locations so you can extend the match. Same `track` defaults and OT path as `edit_file`, so it lands as a pending suggestion in the Review panel. |
| `create_doc` | Creates a text doc at `path` (missing folders are created), optionally with initial content. |
| `create_folder` | Creates a folder and any missing parents. |
| `upload_file` | Uploads a binary file (figure, PDF, ...) from `local_path` or `content_base64` to `path`, replacing an existing file. |
| `rename_entity` | Renames a doc, file or folder in place. |
| `move_entity` | Moves a doc, file or folder to another folder. |
| `delete_entity` | Deletes a doc, file or folder (folders with their contents). Restorable from Overleaf's history. |
| `list_history` | Lists recent versions from the History view: version range, time, authors, files touched, file add/rename/remove ops, labels. Pages back with `before`; filter with `path_contains`. |
| `diff_file` | Shows what changed in one file between two versions, with `[+inserted+]` / `[-deleted-]` markers and context lines. |
| `list_tracked_changes` | Enumerates every pending tracked-change suggestion across the open project, with author name + email, doc path, op kind (insert/delete), position, op text, change_id. Filter by `author_email`, `author_id_endswith`, `path_contains`, `kind`, `text_contains`, `limit`. |
| `accept_changes` | Accepts tracked changes, selected by `change_id` (from `list_tracked_changes`) or by filters (`author_email`, `path_contains`, `kind`, `text_contains`, combined with AND) or `all: true`. Multi-doc groups are batched automatically. Irreversible. |
| `set_track_changes` | Turns the Review panel's 'Track changes' switch on or off (`on`), for yourself (`scope: "me"`, default) or for every member (`scope: "everyone"`), optionally also for guests. Keeps other users' settings intact and updates `track_changes_on_for_me`. |
| `reject_changes` | Rejects tracked changes, selected by `change_id` or the same filters as `accept_changes`. Implemented as `applyOtUpdate` with the inverse op + `u:true` (same pathway Overleaf's web client uses). Irreversible. |
| `compile` | Triggers an Overleaf compile and returns a unified summary: `status`, `built_cleanly` (true iff PDF + zero LaTeX errors), `page_count`, `error_count`, `warning_count`, `first_errors` (sample), `output_files`, timings. Already fetches and parses `output.log` inline — no extra `read_log` call needed for the happy path. Pass `root_doc`, `draft`, `stop_on_first_error` to control. |
| `label_pages` | After `compile`, reads `output.aux` and lists every `\label` with its number and PDF page, plus the page count. For page-limit and float-placement checks. |
| `read_log` | Returns the full `output.log` from the most recent compile, with `!`-prefixed error lines surfaced at the top. Use when `compile`'s inline summary isn't enough context. |
| `list_comments` | Lists review-panel comment threads with doc path, quoted text, author, latest-message preview. Supports `include_resolved`, `path_contains`, `full`. Orphaned threads (whose doc was deleted, hidden by Overleaf's Review panel) are left out and counted in `hidden_orphaned` unless `include_orphaned: true`. |
| `read_comment_thread` | Returns the full message history of one thread. |
| `add_comment` | Starts a new comment thread anchored to `quoted_text` in a doc, like selecting text and clicking 'Add comment'. The text is not changed. `occurrence` picks one match when the text occurs more than once. |
| `reply_comment` | Posts a new message to an existing thread. |
| `resolve_comment` | Marks a thread resolved. Optional `doc_id` (from `list_comments`) skips the doc lookup. |
| `reopen_comment` | Reopens a resolved thread. Optional `doc_id` (from `list_comments`) skips the doc lookup. |
| `delete_comment` | Permanently deletes a thread and all its messages. |
| `edit_comment_message` | Edits one of your own messages in a thread. |
| `delete_comment_message` | Deletes one message from a thread (own messages; `any_author: true` for the project owner). |
| `search_project` | Searches every doc in the project (plain text or regex, optional case sensitivity, path filter, skip comment lines) and returns `path:line:col` matches. |

## Typical workflow

Things to ask Claude once `overleaf-mcp` is connected:

- _"Accept every pending tracked change by John Doe that's only adjusting punctuation or whitespace."_ — uses `list_tracked_changes(author_email: "...")` → LLM filters by op text → `accept_changes(...)`.
- _"List my recent Overleaf projects."_
- _"Open my thesis project and show me what comments my collaborators have left."_
- _"Read intro.tex and fix the missing comma in the second paragraph."_  → with track-changes on, this lands as a tracked suggestion.
- _"Compile the project and tell me what the LaTeX errors mean."_  → uses `compile` then `read_log` automatically.
- _"For each open comment thread, suggest a fix and reply with what you did."_  → end-to-end review workflow.
- _"Turn on track changes, then proofread sec/intro.tex: fix typos directly and leave a comment wherever a sentence is unclear."_  → `set_track_changes`, `find_and_replace`, `add_comment`.
- _"Where do we cite smith2020 or mention 'domain shift'?"_  → `search_project`.
- _"Compile and tell me on which page the Conclusion ends and where Table 2 lands."_  → `compile`, `label_pages`.
- _"What did my co-author change in sec/method.tex since yesterday?"_  → `list_history`, `diff_file`.
- _"Reject all of Alice's tracked changes in main.bib."_  → `reject_changes(author_email, path_contains)`.

### Project selection across MCP sessions

An HTTP gateway may run a separate stdio server for each MCP session, so a successful
`open_project` in one session does not select a project in another. Every project tool
therefore accepts an optional `project_id`; if your client may reconnect or change
sessions between calls, pass it on every call:

```json
{"name": "read_file", "arguments": {"project_id": "61d853bcbf1003100e957034", "path": "main.tex"}}
```

The tool opens the project when needed and reuses it when it is already active.

Reads may switch projects, but they never silently retarget writes. A write
(`edit_file`, `find_and_replace`, comment replies/resolution, accepting or rejecting
changes) without `project_id` only goes to the project last confirmed by
`open_project` or by a write that named it. After `read_file(project_id=B)` in a
session working on project A, a bare `edit_file` is refused instead of landing in B.
Pass `project_id` (or call `open_project`) to confirm the target. Results include
`project_id` and `project_name`, plus a note whenever a call switched projects.

Omitting `project_id` everywhere keeps the original workflow: call `open_project` first
in the same session. Refresh your client's tool definitions after upgrading to expose
the new parameter.

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

## Releasing

Releases are published to npm automatically by GitHub Actions
(`.github/workflows/publish.yml`), using npm trusted publishing, so no npm token
or `npm login` is involved:

1. Bump the version: `npm version patch --no-git-tag-version` (or `minor` / `major`).
2. Commit `package.json` and `package-lock.json`, then merge to `main`.
3. The workflow runs the type check and tests, publishes the new version to npm
   with provenance, and creates the `vX.Y.Z` tag and GitHub release.

It skips versions that are already on npm, and can also be started manually
from the Actions tab. One-time setup: on npmjs.com, the package's
Settings → Trusted Publisher must list GitHub Actions, repository
`netique/overleaf-mcp`, workflow `publish.yml`.

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
