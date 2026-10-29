// This boundary uses only Web APIs so the Node desktop and Cloudflare adapters
// share identical capabilities. A URL grants one file operation or one read-only
// preview scope; it never grants MCP, workspace access, or a publication command.
export const CAPABILITY_PARAMETER = "access";
export const FILE_CAPABILITY_TTL_MS = 15 * 60 * 1000;
const encoder = new TextEncoder(), decoder = new TextDecoder();
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
export class FileCapabilityError extends Error {
  constructor(message = "文件访问链接已失效或不允许此操作。") {
    super(message); this.name = "FileCapabilityError"; this.code = "INVALID_FILE_CAPABILITY"; this.status = 403;
  }
}
const reject = () => { throw new FileCapabilityError(); };
function encode(bytes) {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function decode(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) reject();
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (character) => character.charCodeAt(0));
}
function canonicalTarget(url) {
  const query = new URLSearchParams(url.search);
  query.delete(CAPABILITY_PARAMETER); query.sort();
  return url.pathname + (query.size ? "?" + query.toString() : "");
}
function previewPath(url) {
  const match = url.pathname.match(/^\/api\/authoring\/previews\/([^/]+)(.*)$/);
  if (!match || !identifier.test(match[1])) return null;
  const suffix = match[2];
  if (suffix && suffix !== "/pdf" && !/^\/pages\/[1-9][0-9]*\.png$/.test(suffix)
    && !/^\/artifacts\/(authoring|document|identity|report|index|manifest)\.json$/.test(suffix)
    && !/^\/assets-by-hash\/[a-f0-9]{64}$/.test(suffix)
    && !/^\/assets\/.+/.test(suffix)) return null;
  return { id: match[1], suffix };
}
async function withinPreviewScope(claims, url, previewDraftId) {
  const scope = claims.scope;
  if (!["draft", "preview"].includes(scope?.kind) || !identifier.test(scope.id)) return false;
  const query = new URLSearchParams(url.search); query.delete(CAPABILITY_PARAMETER);
  if (url.pathname === "/") return query.size === 1 && query.get(scope.kind) === scope.id;
  if ([...query.keys()].some((key) => !["revision", "width"].includes(key))) return false;
  for (const [key, value] of query) {
    if (query.getAll(key).length !== 1 || !/^[1-9][0-9]*$/.test(value)) return false;
    if (key === "width" && Number(value) > 4000) return false;
  }
  if (scope.kind === "draft" && url.pathname === "/api/authoring/drafts/" + scope.id) return query.size === 0;
  const preview = previewPath(url);
  if (!preview) return false;
  if (scope.kind === "preview") return preview.id === scope.id;
  return typeof previewDraftId === "function" && await previewDraftId(preview.id) === scope.id;
}
function withinUploadScope(scope, url, method) {
  if (scope?.kind !== "upload" || !identifier.test(scope.id)) return false;
  const query = new URLSearchParams(url.search); query.delete(CAPABILITY_PARAMETER);
  if (query.size) return false;
  const base = "/api/uploads/" + scope.id;
  if (method === "DELETE") return url.pathname === base;
  if (method === "POST") return url.pathname === base + "/complete";
  if (method !== "PUT" || !url.pathname.startsWith(base + "/parts/")) return false;
  const part = url.pathname.slice((base + "/parts/").length);
  return /^[1-9][0-9]*$/.test(part) && Number.isSafeInteger(Number(part)) && Number(part) <= 10000;
}

