// Minimal Socket.IO 0.9 client tailored for Overleaf.
//
// Overleaf's bundled `socket.io-client@0.9.17-overleaf-N` fork accepts an
// `extraHeaders` option but never forwards it to either transport — XMLHttpRequest
// forbids the `Cookie` header and the WebSocket transport calls
// `new WebSocket(url)` with no header argument. That makes the fork unusable
// against overleaf.com from a server-side caller. We instead speak the wire
// protocol ourselves: handshake via `fetch` (cookies propagate naturally),
// upgrade via `ws@8` (which supports a `headers` option).
//
// Protocol reference: https://github.com/learnboost/socket.io-spec (v0.9.x)
// Frame format: `<type>:<id>:<endpoint>:<data>`
//   0 disconnect | 1 connect | 2 heartbeat | 3 message | 4 json
//   5 event { name, args } | 6 ack `:::<id>+<json>` | 7 error
//
// We only implement the subset Overleaf actually emits.

import WebSocket from "ws";

import { OverleafApiError, OverleafAuthError } from "./errors.js";
import { getIdentity, type Identity } from "../session/identity.js";
import { withAuthRetry } from "../session/recovery.js";
import type { ProjectEntity } from "./projectTypes.js";
import { logger } from "../util/logger.js";

export interface OtUpdate {
  doc: string;
  op?: Array<{ p: number; i?: string; d?: string; u?: boolean }>;
  v: number;
  lastV?: number;
  hash?: string;
  meta?: { source: string; ts: number; user_id: string; tc?: string };
}

interface JoinDocResult {
  docLines: string[];
  version: number;
  updates: unknown[];
  ranges: unknown;
}

type EventListener = (args: unknown[]) => void;

interface PendingAck {
  resolve: (data: unknown[]) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

function decodePackedUtf8(line: string): string {
  return Buffer.from(line, "latin1").toString("utf8");
}

function mergeSetCookies(existing: string, responseHeaders: Headers): string {
  // Use undici's getSetCookie when available (Node 22+); fall back to parsing
  // the raw header for Node 20.
  const headersAny = responseHeaders as Headers & { getSetCookie?: () => string[] };
  const raw: string[] = headersAny.getSetCookie?.() ?? [];
  if (!raw.length) {
    const single = responseHeaders.get("set-cookie");
    if (single) raw.push(single);
  }
  const existingNames = new Set(existing.split(";").map((p) => p.split("=")[0].trim().toLowerCase()));
  const adds: string[] = [];
  for (const sc of raw) {
    const first = sc.split(";")[0].trim();
    const name = first.split("=")[0].trim().toLowerCase();
    if (!name || existingNames.has(name)) continue;
    adds.push(first);
    existingNames.add(name);
  }
  if (!adds.length) return existing;
  return `${existing}; ${adds.join("; ")}`;
}

class OverleafSocket {
  private ws: WebSocket | null = null;
  private nextAckId = 1;
  private pending = new Map<number, PendingAck>();
  private listeners = new Map<string, EventListener[]>();
  private heartbeatInterval: number = 60_000;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private closed = false;
  joinedProject: ProjectEntity | null = null;
  publicId: string | null = null;
  permissionsLevel: string | null = null;
  protocolVersion: number | null = null;

  constructor(public readonly projectId: string, public readonly identity: Identity) {}

