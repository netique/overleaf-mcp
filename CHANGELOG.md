# Changelog

Notable changes to `@netique/overleaf-mcp`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Add new entries under
**Unreleased**; at release time that section is renamed to the new version, and
its text becomes the GitHub release notes. For releases before 0.4.0, see the
[git history](https://github.com/netique/overleaf-mcp/commits/main).

## [Unreleased]

## [0.4.0] - 2026-11-15

The agent can now do a full co-authoring round on its own. It can turn on track
changes, leave comments, manage files and figures, see what a collaborator
changed, and check page limits. The tool count goes from 17 to 33. Thanks to
[@Tobias-Fischer](https://github.com/Tobias-Fischer) for the contribution
([#13](https://github.com/netique/overleaf-mcp/pull/13), closes
[#12](https://github.com/netique/overleaf-mcp/issues/12)).

### Added

- **Review workflow**
  - `set_track_changes` turns the Review panel's "Track changes" switch on or
    off for the logged-in user only. Collaborators' and guests' settings are
    never changed.
  - `add_comment` starts a new comment thread on a piece of text, with
    `occurrence` to pick between repeated matches.
  - `delete_comment`, `edit_comment_message` and `delete_comment_message` round
    out the comment tools.
  - `accept_changes` and `reject_changes` can select changes by filter (author,
    path, kind, text) or with `all: true`, as well as by `change_ids`. Mixing
    ids with filters is refused, so a typo in a filter can never widen an
    explicit list.
- **Files and projects**
  - New tools: `create_project`, `create_doc` (optionally with content, and
    creating missing parent folders), `create_folder`, `upload_file` (figures,
    PDFs and other binaries), `rename_entity`, `move_entity` and
    `delete_entity`.
- **History, search and page checks**
  - `list_history` and `diff_file` show what changed and who changed it, using
    the History view's data.
  - `search_project` does a plain or regex search across every doc, with
    `path:line:col` results.
  - `compile` now reports `page_count`.
  - `label_pages` maps every `\label` to its number and PDF page, for
    page-limit and float-placement checks.

### Changed

- `list_comments` flags comment threads whose doc was deleted ("orphaned") and
  hides them by default, as the Review panel does. Pass `include_orphaned` to
  see them. `resolve_comment`, `reopen_comment` and `delete_comment` work on
  orphaned threads too.
- The cached file tree now follows collaborators' changes: new, renamed, moved
  and deleted files are picked up live, and `open_project` always fetches the
  current tree. Before, after a collaborator renamed a doc and created a new
  one at the same path, edits could land in the wrong doc.
- The server's track-changes state stays in sync when a collaborator flips the
  switch in the browser, so `edit_file` and `find_and_replace` report `tracked`
  correctly.

### Security

- `upload_file` reads a `local_path` only inside the client's MCP roots or the
  directories listed in the new `OL_UPLOAD_DIRS` environment variable.
  - Symlinks are resolved before the check.
  - Dotfiles and dot-directories (`.ssh`, `.env`, …) are always refused.
  - With no allowed directories configured, only `content_base64` uploads
    work.

  This keeps a prompt injection in a document or comment from uploading local
  secrets into a shared project.

### Upgrading

- To upload figures from disk with a client that doesn't send MCP roots, set
  `OL_UPLOAD_DIRS` to the folders the agent may upload from, separated by `:`
  (`;` on Windows).
- Refresh your client's tool list after updating, so the 16 new tools appear.

[Unreleased]: https://github.com/netique/overleaf-mcp/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/netique/overleaf-mcp/compare/v0.3.8...v0.4.0