export async function createFileCapabilities({ signingKey, clock = Date.now, ttlMs = FILE_CAPABILITY_TTL_MS, crypto = globalThis.crypto } = {}) {
  if (!crypto?.subtle || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 60 * 60 * 1000) throw new TypeError("Invalid file capability configuration");
  const key = signingKey?.type === "secret" ? signingKey : await crypto.subtle.importKey("raw",
    signingKey || crypto.getRandomValues(new Uint8Array(32)), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return {
    async issue(value, { method = "GET", scope, binding, expiresAt: deadline } = {}) {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.searchParams.has(CAPABILITY_PARAMETER)
        || !["GET", "POST"].includes(method) || (scope && (method !== "GET" || !["draft", "preview", "upload"].includes(scope.kind) || !identifier.test(scope.id)))) reject();
      if (method === "POST" && !(url.pathname === "/api/sources" && url.searchParams.size === 1 && url.searchParams.get("filename"))) reject();
      if (!scope && !grantFor(url, method === "POST" ? "uploadUrl" : "url")) reject();
      if (binding !== undefined && !identifier.test(binding)) reject();
      const now = clock();
      if (deadline !== undefined && (!Number.isSafeInteger(deadline) || deadline <= now)) reject();
      const expiresAt = Math.min(now + ttlMs, deadline ?? Infinity);
      const operation = scope ? ({ draft: "d", preview: "p", upload: "u" })[scope.kind] : method === "POST" ? "w" : "r";
      const identity = scope ? encode(encoder.encode(scope.id)) : "-";
      // Exact file paths and origins are already present in the URL. Authenticate
      // them as HMAC input rather than repeating them inside every MCP response.
      const version = binding ? 2 : 1;
      const signed = JSON.stringify([version, expiresAt, url.origin, operation, scope?.id || canonicalTarget(url), ...(binding ? [binding] : [])]);
      const signature = encode(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(signed))));
      url.searchParams.set(CAPABILITY_PARAMETER, [String(version), expiresAt.toString(36), operation, identity, ...(binding ? [encode(encoder.encode(binding))] : []), signature].join("."));
      return { url: url.href, expiresAt: new Date(expiresAt).toISOString() };
    },
    async verify(value, method, { previewDraftId, authorizeBinding } = {}) {
      try {
        const url = new URL(value), tokens = url.searchParams.getAll(CAPABILITY_PARAMETER);
        if (tokens.length !== 1 || tokens[0].length > 4096) reject();
        const fields = tokens[0].split(".");
        const [version, expiry, operation, identity] = fields, signature = fields.at(-1), expiresAt = Number.parseInt(expiry, 36), now = clock();
        if (!(version === "1" && fields.length === 5 || version === "2" && fields.length === 6) || !Number.isSafeInteger(expiresAt) || expiresAt.toString(36) !== expiry || expiresAt <= now || expiresAt - now > 60 * 60 * 1000 || !["r", "w", "d", "p", "u"].includes(operation)) reject();
        const binding = version === "2" ? decoder.decode(decode(fields[4])) : undefined;
        if (binding !== undefined && !identifier.test(binding)) reject();
        const scopeKind = ({ d: "draft", p: "preview", u: "upload" })[operation];
        const scope = scopeKind ? { kind: scopeKind, id: decoder.decode(decode(identity)) } : undefined;
        if (scope ? !identifier.test(scope.id) : identity !== "-") reject();
        const target = scope?.id || canonicalTarget(url), signed = JSON.stringify([Number(version), expiresAt, url.origin, operation, target, ...(binding ? [binding] : [])]);
        if (!await crypto.subtle.verify("HMAC", key, decode(signature), encoder.encode(signed))) reject();
        const claims = { v: Number(version), origin: url.origin, expiresAt, method: operation === "w" ? "POST" : operation === "u" ? "UPLOAD" : "GET", ...(scope ? { scope } : { target }), ...(binding ? { binding } : {}) };
        if (!(scope?.kind === "upload" ? withinUploadScope(scope, url, method) : claims.method === method || claims.method === "GET" && method === "HEAD")) reject();
        if (claims.scope ? claims.scope.kind !== "upload" && !await withinPreviewScope(claims, url, previewDraftId) : claims.target !== canonicalTarget(url)) reject();
        // Bound grants are invalid outside a server that can check the live run.
        // Existing unbound v1 capabilities retain their original semantics.
        if (binding && (typeof authorizeBinding !== "function" || !await authorizeBinding(binding, url, method))) reject();
        return claims;
      } catch { reject(); }
    },
  };
}

const urlKeys = new Set(["url", "sourceUrl", "imageUrl", "uploadUrl", "previewUrl", "snapshotUrl", "documentUrl", "reportUrl"]);
function grantFor(url, key) {
  if (key === "uploadUrl" && url.pathname === "/api/sources" && url.searchParams.size === 1 && url.searchParams.has("filename")) return { method: "POST" };
  if (url.pathname === "/" && url.searchParams.size === 1) {
    for (const kind of ["draft", "preview"]) if (identifier.test(url.searchParams.get(kind) || "")) return { scope: { kind, id: url.searchParams.get(kind) } };
  }
  const preview = previewPath(url);
  if (preview && !preview.suffix) return { scope: { kind: "preview", id: preview.id } };
  if (/^\/api\/sources\/[^/]+\/original$/.test(url.pathname)
    || /^\/api\/documents\/[^/]+\/assets-by-hash\/[a-f0-9]{64}$/.test(url.pathname)
    || /^\/api\/authoring\/docs\/.+/.test(url.pathname)
    || /^\/api\/documents\/[^/]+\/(assets\/.+|pages\/[1-9][0-9]*\.png|authoring\/(authoring|identity|report|index|editing)\.json)$/.test(url.pathname)
    || preview && /^\/artifacts\//.test(preview.suffix)) return {};
  return null;
}

// Only links resolved by the fixed authoring-documentation catalog may receive
// child grants. Keep the parent's expiry and run binding; following a guide
// must neither renew its access nor turn arbitrary Markdown into capabilities.
export async function decorateDocumentationLinks(resource, { capabilities, baseUrl, parent, authorizeUrl }) {
  if (!resource.body || !resource.documentationLinks?.length) return resource;
  const links = new Map(), origin = new URL(baseUrl).origin;
  for (const target of resource.documentationLinks) {
    const url = new URL(target, baseUrl);
    if (url.origin !== origin || !url.pathname.startsWith("/api/authoring/docs/") || url.search) continue;
    await authorizeUrl?.(url.href, "GET");
    const signed = await capabilities.issue(url.href, { expiresAt: parent.expiresAt, ...(parent.binding ? { binding: parent.binding } : {}) });
    links.set(target, signed.url);
  }
  const body = decoder.decode(resource.body).replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
    (match, label, target) => links.has(target) ? `[${label}](${links.get(target)})` : match);
  return { ...resource, body: encoder.encode(body) };
}

