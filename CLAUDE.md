# CLAUDE.md

Context for Claude (or any future contributor) working in this repo. Read top to bottom — short.

## What this is

`overleaf-mcp` is an MCP server for Overleaf. It speaks Overleaf's Socket.IO web API (the same channel the official editor uses), **not** the Git bridge. The headline feature: edits land as **tracked changes** in Overleaf's Review panel — every other Overleaf MCP punts to the Git bridge and silently overwrites, which makes them unusable for collaborative academic work.

Tools (17): `ping`, `list_projects`, `open_project`, `list_files`, `read_file`, `edit_file`, `find_and_replace`, `compile`, `read_log`, `list_comments`, `read_comment_thread`, `reply_comment`, `resolve_comment`, `reopen_comment`, `list_tracked_changes`, `accept_changes`, `reject_changes`.

## Architecture you should know about before changing things

- **`src/api/socket.ts` is a hand-rolled Socket.IO 0.9 client** built on `fetch` (handshake) + `ws@8` (upgrade). It is **not** using the published [`socket.io-client@0.9.17-overleaf-5`](https://github.com/overleaf/socket.io-client) fork — that fork accepts `extraHeaders` but silently drops them on both transports (its `xmlhttprequest@1.8.0` dep explicitly forbids the `Cookie` header), so the session cookie never reaches the handshake. This is why every other Overleaf MCP falls back to Git. Don't "fix" this by switching to the fork.

- **Tracked changes are triggered server-side by `update.meta.tc`** — a Mongo-ObjectId-style 18-hex-char ID seed on the `applyOtUpdate` payload. Source of truth: [`overleaf/overleaf/libraries/ranges-tracker/index.cjs`](https://github.com/overleaf/overleaf/blob/main/libraries/ranges-tracker/index.cjs) `generateIdSeed`. Ported verbatim into `src/ot/trackedChanges.ts`.

- **Reject is client-side OT**: there's no `/changes/reject` user-facing HTTP endpoint. To reject, we build the inverse op (`d:` for an insert, `i:` for a delete) with `u: true` and send it via `applyOtUpdate`. Server's RangesTracker recognises `u:true` and clears the matching tracked-change entry. Captured live by intercepting Overleaf's web client.

- **Accept is HTTP**: `POST /project/{id}/doc/{docId}/changes/accept` with `{change_ids}`. Batched per doc in `src/tools/trackedChanges.ts`.

- **`edit_file` defaults to `track: "on"`**. For a research workflow the agent should never silently overwrite — every edit goes through the review panel by default. Pass `track: "off"` to opt out. `find_and_replace` shares the same default and the same OT pathway.

- **Stale-cache safety**: `read_file` pins `docCache` to the exact `(text, version)` it returned. `edit_file` diffs against that baseline, so a stale read causes a clean OT transform (or rejection) instead of silent overwrite. There's a manual test for this in `tests/manual/stale-version.mjs`.

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
- `v1_1-followups.mjs <project>` — verifies root-doc-default + inline error_count

## Things not to do without asking

- Don't change `track: "on"` default — collaborators expect to review every agent edit.
- Don't propose wrapper scripts for cookie discovery (e.g. pulling from VSCode storage at runtime) — the user explicitly wants the plaintext-in-config approach until a proper login flow is built.
- Don't add code that bypasses tracked-changes when the project has them enabled.
- Don't switch to the broken `socket.io-client@0.9-overleaf` fork.
