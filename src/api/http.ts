import { getIdentity } from "../session/identity.js";
import { withAuthRetry } from "../session/recovery.js";
import { OverleafApiError, OverleafAuthError } from "./errors.js";

function joinUrl(base: string, path: string): string {
  return `${base}/${path.replace(/^\/+/, "")}`;
}

function throwIfAuthBad(res: Response): void {
  if (res.status === 401 || res.status === 403) {
    throw new OverleafAuthError(`HTTP ${res.status} on ${res.url || "request"}`);
  }
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location") ?? "";
    if (/\/login(\?|$|\/)/i.test(loc)) {
      throw new OverleafAuthError(`redirected to ${loc} — session expired`);
    }
  }
}

export async function olGet(path: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return withAuthRetry(async () => {
    const id = await getIdentity();
    const res = await fetch(joinUrl(id.baseUrl, path), {
      method: "GET",
      redirect: "manual",
      headers: { Cookie: id.cookie, Connection: "keep-alive", ...extraHeaders },
    });
    throwIfAuthBad(res);
    return res;
  });
}

export interface PostOptions {
  // Newer Overleaf routes validate the body with z.strictObject and reject the
  // legacy `_csrf` body field; the header alone is enough for them (it is all
  // the web client sends). Default true keeps the existing routes unchanged.
  csrfInBody?: boolean;
}

export async function olPostJson(
  path: string,
  body: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {},
  options: PostOptions = {},
): Promise<Response> {
  return withAuthRetry(async () => {
    const id = await getIdentity();
    const res = await fetch(joinUrl(id.baseUrl, path), {
      method: "POST",
      redirect: "manual",
      headers: {
        Cookie: id.cookie,
        Connection: "keep-alive",
        "Content-Type": "application/json",
        "X-Csrf-Token": id.csrf,
        ...extraHeaders,
      },
      body: JSON.stringify(options.csrfInBody === false ? body : { _csrf: id.csrf, ...body }),
    });
    throwIfAuthBad(res);
    return res;
  });
}

// multipart/form-data POST (file uploads). fetch sets the boundary header.
export async function olPostForm(path: string, form: FormData): Promise<Response> {
  return withAuthRetry(async () => {
    const id = await getIdentity();
    const res = await fetch(joinUrl(id.baseUrl, path), {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: id.cookie, Connection: "keep-alive", "X-Csrf-Token": id.csrf },
      body: form,
    });
    throwIfAuthBad(res);
    return res;
  });
}

export async function olDelete(path: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return withAuthRetry(async () => {
    const id = await getIdentity();
    const res = await fetch(joinUrl(id.baseUrl, path), {
      method: "DELETE",
      redirect: "manual",
      headers: {
        Cookie: id.cookie,
        Connection: "keep-alive",
        "X-Csrf-Token": id.csrf,
        ...extraHeaders,
      },
    });
    throwIfAuthBad(res);
    return res;
  });
}

export async function expectOk(res: Response, hint?: string): Promise<Response> {
  if (res.ok) return res;
  // Defensive: primitives above already throw on auth-bad responses, but a
  // caller that constructed its own fetch (or bypassed throwIfAuthBad) still
  // benefits from the same classification here.
  throwIfAuthBad(res);
  const body = await res.text().catch(() => "");
  throw new OverleafApiError(res.status, body, hint);
}

export async function asJson<T = unknown>(res: Response, hint?: string): Promise<T> {
  await expectOk(res, hint);
  return (await res.json()) as T;
}