  async connect(timeoutMs = 15_000): Promise<void> {
    const base = this.identity.baseUrl;
    const t = Date.now();
    const hsUrl = `${base}/socket.io/1/?projectId=${encodeURIComponent(this.projectId)}&t=${t}`;
    const hsRes = await fetch(hsUrl, {
      method: "GET",
      redirect: "manual",
      headers: {
        Cookie: this.identity.cookie,
        Origin: new URL(base).origin,
        Connection: "keep-alive",
      },
    });
    if (hsRes.status >= 300 && hsRes.status < 400) {
      const loc = hsRes.headers.get("location") ?? "";
      if (/\/login(\?|$|\/)/i.test(loc)) {
        throw new OverleafAuthError(`Socket.IO handshake redirected to ${loc} — session expired`);
      }
      throw new OverleafAuthError(`Socket.IO handshake returned ${hsRes.status} -> ${loc}`);
    }
    if (hsRes.status !== 200) {
      const body = await hsRes.text().catch(() => "");
      throw new OverleafAuthError(`Socket.IO handshake returned ${hsRes.status}: ${body.slice(0, 200)}`);
    }
    const hsBody = await hsRes.text();
    const [sid, hbStr, , transports] = hsBody.split(":");
    if (!sid || !transports?.includes("websocket")) {
      throw new OverleafApiError(0, hsBody, "handshake response did not include a sid or websocket transport");
    }
    this.heartbeatInterval = Math.max(15_000, (Number(hbStr) || 60) * 1000 - 5_000);
    // The Overleaf SaaS sits behind a GCP load balancer that pins requests to
    // a backend via a `GCLB` cookie set on the handshake response. The WS
    // upgrade MUST land on the same backend (it carries the in-memory sid),
    // so we extract any Set-Cookie from the handshake and merge it into the
    // Cookie header we send on the upgrade. Without this the upgrade routes
    // randomly and intermittently returns 502.
    const upgradeCookie = mergeSetCookies(this.identity.cookie, hsRes.headers);
    const wsUrl = `${base.replace(/^http/, "ws")}/socket.io/1/websocket/${sid}`;
    const ws = new WebSocket(wsUrl, {
      headers: { Cookie: upgradeCookie, Origin: new URL(base).origin },
      handshakeTimeout: timeoutMs,
    });
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const settleTimer = setTimeout(
        () => reject(new OverleafApiError(0, "", `WebSocket upgrade did not complete within ${timeoutMs}ms`)),
        timeoutMs,
      );
      ws.once("open", () => {
        clearTimeout(settleTimer);
        logger.info(`socket.io connected (sid=${sid})`);
        this.startHeartbeats();
        // joinProjectResponse arrives auto-magically on v2-style URL.
        const once = (args: unknown[]) => {
          const payload = args[0] as
            | {
                publicId?: string;
                project?: ProjectEntity;
                permissionsLevel?: string;
                protocolVersion?: number;
              }
            | undefined;
          if (payload) {
            this.joinedProject = payload.project ?? null;
            this.publicId = payload.publicId ?? null;
            this.permissionsLevel = payload.permissionsLevel ?? null;
            this.protocolVersion = payload.protocolVersion ?? null;
          }
          resolve();
        };
        this.once("joinProjectResponse", once);
        // Some servers (older / v1 path) won't emit joinProjectResponse on the
        // initial WS connect; fall back to emitting joinProject explicitly.
        setTimeout(() => {
          if (!this.joinedProject) {
            logger.info("no joinProjectResponse received, falling back to explicit joinProject emit");
            this.emit<[ProjectEntity, string, number] | ProjectEntity>("joinProject", [{ project_id: this.projectId }])
              .then((ret) => {
                const tuple = Array.isArray(ret) ? ret : [ret];
                const [project, perm, proto] = tuple as [ProjectEntity, string, number];
                this.joinedProject = project ?? null;
                this.permissionsLevel = perm ?? null;
                this.protocolVersion = typeof proto === "number" ? proto : null;
                resolve();
              })
              .catch(reject);
          }
        }, 3_000);
      });
      ws.once("error", (err) => {
        clearTimeout(settleTimer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
      ws.on("message", (data) => this.handleFrame(data.toString("utf8")));
      ws.once("close", (code, reason) => {
        this.stopHeartbeats();
        this.closed = true;
        const r = reason?.toString?.() ?? "";
        logger.warn(`socket closed code=${code} reason=${r}`);
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error(`socket closed (${code}) ${r}`));
        }
        this.pending.clear();
      });
    });
  }