// Decorate only the explicit file/preview URLs already returned by a tool.
// An arbitrary text field, normal reader link, API command, or contract route
// cannot silently acquire a capability. The original result remains unchanged.
export function createMcpFileAccess({ capabilities, baseUrl, binding, authorizeUrl }) {
  const origin = new URL(baseUrl).origin;
  async function decorate(value) {
    let expiry;
    const recordExpiry = (value) => { if (!expiry || value < expiry) expiry = value; };
    async function visit(value) {
    if (Array.isArray(value)) return Promise.all(value.map(visit));
    if (!value || typeof value !== "object") return value;
    const output = {};
    // One grant is reused by every operation in this upload session. The cloud
    // upload adapter additionally checks the session's actual part/byte limits.
    if (identifier.test(value.sessionId || "") && ["partUrlTemplate", "completeUrl", "abortUrl"].every((key) => typeof value[key] === "string")) {
      const paths = { partUrlTemplate: "/api/uploads/" + value.sessionId + "/parts/{part}", completeUrl: "/api/uploads/" + value.sessionId + "/complete", abortUrl: "/api/uploads/" + value.sessionId };
      const urls = Object.fromEntries(Object.keys(paths).map((key) => [key, new URL(value[key], baseUrl)]));
      if (Object.entries(urls).every(([key, url]) => url.origin === origin && decodeURIComponent(url.pathname) === paths[key] && !url.search)) {
        await authorizeUrl?.(urls.partUrlTemplate.href, "PUT");
        const signed = await capabilities.issue(urls.partUrlTemplate.href, { scope: { kind: "upload", id: value.sessionId }, ...(binding ? { binding } : {}) });
        const token = new URL(signed.url).searchParams.get(CAPABILITY_PARAMETER);
        for (const [key, url] of Object.entries(urls)) { url.searchParams.set(CAPABILITY_PARAMETER, token); output[key] = url.href.replaceAll("%7Bpart%7D", "{part}"); }
        recordExpiry(signed.expiresAt);
      }
    }
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(output, key)) continue;
      if (urlKeys.has(key) && typeof item === "string") {
        let url; try { url = new URL(item, baseUrl); } catch { output[key] = item; continue; }
        const grant = url.origin === origin && !url.searchParams.has(CAPABILITY_PARAMETER) ? grantFor(url, key) : null;
        if (grant) {
          await authorizeUrl?.(url.href, grant.method || "GET");
          const signed = await capabilities.issue(url.href, { ...grant, ...(binding ? { binding } : {}) }); output[key] = signed.url; recordExpiry(signed.expiresAt); continue;
        }
      }
      output[key] = await visit(item);
    }
    return output;
    }
    const output = await visit(value);
    // A single earliest expiry covers all URLs in the bounded result, without
    // repeating delivery metadata for every file in a contract or artifact list.
    if (expiry && output && typeof output === "object" && !Array.isArray(output)) Object.assign(output, { authorization: "short-lived-url", accessExpiresAt: expiry });
    return output;
  }
  return { decorate };
}

// The HTTP adapters use this helper after their ordinary full-session check.
// A draft grant intentionally follows future and earlier candidates in only that
// draft until expiry. A frozen-preview grant never follows another candidate.
export async function authorizeFileCapability(capabilities, url, method, workspace, actor, { authorizeBinding } = {}) {
  return capabilities.verify(url, method, { authorizeBinding, previewDraftId: async (id) => {
    if (typeof workspace.previewMetadata === "function") { workspace.authorize(actor); return (await workspace.previewMetadata(id)).draftId; }
    return (await workspace.getAuthoringPreview(actor, id)).preview.draftId;
  } });
}
