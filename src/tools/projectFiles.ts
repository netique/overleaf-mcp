// Project and file-tree management: create a project, create docs/folders,
// upload binary files, rename, move and delete entities. Routes and body
// shapes follow services/web/app/src/Features/Editor/EditorRouter.mjs,
// EditorHttpController.mjs and Uploads/UploadsRouter.mjs.

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { asJson, expectOk, olDelete, olPostForm, olPostJson } from "../api/http.js";
import {
  addEntity,
  findByPath,
  folderIdForPath,
  relocateEntity,
  removeEntity,
  rootFolderId,
  type ActiveProject,
} from "../session/activeProject.js";
import { prepareBaseline, submitAndVerify } from "../ot/editPipeline.js";
import { projectIdArg, projectTool, type ToolResponse } from "./project.js";

const fail = (text: string): ToolResponse => ({ content: [{ type: "text", text }], isError: true });
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function splitPath(path: string): { folder: string; name: string } {
  const clean = path.replace(/^\/+|\/+$/g, "");
  const i = clean.lastIndexOf("/");
  return i < 0 ? { folder: "", name: clean } : { folder: clean.slice(0, i), name: clean.slice(i + 1) };
}

// Find the folder for `folderPath`, creating missing levels when asked.
async function ensureFolder(ap: ActiveProject, folderPath: string, create: boolean): Promise<string> {
  const existing = folderIdForPath(ap, folderPath);
  if (existing) return existing;
  if (!create) throw new Error(`Folder '${folderPath}' does not exist. Pass create_parents: true or create it with create_folder.`);
  const { folder: parentPath, name } = splitPath(folderPath);
  const parentId = await ensureFolder(ap, parentPath, true);
  return (await postFolder(ap, name, parentId)).id;
}

async function postFolder(ap: ActiveProject, name: string, parentId: string) {
  const res = await olPostJson(`project/${ap.projectId}/folder`, { name, parent_folder_id: parentId }, {}, { csrfInBody: false });
  const folder = await asJson<{ _id: string; name: string }>(res, "POST /folder");
  return addEntity(ap, "folder", folder._id, folder.name ?? name, parentId);
}

const CreateProjectSchema = z.object({
  name: z.string().min(1).max(150).describe("Name of the new project."),
  template: z
    .enum(["none", "example"])
    .default("none")
    .describe("'none' (default) creates a blank project with a minimal main.tex; 'example' uses Overleaf's example project."),
});

const CreateDocSchema = z.object({
  project_id: projectIdArg,
  path: z.string().min(1).describe("Project-relative path of the new doc, e.g. 'sec/related.tex'."),
  content: z.string().default("").describe("Initial text. Written as a direct (untracked) edit right after creation, like pasting into a new file."),
  create_parents: z.boolean().default(true).describe("Create missing parent folders (default: true)."),
});

const CreateFolderSchema = z.object({
  project_id: projectIdArg,
  path: z.string().min(1).describe("Project-relative path of the new folder, e.g. 'figures/plots'. Missing parents are created."),
});

const UploadSchema = z.object({
  project_id: projectIdArg,
  path: z.string().min(1).describe("Destination path in the project, e.g. 'figures/teaser.pdf'. An existing file at this path is replaced."),
  local_path: z.string().optional().describe("Absolute path of a local file to upload."),
  content_base64: z.string().optional().describe("File content as base64, instead of local_path."),
  create_parents: z.boolean().default(true).describe("Create missing parent folders (default: true)."),
});

const RenameSchema = z.object({
  project_id: projectIdArg,
  path: z.string().min(1).describe("Current project-relative path of the doc, file or folder."),
  new_name: z.string().min(1).describe("New name (not a path; use move_entity to change folders)."),
});

const MoveSchema = z.object({
  project_id: projectIdArg,
  path: z.string().min(1).describe("Project-relative path of the doc, file or folder to move."),
  to_folder: z.string().describe("Destination folder path; '' for the project root."),
});

const DeleteSchema = z.object({
  project_id: projectIdArg,
  path: z.string().min(1).describe("Project-relative path of the doc, file or folder to delete. Folders are deleted with their contents."),
});