  private startHeartbeats(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try { this.ws.send("2::"); } catch { /* ignore */ }
      }
    }, this.heartbeatInterval);
  }
  private stopHeartbeats(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private handleFrame(frame: string): void {
    if (!frame) return;
    // Parse `<type>:<id>:<endpoint>:<data>`. Data may contain colons, so split
    // only on the first three.
    const m = frame.match(/^(\d+):([^:]*):([^:]*):?([\s\S]*)$/);
    if (!m) {
      logger.debug("ignoring unparseable frame", frame.slice(0, 120));
      return;
    }
    const type = m[1];
    const id = m[2];
    const data = m[4];
    switch (type) {
      case "0": // disconnect
        logger.warn("server sent disconnect frame");
        try { this.ws?.close(); } catch { /* ignore */ }
        return;
      case "1": // connect ack — usually with empty endpoint
        return;
      case "2": // heartbeat from server, echo back
        try { this.ws?.send("2::"); } catch { /* ignore */ }
        return;
      case "5": {
        // Event: `5:<id>[+]::{"name":"event","args":[...]}`
        let obj: { name?: string; args?: unknown[] } = {};
        try { obj = JSON.parse(data); } catch { return; }
        const name = obj.name;
        if (!name) return;
        const args = obj.args ?? [];
        const ls = this.listeners.get(name);
        if (ls) for (const l of ls) try { l(args); } catch (e) { logger.error(`listener for ${name} threw`, e); }
        // Track-changes / reciveNewDoc / etc may also acknowledge with msg id;
        // we ignore that for now since Overleaf doesn't appear to expect a
        // response from us for server-emitted events.
        return;
      }
      case "6": {
        // ACK: `6:::<id>[+<data_json>]`. Note: the "id" field above will be
        // empty for an ack frame; the ack id is at the start of `data`.
        const plus = data.indexOf("+");
        const ackIdStr = plus >= 0 ? data.slice(0, plus) : data;
        const ackDataRaw = plus >= 0 ? data.slice(plus + 1) : "";
        const ackId = Number(ackIdStr);
        const pending = this.pending.get(ackId);
        if (!pending) return;
        this.pending.delete(ackId);
        clearTimeout(pending.timer);
        let arr: unknown[] = [];
        if (ackDataRaw) {
          try { arr = JSON.parse(ackDataRaw); } catch { arr = [ackDataRaw]; }
          if (!Array.isArray(arr)) arr = [arr];
        }
        // Overleaf's ack convention: first element is the error (null on
        // success); remaining elements are the result.
        const err = arr[0];
        if (err) pending.reject(err instanceof Error ? err : new Error(typeof err === "string" ? err : JSON.stringify(err)));
        else pending.resolve(arr.slice(1));
        return;
      }
      case "7": {
        // Type-7 frames are rare and usually mean the server invalidated our
        // session (cookie expired server-side, etc). Reject all pending acks
        // with an OverleafAuthError so the reconnect/retry wrapper picks them
        // up, and close the WS so the next ensureSocketForProject doesn't
        // hand back this broken instance.
        logger.error("server error frame, treating as auth-recoverable", data);
        const authErr = new OverleafAuthError(`server error frame: ${data}`);
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(authErr);
        }
        this.pending.clear();
        this.closed = true;
        try { this.ws?.close(); } catch { /* ignore */ }
        return;
      }
      default:
        return;
    }
  }

  on(event: string, listener: EventListener): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
  }
  once(event: string, listener: EventListener): void {
    const wrap: EventListener = (args) => {
      this.off(event, wrap);
      listener(args);
    };
    this.on(event, wrap);
  }
  off(event: string, listener: EventListener): void {
    const arr = this.listeners.get(event);
    if (!arr) return;
    const i = arr.indexOf(listener);
    if (i >= 0) arr.splice(i, 1);
  }

  async emit<T = unknown>(name: string, args: unknown[] = [], timeoutMs = 15_000): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new OverleafApiError(0, "", "socket not open");
    }
    const ackId = this.nextAckId++;
    const frame = `5:${ackId}+::${JSON.stringify({ name, args })}`;
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(ackId);
        reject(new Error(`event '${name}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(ackId, {
        resolve: (data) => resolve((data.length <= 1 ? data[0] : data) as T),
        reject,
        timer,
      });
      try { this.ws!.send(frame); } catch (e) {
        clearTimeout(timer);
        this.pending.delete(ackId);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  isOpen(): boolean {
    return !this.closed && this.ws?.readyState === WebSocket.OPEN;
  }

  disconnect(): void {
    this.stopHeartbeats();
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.closed = true;
  }
}

let active: OverleafSocket | null = null;

export async function ensureSocketForProject(projectId: string): Promise<{
  socket: OverleafSocket;
  publicId?: string;
  joinedProject?: ProjectEntity;
}> {
  return withAuthRetry(async () => {
    if (active && active.projectId === projectId && active.isOpen()) {
      return { socket: active, publicId: active.publicId ?? undefined, joinedProject: active.joinedProject ?? undefined };
    }
    if (active) {
      logger.info(`switching project: ${active.projectId} -> ${projectId}`);
      active.disconnect();
      active = null;
    }
    const identity = await getIdentity();
    const s = new OverleafSocket(projectId, identity);
    await s.connect();
    active = s;
    return { socket: s, publicId: s.publicId ?? undefined, joinedProject: s.joinedProject ?? undefined };
  });
}

export function getActiveSocket(): OverleafSocket | null {
  return active;
}

// Snapshot the active project, run an emit, and if it fails because the
// socket got torn down (auth-shaped error or "socket closed"), evict the
// cookie if needed, re-establish the socket on the same project, and retry
// the emit exactly once. Callers should pass a prep step (e.g. re-join the
// doc) if the operation requires per-doc state that the new socket lacks.
async function withReconnectingSocket<T>(
  op: () => Promise<T>,
  prep?: () => Promise<void>,
): Promise<T> {
  const projectId = active?.projectId;
  try {
    return await op();
  } catch (err) {
    if (!projectId) throw err;
    const isAuth = err instanceof OverleafAuthError;
    const isClosed = err instanceof Error && /socket closed|socket not open/i.test(err.message);
    if (!isAuth && !isClosed) throw err;
    logger.info(`socket op failed (${(err as Error).message}); reconnecting to project ${projectId}`);
    if (active) {
      try { active.disconnect(); } catch { /* ignore */ }
      active = null;
    }
    // The fresh socket won't have any docs joined, so any cached doc text +
    // version is referring to the old session — clear it so the next caller
    // (or the prep step below) re-fetches from the server.
    const { clearDocCache } = await import("../session/docCache.js");
    clearDocCache();
    if (isAuth) {
      const { evictAndRediscover } = await import("../auth/discover.js");
      const { loadConfig } = await import("../config.js");
      const { clearIdentity } = await import("../session/identity.js");
      clearIdentity();
      await evictAndRediscover(loadConfig().baseUrl);
    }
    await ensureSocketForProject(projectId);
    if (prep) await prep();
    return await op();
  }
}

export async function joinDoc(docId: string): Promise<JoinDocResult> {
  return withReconnectingSocket(async () => {
    if (!active) throw new OverleafApiError(0, "", "no active project — call open_project first");
    // The ack returns `[docLinesAscii, version, updates, ranges]`.
    const ret = await active.emit<[string[], number, unknown[], unknown] | unknown>(
      "joinDoc",
      [docId, { encodeRanges: true }],
    );
    const tuple = Array.isArray(ret) ? ret : [ret];
    const [docLinesAscii, version, updates, ranges] = tuple as [string[], number, unknown[], unknown];
    const docLines = (docLinesAscii ?? []).map(decodePackedUtf8);
    return { docLines, version: version ?? 0, updates: updates ?? [], ranges };
  });
}

export async function leaveDoc(docId: string): Promise<void> {
  // Best-effort; if the socket is gone, the doc is already implicitly left.
  if (!active) return;
  await active.emit("leaveDoc", [docId]).catch(() => undefined);
}

export async function applyOtUpdate(docId: string, update: OtUpdate): Promise<void> {
  await withReconnectingSocket(
    async () => {
      if (!active) throw new OverleafApiError(0, "", "no active project — call open_project first");
      await active.emit("applyOtUpdate", [docId, update]);
    },
    // After a reconnect, the fresh socket has no docs joined. Re-join so the
    // retried applyOtUpdate hits a socket that knows about this doc. Note:
    // joinDoc returns the current version, but our `update.v` was computed
    // against the pre-reconnect version. The server's OT layer either accepts
    // (if the version matches) or rejects with a version-conflict, which we
    // propagate to the caller — same as if the original emit had failed.
    async () => { await joinDoc(docId); },
  );
}

export function disconnectActive(): void {
  if (active) {
    active.disconnect();
    active = null;
  }
}
