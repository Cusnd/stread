import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { attachment } from "./api-router.mjs";

export function nodeRequest(request, url) {
  const value = new Request(url, { method: request.method, headers: request.headers,
    ...(!["GET", "HEAD"].includes(request.method) ? { body: Readable.toWeb(request), duplex: "half" } : {}) });
  value.fileCapability = request.fileCapability;
  return value;
}

export async function sendFetchResponse(response, value) {
  response.writeHead(value.status, Object.fromEntries(value.headers));
  if (value.body) await pipeline(Readable.fromWeb(value.body), response);
  else response.end();
}

export async function localFileResponse(request, resource, { original = false, inline = false, headers = new Headers() } = {}) {
  headers = new Headers(headers);
  const info = resource.body ? { size: resource.body.length } : await stat(resource.path);
  const tag = resource.sha256 ? '"' + resource.sha256 + '"' : undefined;
  headers.set("Content-Type", resource.mediaType); headers.set("Content-Length", String(info.size));
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cache-Control", request.fileCapability ? "no-store" : "private, max-age=0, must-revalidate");
  if (tag) headers.set("ETag", tag);
  if (original) {
    headers.set("Content-Security-Policy", "sandbox; default-src 'none'; frame-ancestors 'self'");
    if (inline) headers.set("Content-Disposition", "inline");
    else if (!/^image\/(png|jpeg|gif|webp)$/.test(resource.mediaType) && resource.mediaType !== "application/pdf") headers.set("Content-Disposition", attachment(resource.filename || "source"));
  }
  if (tag && request.headers.get("if-none-match") === tag) { headers.delete("Content-Length"); return new Response(null, { status: 304, headers }); }
  return new Response(request.method === "HEAD" ? null : resource.body || Readable.toWeb(createReadStream(resource.path)), { headers });
}