export function registerProjectFiles(server: McpServer): void {
  server.registerTool(
    "create_project",
    {
      title: "Create a new Overleaf project",
      description: "Creates a new project owned by the logged-in user and returns its id. Open it with open_project.",
      inputSchema: CreateProjectSchema.shape,
    },
    async (args) => {
      try {
        const res = await olPostJson("project/new", { projectName: args.name, template: args.template }, {}, { csrfInBody: false });
        const body = await asJson<{ project_id: string }>(res, "POST /project/new");
        return {
          content: [{ type: "text", text: `Created project "${args.name}" (${body.project_id}).` }],
          structuredContent: { project_id: body.project_id, name: args.name },
        };
      } catch (err) {
        return fail(`Failed to create project: ${errText(err)}`);
      }
    },
  );

  server.registerTool(
    "create_doc",
    {
      title: "Create a new text doc",
      description: "Creates a new .tex/.bib/... doc at `path`, optionally with initial content. Fails if the path already exists.",
      inputSchema: CreateDocSchema.shape,
    },
    projectTool("write", async (args, ap) => {
      try {
        if (findByPath(args.path)) return fail(`'${args.path}' already exists.`);
        const { folder, name } = splitPath(args.path);
        const parentId = await ensureFolder(ap, folder, args.create_parents);
        const res = await olPostJson(`project/${ap.projectId}/doc`, { name, parent_folder_id: parentId }, {}, { csrfInBody: false });
        const doc = await asJson<{ _id: string; name?: string }>(res, "POST /doc");
        const entity = addEntity(ap, "doc", doc._id, doc.name ?? name, parentId);
        let written = false;
        if (args.content) {
          const base = await prepareBaseline(entity, { strict_version: true });
          if (!base.ok) return base.response;
          await submitAndVerify({
            ap, entity, cached: base.cached, preEditText: "", expectedText: args.content,
            ops: [{ p: 0, i: args.content }], track: "off",
          });
          written = true;
        }
        return {
          content: [{ type: "text", text: `Created doc '${entity.path}'${written ? ` with ${args.content.length} chars` : ""}.` }],
          structuredContent: { path: entity.path, doc_id: entity.id, content_written: written },
        };
      } catch (err) {
        return fail(`Failed to create doc: ${errText(err)}`);
      }
    }),
  );

  server.registerTool(
    "create_folder",
    {
      title: "Create a folder",
      description: "Creates a folder (and any missing parents) at `path`.",
      inputSchema: CreateFolderSchema.shape,
      annotations: { idempotentHint: true },
    },
    projectTool("write", async (args, ap) => {
      try {
        const existed = Boolean(folderIdForPath(ap, args.path));
        const id = await ensureFolder(ap, args.path, true);
        return {
          content: [{ type: "text", text: existed ? `Folder '${args.path}' already exists.` : `Created folder '${args.path}'.` }],
          structuredContent: { path: args.path.replace(/^\/+|\/+$/g, ""), folder_id: id, created: !existed },
        };
      } catch (err) {
        return fail(`Failed to create folder: ${errText(err)}`);
      }
    }),
  );

  server.registerTool(
    "upload_file",
    {
      title: "Upload a binary file (figure, PDF, ...)",
      description:
        "Uploads a file from the local disk (`local_path`) or from base64 (`content_base64`) to `path` in the project, " +
        "replacing an existing file of the same name. Use for figures and other binary assets; use create_doc / edit_file for text.",
      inputSchema: UploadSchema.shape,
    },
    projectTool("write", async (args, ap) => {
      try {
        if (!args.local_path === !args.content_base64) return fail("Pass exactly one of local_path or content_base64.");
        const bytes = args.local_path ? await readFile(args.local_path) : Buffer.from(args.content_base64 ?? "", "base64");
        const { folder, name } = splitPath(args.path);
        const folderId = await ensureFolder(ap, folder, args.create_parents);
        const form = new FormData();
        form.append("name", name);
        form.append("type", "application/octet-stream");
        form.append("qqfile", new Blob([bytes]), args.local_path ? basename(args.local_path) : name);
        const res = await olPostForm(`Project/${ap.projectId}/upload?folder_id=${folderId}`, form);
        const body = await asJson<{ success?: boolean; entity_id?: string; entity_type?: string; error?: string }>(res, "POST /upload");
        if (!body.success || !body.entity_id) return fail(`Upload rejected: ${body.error ?? JSON.stringify(body)}`);
        const kind = body.entity_type === "doc" ? "doc" : "file";
        const entity = addEntity(ap, kind, body.entity_id, name, folderId);
        return {
          content: [{ type: "text", text: `Uploaded ${bytes.length} bytes to '${entity.path}' (${kind}).` }],
          structuredContent: { path: entity.path, entity_id: entity.id, entity_type: kind, bytes: bytes.length },
        };
      } catch (err) {
        return fail(`Failed to upload: ${errText(err)}`);
      }
    }),
  );

  server.registerTool(
    "rename_entity",
    {
      title: "Rename a doc, file or folder",
      description: "Renames the entity at `path` to `new_name`, keeping it in the same folder.",
      inputSchema: RenameSchema.shape,
    },
    projectTool("write", async (args, ap) => {
      try {
        const entity = findByPath(args.path);
        if (!entity) return fail(`Path not found: '${args.path}'.`);
        const res = await olPostJson(`project/${ap.projectId}/${entity.kind}/${entity.id}/rename`, { name: args.new_name }, {}, { csrfInBody: false });
        await expectOk(res, `POST /${entity.kind}/${entity.id}/rename`);
        relocateEntity(ap, entity.id, { name: args.new_name });
        return {
          content: [{ type: "text", text: `Renamed '${args.path}' to '${entity.path}'.` }],
          structuredContent: { old_path: args.path, path: entity.path, id: entity.id, kind: entity.kind },
        };
      } catch (err) {
        return fail(`Failed to rename: ${errText(err)}`);
      }
    }),
  );

  server.registerTool(
    "move_entity",
    {
      title: "Move a doc, file or folder",
      description: "Moves the entity at `path` into the folder `to_folder` ('' for the project root). The folder must exist.",
      inputSchema: MoveSchema.shape,
    },
    projectTool("write", async (args, ap) => {
      try {
        const entity = findByPath(args.path);
        if (!entity) return fail(`Path not found: '${args.path}'.`);
        const folderId = folderIdForPath(ap, args.to_folder) ?? (args.to_folder === "" ? rootFolderId(ap) : undefined);
        if (!folderId) return fail(`Folder not found: '${args.to_folder}'.`);
        const res = await olPostJson(`project/${ap.projectId}/${entity.kind}/${entity.id}/move`, { folder_id: folderId }, {}, { csrfInBody: false });
        await expectOk(res, `POST /${entity.kind}/${entity.id}/move`);
        relocateEntity(ap, entity.id, { parentFolderId: folderId });
        return {
          content: [{ type: "text", text: `Moved '${args.path}' to '${entity.path}'.` }],
          structuredContent: { old_path: args.path, path: entity.path, id: entity.id, kind: entity.kind },
        };
      } catch (err) {
        return fail(`Failed to move: ${errText(err)}`);
      }
    }),
  );

  server.registerTool(
    "delete_entity",
    {
      title: "Delete a doc, file or folder",
      description:
        "Deletes the entity at `path` (a folder with all its contents). Overleaf keeps deleted files in the project history, " +
        "from where they can be restored in the web editor.",
      inputSchema: DeleteSchema.shape,
      annotations: { destructiveHint: true },
    },
    projectTool("write", async (args, ap) => {
      try {
        const entity = findByPath(args.path);
        if (!entity) return fail(`Path not found: '${args.path}'.`);
        if (entity.id === ap.rootDocId) return fail(`'${args.path}' is the project's main document; set another root doc first.`);
        const res = await olDelete(`project/${ap.projectId}/${entity.kind}/${entity.id}`);
        await expectOk(res, `DELETE /${entity.kind}/${entity.id}`);
        removeEntity(ap, entity.id);
        return {
          content: [{ type: "text", text: `Deleted ${entity.kind} '${args.path}'.` }],
          structuredContent: { path: args.path, id: entity.id, kind: entity.kind, deleted: true },
        };
      } catch (err) {
        return fail(`Failed to delete: ${errText(err)}`);
      }
    }),
  );
}
