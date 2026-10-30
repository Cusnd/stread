import { randomUUID } from "node:crypto";
import { check, fail } from "./errors.mjs";
import { MAX_SOURCE_BYTES } from "./resource-types.mjs";
import { matchesRepresentation, representationTag } from "./http-representation.mjs";
export const attachment = (filename) => "attachment; filename*=UTF-8''" + encodeURIComponent(filename).replaceAll("'", "%27");
const decode = (value) => { try { return decodeURIComponent(value); } catch { fail("VALIDATION_FAILED", "URL 编码无效。"); } };
function integerParameter(url, name) {
  const input = url.searchParams.get(name); if (input === null) return undefined;
  check(/^[0-9]+$/.test(input) && Number.isSafeInteger(Number(input)) && Number(input) > 0, "VALIDATION_FAILED", `${name} 必须为正整数。`); return Number(input);
}
export async function readJson(request, maximum = 4 * 1024 * 1024) {
  check(request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/json", "UNSUPPORTED_MEDIA_TYPE", "此操作需要 JSON 请求。", 415);
  const chunks = []; let size = 0;
  for await (const chunk of request.body || []) { size += chunk.byteLength; check(size <= maximum, "REQUEST_TOO_LARGE", "请求内容超过限制。", 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { fail("INVALID_JSON", "请求 JSON 无法解析。"); }
}
// The Fetch router contains only protocol adaptation. All commands and queries
// go through the same Workspace used by the local Node service and MCP tools.
export async function handleWorkspaceApi(request, { workspace, actor, fileResponse, documentationResponse, headers = new Headers(), maximumUploadBytes = MAX_SOURCE_BYTES }) {
  const url = new URL(request.url), pathname = url.pathname;
  if (request.method === "GET") {
    const tag = await representationTag(workspace, actor, url);
    if (tag) {
      headers.set("ETag", tag);
      if (matchesRepresentation(request.headers.get("if-none-match"), tag)) return new Response(null, { status: 304, headers: { ...Object.fromEntries(headers), "Cache-Control": "private, no-cache" } });
    }
  }
  const response = { setHeader: (name, value) => headers.set(name, value) };
  const sendJson = (_response, status, value) => new Response(JSON.stringify(value), { status, headers: { ...Object.fromEntries(headers), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  const sendFile = (request, _response, resource, options) => fileResponse(request, resource, { ...options, headers });
  const jsonBody = readJson;
  if (pathname === "/api/sources" && request.method === "POST") check(Number(request.headers.get("content-length")) <= maximumUploadBytes, "UPLOAD_TOO_LARGE", "请改用分块上传。", 413);
      if (pathname === "/api/workspace" && request.method === "GET") return sendJson(response, 200, await workspace.query(actor, { kind: "workspace", includeArchived: url.searchParams.get("includeArchived") === "1" }));
      if (pathname === "/api/queue" && request.method === "GET") {
        const query = { kind: "queue" };
        for (const key of ["type", "status", "query"]) if (url.searchParams.has(key)) query[key] = url.searchParams.get(key);
        for (const key of ["offset", "limit"]) if (url.searchParams.has(key)) {
          const value = url.searchParams.get(key);
          check(/^[0-9]+$/.test(value) && Number.isSafeInteger(Number(value)), "VALIDATION_FAILED", `${key} 必须为整数。`);
          query[key] = Number(value);
        }
        return sendJson(response, 200, await workspace.query(actor, query));
      }
      const queueTask = pathname.match(/^\/api\/queue\/([^/]+)$/);
      if (queueTask && request.method === "GET") {
        const result = await workspace.query(actor, { kind: "queue", taskId: decode(queueTask[1]) });
        check(result.tasks[0], "NOT_FOUND", "没有找到这项任务。", 404);
        return sendJson(response, 200, { task: result.tasks[0], revision: result.revision });
      }
      const flowInsight = pathname.match(/^\/api\/flow\/insights\/([^/]+)$/);
      if (flowInsight && request.method === "GET") return sendJson(response, 200, await workspace.query(actor, { kind: "flow.insight", insightId: decode(flowInsight[1]) }));
      const flowQuery = pathname.match(/^\/api\/flow\/(summary|insights|history)$/);
      if (flowQuery && request.method === "GET") {
        const query = { kind: `flow.${flowQuery[1]}` };
        for (const key of ["timezone", "from", "to", "type", "review", "question", "documentId", "query"]) if (url.searchParams.has(key)) query[key] = url.searchParams.get(key);
        for (const key of ["offset", "limit", "days"]) if (url.searchParams.has(key)) {
          const value = url.searchParams.get(key);
          check(/^[0-9]+$/.test(value), "VALIDATION_FAILED", `${key} 必须为整数。`);
          query[key] = Number(value);
        }
        return sendJson(response, 200, await workspace.query(actor, query));
      }
      if (pathname === "/api/commands" && request.method === "POST") return sendJson(response, 200, await workspace.execute(actor, await jsonBody(request)));
      if (pathname === "/api/changes" && request.method === "GET") return sendJson(response, 200, await workspace.query(actor, { kind: "changes", after: Number(url.searchParams.get("after") || 0) }));
      if (pathname === "/api/proposals" && request.method === "GET") return sendJson(response, 200, await workspace.query(actor, { kind: "proposals" }));
      if (pathname === "/api/sources" && request.method === "POST") {
        check(!request.headers.get("content-length") || Number(request.headers.get("content-length")) <= MAX_SOURCE_BYTES, "UPLOAD_TOO_LARGE", "文件超过 100 MiB 限制。", 413);
        return sendJson(response, 201, await workspace.upload(actor, request.body, { size: Number(request.headers.get("content-length")), filename: url.searchParams.get("filename"), mediaType: request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() }));
      }
      if (pathname === "/api/sources" && request.method === "GET") return sendJson(response, 200, await workspace.uploadedSources(actor, {
        query: url.searchParams.get("query") ?? undefined, filename: url.searchParams.get("filename") ?? undefined,
        offset: url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : 0, limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 10,
      }));
      const uploadedSource = pathname.match(/^\/api\/sources\/([^/]+)(\/original)?$/);
      if (uploadedSource && ["GET", "HEAD"].includes(request.method)) {
        const sourceId = decode(uploadedSource[1]);
        if (uploadedSource[2]) return await sendFile(request, response, await workspace.uploadedSourceResource(actor, sourceId), { original: true });
        return sendJson(response, 200, await workspace.uploadedSource(actor, sourceId));
      }
      const uploadedSourcePage = pathname.match(/^\/api\/sources\/([^/]+)\/pages\/([0-9]+)\.png$/);
      if (uploadedSourcePage && ["GET", "HEAD"].includes(request.method)) return await sendFile(request, response,
        await workspace.uploadedSourcePage(actor, decode(uploadedSourcePage[1]), Number(uploadedSourcePage[2]), integerParameter(url, "width") ?? 600));
      if (pathname === "/api/authoring/contract" && request.method === "GET") return sendJson(response, 200, await workspace.getAuthoringContract(actor, url.searchParams.get("sourceId") ?? undefined));
      const authoringDoc = pathname.match(/^\/api\/authoring\/docs\/(.+)$/);
      if (authoringDoc && ["GET", "HEAD"].includes(request.method)) {
        const resource = await workspace.getAuthoringDocumentation(actor, decode(authoringDoc[1]));
        return await sendFile(request, response, documentationResponse ? await documentationResponse(resource) : resource, { original: true });
      }
      if (pathname === "/api/authoring/validate" && request.method === "POST") return sendJson(response, 200, await workspace.validateAuthoring(actor, await jsonBody(request)));
      if (pathname === "/api/authoring/publish" && request.method === "POST") return sendJson(response, 201, await workspace.publishAuthoring(actor, await jsonBody(request)));
      if (pathname === "/api/authoring/previews" && request.method === "POST") return sendJson(response, 201, await workspace.createAuthoringPreview(actor, await jsonBody(request)));
      if (pathname === "/api/authoring/previews/publish" && request.method === "POST") return sendJson(response, 201, await workspace.publishAuthoringPreview(actor, await jsonBody(request)));
      const draft = pathname.match(/^\/api\/authoring\/drafts\/([^/]+)$/);
      if (draft && request.method === "GET") return sendJson(response, 200, await workspace.getAuthoringDraft(actor, decode(draft[1])));
      const preview = pathname.match(/^\/api\/authoring\/previews\/([^/]+)(.*)$/);
      if (preview && preview[2] === "/online" && request.method === "POST") {
        fail("LOCAL_ONLY", "预览保存在本机，请使用当前候选的本地预览地址。", 410);
      }
      if (preview && ["GET", "HEAD"].includes(request.method)) {
        const id = decode(preview[1]), suffix = preview[2];
        if (!suffix) return sendJson(response, 200, await workspace.getAuthoringPreview(actor, id));
        const artifact = suffix.match(/^\/artifacts\/(authoring|document|identity|report|index|manifest)\.json$/);
        if (artifact) {
          const selectedEvidence = url.searchParams.getAll("evidenceSourceIds");
          check(selectedEvidence.length <= 1 && (!selectedEvidence.length || artifact[1] === "report"), "VALIDATION_FAILED", "质量证据查询只适用于一份预览报告。", 400);
          const evidenceSourceIds = selectedEvidence.length ? selectedEvidence[0].split(",") : undefined;
          const exported = await workspace.getPreviewArtifact(actor, id, artifact[1], evidenceSourceIds);
          if (exported.resource) return await sendFile(request, response, exported.resource, { original: true });
          response.setHeader("Content-Disposition", attachment(exported.filename));
          response.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
          return sendJson(response, 200, exported.value);
        }
        if (suffix === "/pdf") return sendJson(response, 200, await workspace.previewResource(actor, id, { kind: "pdf" }));
        const page = suffix.match(/^\/pages\/([0-9]+)\.png$/);
        if (page) return await sendFile(request, response, await workspace.previewResource(actor, id, { kind: "page", page: Number(page[1]), width: integerParameter(url, "width") }));
        const sourceBytes = suffix.match(/^\/assets-by-hash\/([a-f0-9]{64})$/);
        if (sourceBytes) return await sendFile(request, response, await workspace.previewResource(actor, id, { kind: "asset-by-hash", sha256: sourceBytes[1] }), { original: true, inline: true });
        if (suffix.startsWith("/assets/")) return await sendFile(request, response, await workspace.previewResource(actor, id, { kind: "asset", path: decode(suffix.slice(8)) }), { original: true });
      }
      const reference = pathname.match(/^\/api\/references\/([^/]+)$/);
      if (reference && request.method === "GET") return sendJson(response, 200, await workspace.query(actor, { kind: "reference", reference: decode(reference[1]), documentId: url.searchParams.get("documentId") || undefined }));
      const document = pathname.match(/^\/api\/documents\/([^/]+)(.*)$/);
      if (document && ["GET", "HEAD"].includes(request.method)) {
        const documentId = decode(document[1]), revision = integerParameter(url, "revision"), suffix = document[2];
        if (!suffix) return sendJson(response, 200, await workspace.query(actor, { kind: "document", documentId, revision }));
        if (suffix === "/object-preferences") return sendJson(response, 200, await workspace.query(actor, { kind: "object_preferences", documentId }));
        if (suffix === "/relations") return sendJson(response, 200, await workspace.query(actor, { kind: "document_relations", documentId, revision }));
        if (suffix === "/export") {
          const envelope = await workspace.query(actor, { kind: "document", documentId, revision });
          response.setHeader("Content-Disposition", attachment(`${documentId}-r${envelope.document.revision}.json`));
          return sendJson(response, 200, envelope.document);
        }
        if (suffix === "/authoring") return sendJson(response, 200, await workspace.getAuthoringArtifacts(actor, documentId, revision));
        if (suffix === "/authoring/editing.json") {
          const exported = await workspace.getAuthoringEditPackageArtifact(actor, documentId, revision);
          if (exported.resource) return await sendFile(request, response, exported.resource, { original: true });
          response.setHeader("Content-Disposition", attachment(exported.filename));
          response.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
          return sendJson(response, 200, exported.value);
        }
        const artifact = suffix.match(/^\/authoring\/(authoring|identity|report|index)\.json$/);
        if (artifact) {
          const exported = await workspace.getAuthoringArtifact(actor, documentId, revision, artifact[1]);
          if (exported.resource) return await sendFile(request, response, exported.resource, { original: true });
          response.setHeader("Content-Disposition", attachment(exported.filename));
          response.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
          return sendJson(response, 200, exported.value);
        }
        if (suffix === "/pdf") return sendJson(response, 200, await workspace.resource(actor, { kind: "pdf", documentId, revision }));
        const page = suffix.match(/^\/pages\/([0-9]+)\.png$/);
        if (page) return await sendFile(request, response, await workspace.resource(actor, { kind: "page", documentId, revision, page: Number(page[1]), width: integerParameter(url, "width") }));
        const sourceBytes = suffix.match(/^\/assets-by-hash\/([a-f0-9]{64})$/);
        if (sourceBytes) return await sendFile(request, response, await workspace.resource(actor, { kind: "asset-by-hash", documentId, revision, sha256: sourceBytes[1] }), { original: true, inline: true });
        if (suffix.startsWith("/assets/")) return await sendFile(request, response, await workspace.resource(actor, { kind: "asset", documentId, revision, path: decode(suffix.slice(8)) }), { original: true });
      }
      if (pathname === "/api/glossary") {
        if (request.method === "GET") return sendJson(response, 200, await workspace.query(actor, { kind: "glossary.list", query: url.searchParams.get("query") || "", limit: 1000 }));
        if (request.method === "POST") {
          const input = await jsonBody(request, 32768), receipt = await workspace.execute(actor, { kind: "glossary.create", requestId: request.headers.get("idempotency-key") || randomUUID(), input });
          return sendJson(response, 201, { revision: receipt.glossaryRevision, entry: receipt.entry });
        }
      }
      const glossary = pathname.match(/^\/api\/glossary\/([0-9a-f-]{36})(\/restore)?$/i);
      if (glossary) {
        if (request.method === "GET" && !glossary[2]) return sendJson(response, 200, await workspace.query(actor, { kind: "glossary.get", id: glossary[1] }));
        const action = request.method === "PATCH" && !glossary[2] ? "update" : request.method === "DELETE" && !glossary[2] ? "remove" : request.method === "POST" && glossary[2] ? "restore" : null;
        if (action) {
          const input = await jsonBody(request, 32768), receipt = await workspace.execute(actor, { kind: "glossary." + action, id: glossary[1], expectedRevision: input.expectedRevision, input, requestId: request.headers.get("idempotency-key") || randomUUID() });
          return sendJson(response, 200, { revision: receipt.glossaryRevision, entry: receipt.entry });
        }
      }
  return null;
}
