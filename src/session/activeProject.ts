import { ensureSocketForProject, disconnectActive, getActiveSocket } from "../api/socket.js";
import { flattenTree, isTrackChangesOnForUser, type FlatEntity, type ProjectEntity } from "../api/projectTypes.js";
import type { CompileResponse } from "../api/compileTypes.js";
import { getIdentity } from "./identity.js";
import { clearDocCache } from "./docCache.js";

export interface ActiveProject {
  projectId: string;
  name: string;
  project: ProjectEntity;
  entities: FlatEntity[];
  trackChangesOnForMe: boolean;
  rootDocId?: string;
  rootDocPath?: string;
  lastCompile?: CompileResponse;
}

let active: ActiveProject | null = null;

export function setLastCompile(result: CompileResponse): void {
  if (active) active.lastCompile = result;
}

export function getActiveProject(): ActiveProject | null {
  return active;
}

export type ProjectAccess = "read" | "write";

export type ProjectResolution =
  | { ok: true; ap: ActiveProject; switchedFrom?: ActiveProject }
  | { ok: false; error: string };

interface ProjectSession {
  getActiveProject(): ActiveProject | null;
  open(projectId: string): Promise<ActiveProject>;
}

/**
 * Decides which project a tool call acts on. A gateway may run one server per
 * MCP session, so every project tool accepts an explicit `project_id`. Reads
 * with a different id may switch the active project, but they must never
 * silently retarget writes: a write without `project_id` only proceeds on the
 * project the agent last confirmed — via open_project or a write naming it.
 * Re-opening that project ourselves is not an option: open() clears the doc
 * cache, dropping the stale-read baseline edit_file relies on.
 */
export class ProjectSelector {
  private writeTarget: string | null = null;

  constructor(private readonly session: ProjectSession) {}

  /** open_project: switch and confirm as the write target. */
  async select(projectId: string): Promise<ActiveProject> {
    const ap = await this.session.open(projectId);
    this.writeTarget = ap.projectId;
    return ap;
  }

  /** Throws only when opening an explicitly requested project fails. */
  async resolve(projectId: string | undefined, access: ProjectAccess): Promise<ProjectResolution> {
    const current = this.session.getActiveProject();
    if (!projectId) {
      if (!current) {
        return { ok: false, error: "No project is open in this session. Pass project_id from list_projects or open_project, or call open_project in the same session." };
      }
      if (access === "write" && current.projectId !== this.writeTarget) {
        return {
          ok: false,
          error:
            `Active project changed to "${current.name}" (${current.projectId}) by a read. ` +
            "Pass project_id, or call open_project, to confirm where this edit should go.",
        };
      }
      return { ok: true, ap: current };
    }
    const ap = current?.projectId === projectId ? current : await this.session.open(projectId);
    if (access === "write") this.writeTarget = ap.projectId;
    return { ok: true, ap, switchedFrom: current && current !== ap ? current : undefined };
  }
}

export const projectSelector = new ProjectSelector({ getActiveProject, open });

export async function open(projectId: string): Promise<ActiveProject> {
  const { joinedProject } = await ensureSocketForProject(projectId);
  if (!joinedProject) {
    throw new Error("joinProject did not return a project entity");
  }
  clearDocCache();
  // rootFolder is an array containing the single top-level folder.
  const root = joinedProject.rootFolder?.[0];
  const entities = root ? flattenTree(root) : [];
  const identity = await getIdentity();
  const trackChangesOnForMe = isTrackChangesOnForUser(joinedProject, identity.userId);
  const rootDocId = joinedProject.rootDoc_id;
  const rootDocPath = rootDocId ? entities.find((e) => e.kind === "doc" && e.id === rootDocId)?.path : undefined;
  watchTrackChanges(projectId, identity.userId);
  active = {
    projectId,
    name: joinedProject.name ?? "(unnamed)",
    project: joinedProject,
    entities,
    trackChangesOnForMe,
    rootDocId,
    rootDocPath,
  };
  return active;
}

export function close(): void {
  disconnectActive();
  clearDocCache();
  active = null;
}

export function findByPath(path: string): FlatEntity | undefined {
  if (!active) return undefined;
  const normalized = path.replace(/^\/+/, "");
  return active.entities.find((e) => e.path === normalized);
}

export function docPathById(ap: ActiveProject): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of ap.entities) if (e.kind === "doc") m.set(e.id, e.path);
  return m;
}

/**
 * Replace the project's track-changes state (the `{ [userId | "__guests__"]: boolean }`
 * map the web client keeps in `project.trackChangesState`) and recompute
 * `trackChangesOnForMe`, which decides whether the server forces tracking.
 */
export function applyTrackChangesState(ap: ActiveProject, state: unknown, userId: string): void {
  delete ap.project.track_changes_state;
  ap.project.trackChangesState = state;
  ap.trackChangesOnForMe = isTrackChangesOnForUser(ap.project, userId);
}

// Collaborators can toggle track changes in the browser at any time; the
// real-time service broadcasts the new map as `toggle-track-changes`. Keep our
// copy in sync so edit tools report `tracked` / `track_overridden` truthfully.
const watchedSockets = new WeakSet<object>();
function watchTrackChanges(projectId: string, userId: string): void {
  const socket = getActiveSocket();
  if (!socket || watchedSockets.has(socket)) return;
  watchedSockets.add(socket);
  socket.on("toggle-track-changes", (args) => {
    if (active?.projectId === projectId) applyTrackChangesState(active, args[0], userId);
  });
}
