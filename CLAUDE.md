# CLAUDE.md

Context for Claude (or any future contributor) working in this repo. Read top to bottom — short.

## What this is

`overleaf-mcp` is an MCP server for Overleaf. It speaks Overleaf's Socket.IO web API (the same channel the official editor uses), **not** the Git bridge. The headline feature: edits land as **tracked changes** in Overleaf's Review panel — every other Overleaf MCP punts to the Git bridge and silently overwrites, which makes them unusable for collaborative academic work.

Tools (23): `ping`, `list_projects`, `open_project`, `list_files`, `read_file`, `edit_file`, `find_and_replace`, `search_project`, `compile`, `read_log`, `list_comments`, `read_comment_thread`, `add_comment`, `reply_comment`, `edit_comment_message`, `delete_comment_message`, `resolve_comment`, `reopen_comment`, `delete_comment`, `list_tracked_changes`, `accept_changes`, `reject_changes`, `set_track_changes`.

## Architecture you should know about before changing things

- **`src/api/socket.ts` is a hand-rolled Socket.IO 0.9 client** built on `fetch` (handshake) + `ws@8` (upgrade). It is **not** using the published [`socket.io-client@0.9.17-overleaf-5`](https://github.com/overleaf/socket.io-client) fork — that fork accepts `extraHeaders` but silently drops them on both transports (its `xmlhttprequest@1.8.0` dep explicitly forbids the `Cookie` header), so the session cookie never reaches the handshake. This is why every other Overleaf MCP falls back to Git. Don't "fix" this by switching to the fork.

- **`update.meta` may contain `tc` and nothing else.** The real-time service validates the `applyOtUpdate` payload with a zod schema ([`services/real-time/app/js/Router.js`](https://github.com/overleaf/overleaf/blob/main/services/real-time/app/js/Router.js)) and sets `meta.source` / `meta.user_id` / `meta.tsRT` itself from the socket and session. Sending those keys ourselves used to be silently ignored; overleaf.com now rejects the whole update with `Unrecognized keys: "source", "ts", "user_id"` **and disconnects the socket 100 ms later**. The official web client only ever sets `meta.tc` ([`share-js-doc.ts`](https://github.com/overleaf/overleaf/blob/main/services/web/frontend/js/features/ide-react/editor/share-js-doc.ts)) — mirror it exactly, and send no `meta` at all when not tracking. Note the OSS mirror lags www here, so `main` looking permissive is not evidence.

- **Tracked changes are triggered server-side by `update.meta.tc`** — a Mongo-ObjectId-style 18-hex-char ID seed on the `applyOtUpdate` payload. Source of truth: [`overleaf/overleaf/libraries/ranges-tracker/index.cjs`](https://github.com/overleaf/overleaf/blob/main/libraries/ranges-tracker/index.cjs) `generateIdSeed`. Ported verbatim into `src/ot/trackedChanges.ts`. **And** the server independently forces tracking for any user with `track_changes_on_for_me: true` — even if our client sent no `meta.tc`. So `track:"off"` is *not* a guarantee the edit lands untracked; check `ap.trackChangesOnForMe`. `edit_file` / `find_and_replace` already do, and report `tracked: true` in that case via a `serverWillTrack` derived field, plus a `track_overridden` flag when the user's request was overridden.

- **Tracked deletes physically remove text from `docLines`.** Per the ranges-tracker source comment: *"deletes correspond to text which is no longer there"*. The deleted text is preserved in `ranges.changes[].op.d` (which is how the Review panel renders the strikethrough), but the visible doc body shrinks. So `new_content` written to docCache after a tracked edit IS a faithful snapshot of the post-edit server state — no special cache handling is needed, and `read_file` does not need a "deleted text still here" notice. A common misreading is to assume tracked deletes leave the original text in place; they don't.

- **Reject is client-side OT**: there's no `/changes/reject` user-facing HTTP endpoint. To reject, we build the inverse op (`d:` for an insert, `i:` for a delete) with `u: true` and send it via `applyOtUpdate`. Server's RangesTracker recognises `u:true` and clears the matching tracked-change entry. Captured live by intercepting Overleaf's web client.

- **Comments are created in two steps** (mirrors `addComment` in the web client's `review-panel/context/threads-context.tsx`): `POST /project/{id}/thread/{threadId}/messages` with a fresh 24-hex thread id (`generateIdSeed() + "000001"`, same as `RangesTracker.generateId`), then an `applyOtUpdate` whose op is `{ c: quotedText, p, t: threadId }`. The comment op changes no text but bumps the doc version. If the op fails, `add_comment` deletes the thread again so it doesn't linger as an orphan. A thread whose anchor text is later deleted becomes orphaned: `/threads` still returns it but no doc's `/ranges` references it, and the Review panel hides it. `list_comments` does the same by default.

- **Track-changes toggle is HTTP + socket**: `POST /project/{id}/track_changes` with `{ on_for: { [userId]: bool }, on_for_guests? }` replaces the whole per-user map (see `track-changes-state-context.tsx`), so `set_track_changes` always sends the existing map with only the requested entries changed. The server broadcasts the new map as the `toggle-track-changes` socket event; `activeProject` listens and keeps `trackChangesOnForMe` current, including when a collaborator flips the switch in the browser.

- **Accept is HTTP**: `POST /project/{id}/doc/{docId}/changes/accept` with `{change_ids}`. Batched per doc in `src/tools/trackedChanges.ts`.

- **`edit_file` defaults to `track: "on"`**. For a research workflow the agent should never silently overwrite — every edit goes through the review panel by default. Pass `track: "off"` to opt out. `find_and_replace` shares the same default and the same OT pathway.

- **Stale-cache safety**: `read_file` pins `docCache` to the exact `(text, version)` it returned. `edit_file` diffs against that baseline, so a stale read causes a clean OT transform (or rejection) instead of silent overwrite. There's a manual test for this in `tests/manual/stale-version.mjs`.

- **Concurrency safeguards (`src/ot/verify.ts`)**: each MCP process has its own in-process `docCache`, so parallel agents (or an open OL web editor) race on `applyOtUpdate` with stale `v`. The server's OT transform usually handles this fine, but it can collapse ops to a no-op while still acking success — the user-reported "find_and_replace returned replacements:1 but the doc is unchanged" bug. Two safeguards: (a) `verifyEdit` runs after every `applyOtUpdate` — re-`joinDocs` and reports `silentNoOp` (server text === pre-edit text → fail loud), `matchesExpected` (perfect, no race), or `hadConcurrentWritesAfter` (op landed but doc moved on → warn in response, don't fail). Cache is always synced to actual server state regardless. (b) `checkBaseline` is invoked when `strict_version: true` is passed — refuses to send if the cached `v` is behind the server. Both add one socket round-trip; for the workflow this MCP targets the cost is negligible compared to silently producing wrong edits.

- **Project targeting (`ProjectSelector` in `src/session/activeProject.ts`)**: every project tool takes an optional `project_id` (gateways may run one server per MCP session, so `open_project` state doesn't carry over). A read naming another project switches the active project, but a write *without* `project_id` is refused unless the active project is the confirmed write target (set by `open_project` or a write naming it). Don't "fix" a refusal by auto-reopening the old project — `open()` clears `docCache`, silently dropping the stale-read baseline. Tools opt in via `projectTool("read" | "write", handler)` in `src/tools/project.ts`.

- **`compile.status === "success"` is misleading** — Overleaf returns it whenever a PDF is generated, even with LaTeX errors (TeX runs in `nonstopmode`). Truthful check is `compile.built_cleanly` (PDF + zero `! `-prefixed log lines). `compile` already fetches `output.log` inline; `read_log` is for deeper inspection.

## License & contribution

**AGPL-3.0-or-later.** We port from two AGPL projects (overleaf-workshop and overleaf/overleaf — see `LICENSE`). If you add code derived from a different license, check compatibility before merging.

## Auth & running

Cookie capture is via a dedicated headless-ish Chrome profile, driven over the Chrome DevTools Protocol — `node dist/index.js login` opens a window pointing at `<OL_BASE_URL>/project`, user logs in normally (captcha / Google OAuth / ORCID / institutional SSO / 2FA all work because it's a real Chrome), cookie is read via `Network.getCookies` once the dashboard loads, persisted to `<configDir>/overleaf-mcp/cookie.json` (mode 0600). The same flow auto-triggers when a tool call hits a 302→/login or 401/403. Dedicated profile means we never touch the user's real Chrome and never trigger a macOS Keychain prompt for it. `OL_BASE_URL` defaults to `https://www.overleaf.com`; `OL_BROWSER` overrides the Chrome binary path; `OL_INSECURE=1` adds `--ignore-certificate-errors` for self-hosted CE with self-signed certs; `OL_CSRF` is optional (auto-discovered from `/project` HTML's `ol-csrfToken` meta).

## Tests

`tests/manual/*.mjs` are end-to-end smoke + edge-case scripts. They spawn the built `dist/index.js` as a child process and drive it over stdio. None require CI infra; all need a cookie file (run `node dist/index.js login` first). Highlights:

- `smoke.mjs <tool>` — single-tool invocation
- `sequence.mjs <project> [doc]` — open→list→read flow
- `tracked-test.mjs <project> <doc>` — verifies `meta.tc` produces a Review-panel suggestion
- `stale-version.mjs <project> [doc]` — two concurrent MCP clients
- `multiop-edit.mjs <project> [doc]` — confirms diff-match-patch produces multi-op updates
- `compile-fix.mjs <project> [doc]` — compile → error log → fix → recompile loop
- `accept-reject.mjs <project>` — list_tracked_changes → accept 1 → reject 1
- `review-tools.mjs <project> [doc]` — set_track_changes round trip (checked from a second client), add_comment → reply → edit/delete message → delete_comment, search_project. Restores the project afterwards.
- `v1_1-followups.mjs <project>` — verifies root-doc-default + inline error_count

## Things not to do without asking

- Don't change `track: "on"` default — collaborators expect to review every agent edit.
- Don't propose wrapper scripts for cookie discovery (e.g. pulling from VSCode storage at runtime) — the user explicitly wants the plaintext-in-config approach until a proper login flow is built.
- Don't add code that bypasses tracked-changes when the project has them enabled.
- Don't switch to the broken `socket.io-client@0.9-overleaf` fork.
