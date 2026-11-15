// Toggle Overleaf's "Track changes" mode, the switch at the top of the Review
// panel. The web client posts the whole per-user map to
// `POST /project/:id/track_changes` with `{ on_for: { [userId]: boolean } }`
// (and `on_for_guests`), see review-panel/context/
// track-changes-state-context.tsx. The server then broadcasts the new map as
// the `toggle-track-changes` socket event, which activeProject listens to.
//
// Deliberately limited to the logged-in user's own switch: turning tracking
// off for co-authors or link-sharing guests would let an agent bypass their
// review, so other users' entries and the guests flag are only ever passed
// through unchanged (the endpoint replaces the whole map).

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { expectOk, olPostJson } from "../api/http.js";
import { applyTrackChangesState, type ActiveProject } from "../session/activeProject.js";
import { getIdentity } from "../session/identity.js";
import { projectIdArg, projectTool } from "./project.js";

const Schema = z.object({
  project_id: projectIdArg,
  on: z.boolean().describe("true turns tracked changes on for you, false turns them off for you."),
});

type StateMap = Record<string, boolean | undefined>;

export function currentStateMap(ap: ActiveProject): StateMap {
  const raw = ap.project.trackChangesState ?? ap.project.track_changes_state;
  if (raw && typeof raw === "object") return { ...(raw as StateMap) };
  if (raw === true) {
    // Legacy all-on boolean: expand to every known user so turning one user
    // off doesn't silently turn everyone else off too.
    const m: StateMap = {};
    for (const id of projectUserIds(ap)) m[id] = true;
    return m;
  }
  return {};
}

export function projectUserIds(ap: ActiveProject): string[] {
  const ids = new Set<string>();
  if (ap.project.owner?._id) ids.add(ap.project.owner._id);
  for (const m of ap.project.members ?? []) if (m._id) ids.add(m._id);
  return [...ids];
}

/**
 * Build the `on_for` map the server expects. It replaces the stored map
 * wholesale, so every other user's entry is copied through unchanged and only
 * `me` is set.
 */
export function buildOnFor(current: StateMap, me: string, on: boolean): StateMap {
  const onFor: StateMap = {};
  for (const [k, v] of Object.entries(current)) if (k !== "__guests__") onFor[k] = v;
  onFor[me] = on;
  return onFor;
}

export function registerTrackChangesState(server: McpServer): void {
  server.registerTool(
    "set_track_changes",
    {
      title: "Turn tracked changes on or off",
      description:
        "Turns Overleaf's 'Track changes' mode on or off for the logged-in user only, the same switch as in the Review panel. " +
        "Other collaborators' and guests' settings are left as they are. " +
        "While it is on for you, the server records every edit you make (including `track:\"off\"` edits) as a tracked change. " +
        "Returns the per-user state after the change.",
      inputSchema: Schema.shape,
      annotations: { idempotentHint: true },
    },
    projectTool("write", async (args, ap) => {
      try {
        const me = (await getIdentity()).userId;
        const current = currentStateMap(ap);
        const body: Record<string, unknown> = { on_for: buildOnFor(current, me, args.on) };
        // Pass the guests flag through unchanged, as the web client does.
        if (current.__guests__ !== undefined) body.on_for_guests = current.__guests__;
        const res = await olPostJson(`project/${ap.projectId}/track_changes`, body);
        await expectOk(res, "POST /track_changes");

        const next: StateMap = { ...(body.on_for as StateMap) };
        if (current.__guests__ !== undefined) next.__guests__ = current.__guests__;
        applyTrackChangesState(ap, next, me);

        const state = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined));
        return {
          content: [
            {
              type: "text",
              text: `Track changes is now ${ap.trackChangesOnForMe ? "ON" : "OFF"} for you; other users' settings are unchanged.`,
            },
          ],
          structuredContent: { track_changes_on_for_me: ap.trackChangesOnForMe, state },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Failed to set track changes: ${msg}` }], isError: true };
      }
    }),
  );
}
