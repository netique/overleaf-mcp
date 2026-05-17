import { ensureSocketForProject, disconnectActive } from "../api/socket.js";
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
