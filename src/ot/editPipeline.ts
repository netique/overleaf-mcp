// Shared pipeline for `edit_file` and `find_and_replace`. The two tools differ
// only in how they compute the OT op list (one diffs `new_content` against the
// cached baseline; the other locates `old_string`, validates uniqueness, and
// builds an op pair). Everything around that — entity resolution, baseline
// freshness checks, OT submit, post-edit verify, cache sync, response notes —
// is identical and lives here.

import { applyOtUpdate, type OtUpdate } from "../api/socket.js";
import { ensureDocLoaded, updateDoc, type CachedDoc } from "../session/docCache.js";
import { findByPath, getActiveProject, type ActiveProject } from "../session/activeProject.js";
import type { FlatEntity } from "../api/projectTypes.js";
import type { ShareJsOp } from "./diff.js";
import { generateIdSeed, resolveTracking, type TrackMode } from "./trackedChanges.js";
import { checkBaseline, verifyEdit, type PostEditVerify } from "./verify.js";

export type EditToolResponse = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

export type ResolvedDoc = { ap: ActiveProject; entity: FlatEntity };

export function resolveDocForEdit(
  path: string | undefined,
): { ok: true; doc: ResolvedDoc } | { ok: false; response: EditToolResponse } {
  const ap = getActiveProject();
  if (!ap) {
    return { ok: false, response: { content: [{ type: "text", text: "No project is open. Call open_project first." }], isError: true } };
  }
  const resolved = path ?? ap.rootDocPath;
  if (!resolved) {
    return { ok: false, response: { content: [{ type: "text", text: "No path provided and the project has no configured root doc. Pass a `path`." }], isError: true } };
  }
  const entity = findByPath(resolved);
  if (!entity) {
    return {
      ok: false,
      response: { content: [{ type: "text", text: `Path not found in project: '${resolved}'. Use list_files to inspect available paths.` }], isError: true },
    };
  }
  if (entity.kind !== "doc") {
    return {
      ok: false,
      response: { content: [{ type: "text", text: `'${resolved}' is a ${entity.kind}, not an editable doc.` }], isError: true },
    };
  }
  return { ok: true, doc: { ap, entity } };
}

export interface BaselineOpts {
  expected_version?: number;
  strict_version: boolean;
}

export async function prepareBaseline(
  entity: FlatEntity,
  opts: BaselineOpts,
): Promise<{ ok: true; cached: CachedDoc } | { ok: false; response: EditToolResponse }> {
  let cached = await ensureDocLoaded(entity.id);
  if (opts.expected_version !== undefined && cached.version !== opts.expected_version) {
    return {
      ok: false,
      response: {
        content: [{ type: "text", text: `Version mismatch: cached version is ${cached.version}, you provided ${opts.expected_version}. Re-read the file and retry.` }],
        isError: true,
      },
    };
  }
  if (opts.strict_version) {
    const bc = await checkBaseline(entity.id, cached.version);
    updateDoc(entity.id, bc.serverText, bc.serverVersion);
    if (bc.stale) {
      return {
        ok: false,
        response: {
          content: [{ type: "text", text: `Stale baseline (strict_version): cached v${cached.version}, server is at v${bc.serverVersion}. The doc was modified by another writer since you last read it. Re-call read_file before retrying.` }],
          isError: true,
          structuredContent: {
            path: entity.path,
            doc_id: entity.id,
            stale_baseline: true,
            cached_version: cached.version,
            server_version: bc.serverVersion,
          },
        },
      };
    }
    cached = { docId: entity.id, text: bc.serverText, version: bc.serverVersion };
  }
  return { ok: true, cached };
}

export interface SubmitOpts {
  ap: ActiveProject;
  entity: FlatEntity;
  cached: CachedDoc;
  preEditText: string;
  expectedText: string;
  ops: ShareJsOp[];
  track: TrackMode;
}

export interface SubmitResult {
  shouldTrack: boolean;
  serverWillTrack: boolean;
  trackOverridden: boolean;
  optimisticVersion: number;
  versionAfter: number;
  trackingNote: string;
  concurrentNote: string;
  verifySkippedNote: string;
  v: PostEditVerify | undefined;
  verifyError: string | undefined;
  silentNoOp: boolean;
}

// Build + emit the OT update, run post-edit verification, sync the cache to
// the server's actual state, and compose the shared response-text notes.
// Tool-specific work (per-tool structuredContent shape, per-tool prose) is
// the caller's responsibility.
export async function submitAndVerify(opts: SubmitOpts): Promise<SubmitResult> {
  const { shouldTrack, serverWillTrack, trackOverridden } = resolveTracking(opts.track, opts.ap.trackChangesOnForMe);
  // Send only `meta.tc` (the tracked-change id seed). Overleaf stamps
  // `source`/`user_id`/`ts` itself from the socket/session — supplying them
  // from the client is redundant and stricter Overleaf versions reject the
  // whole update with "Unrecognized keys: source,ts,user_id".
  const meta: NonNullable<OtUpdate["meta"]> = {};
  if (shouldTrack) meta.tc = generateIdSeed();
  const update: OtUpdate = { doc: opts.entity.id, op: opts.ops, v: opts.cached.version, meta };
  await applyOtUpdate(opts.entity.id, update);
  const optimisticVersion = opts.cached.version + 1;
  const trackingNote = serverWillTrack
    ? (trackOverridden
        ? "Submitted as a tracked change — `track:\"off\"` was overridden because the project has track_changes_on_for_me. The edit lands as a pending suggestion in Overleaf's Review panel."
        : "Submitted as tracked changes — should appear as a pending suggestion in Overleaf's Review panel.")
    : "Submitted as a direct edit (no tracking).";

  let v: PostEditVerify | undefined;
  let verifyError: string | undefined;
  try {
    v = await verifyEdit(opts.entity.id, opts.preEditText, opts.expectedText, optimisticVersion);
  } catch (e) {
    verifyError = e instanceof Error ? e.message : String(e);
  }
  // Sync cache to the server's actual state — even on verify failure we want
  // the next edit to diff against reality rather than our optimistic prediction.
  if (v) updateDoc(opts.entity.id, v.serverText, v.serverVersion);
  else updateDoc(opts.entity.id, opts.expectedText, optimisticVersion);

  const silentNoOp = Boolean(v?.silentNoOp);
  const versionAfter = v ? v.serverVersion : optimisticVersion;
  const concurrentNote = v?.hadConcurrentWritesAfter
    ? ` Note: server is at v${v.serverVersion} (> optimistic v${optimisticVersion}) — another writer landed updates after this edit; your op is in but the doc has moved on.`
    : !v?.matchesExpected && v
      ? ` Note: server text doesn't byte-match the predicted post-edit content (cache synced to actual server state at v${v.serverVersion}); the edit landed but may have been OT-transformed.`
      : "";
  const verifySkippedNote = verifyError ? ` (post-edit verification skipped: ${verifyError})` : "";

  return {
    shouldTrack, serverWillTrack, trackOverridden,
    optimisticVersion, versionAfter,
    trackingNote, concurrentNote, verifySkippedNote,
    v, verifyError, silentNoOp,
  };
}
