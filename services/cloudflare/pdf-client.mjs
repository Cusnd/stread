import { WorkspaceError, check } from "../workspace/errors.mjs";

const ACTIONS = new Set(["manifest", "regions", "render"]);
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

async function boundedJson(response, signal) {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_JSON_BYTES)) {
    await response.body?.cancel();
    throw new WorkspaceError("CONVERSION_LIMIT", "PDF 处理结果超过限制。", 422);
  }
  check(response.body, "PDF_PROCESSING_FAILED", "PDF 处理没有返回内容。", 422);
  const reader = response.body.getReader(), chunks = []; let size = 0;
  const stop = () => { reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener("abort", stop, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      check(size <= MAX_JSON_BYTES, "CONVERSION_LIMIT", "PDF 处理结果超过限制。", 422);
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { signal?.removeEventListener("abort", stop); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new WorkspaceError("PDF_PROCESSING_FAILED", "PDF 处理没有返回有效结果。", 422); }
}

/**
 * Calls a private service binding or a selected Container stub.
 * source.url must be an expiring GET grant for precisely source.sha256.
 * JSON actions return their object; render returns a streaming PNG Response.
 */
export async function fetchPdfProcessor(binding, input, { token, signal, timeoutMs = 150000 } = {}) {
  check(binding && typeof binding.fetch === "function", "PDF_RUNTIME_UNAVAILABLE", "PDF 处理服务尚未配置。", 503);
  check(ACTIONS.has(input?.action), "VALIDATION_FAILED", "PDF 操作无效。");
  check(typeof token === "string" && token.length >= 32 && /^[\x21-\x7e]+$/.test(token), "PDF_RUNTIME_UNAVAILABLE", "PDF 处理服务凭据尚未配置。", 503);
  check(Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 360000, "VALIDATION_FAILED", "PDF 处理超时参数无效。");
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  let streaming = false;
  const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
  const cancelled = () => new WorkspaceError(signal?.aborted ? "CANCELLED" : "CONVERSION_TIMEOUT", signal?.aborted ? "PDF 处理已取消。" : "PDF 处理超时。", signal?.aborted ? 409 : 422);
  const untilAbort = new Promise((_resolve, reject) => {
    const stop = () => reject(cancelled());
    if (controller.signal.aborted) stop(); else controller.signal.addEventListener("abort", stop, { once: true });
  });
  const bounded = (operation) => Promise.race([operation, untilAbort]);
  try {
    const body = new TextEncoder().encode(JSON.stringify(input));
    check(body.byteLength <= 20 * 1024 * 1024, "CONVERSION_LIMIT", "PDF 处理请求超过限制。", 413);
    const response = await bounded(binding.fetch(new Request(`http://pdf.internal/${input.action}`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": String(body.byteLength) },
      body, signal: controller.signal,
    })));
    if (!response.ok) {
      if (!response.headers.get("content-type")?.includes("application/json")) {
        await response.body?.cancel();
        throw new WorkspaceError(response.status === 429 ? "PDF_PROCESSOR_BUSY" : "PDF_RUNTIME_UNAVAILABLE", "PDF 处理服务暂时不可用，请稍后重试。", response.status === 429 ? 429 : 503);
      }
      const error = await bounded(boundedJson(response, controller.signal));
      throw new WorkspaceError(typeof error.code === "string" ? error.code : "PDF_PROCESSING_FAILED", typeof error.error === "string" ? error.error : "PDF 处理失败。", response.status);
    }
    if (input.action === "render") {
      const declared = response.headers.get("content-length");
      if (!response.body || response.headers.get("content-type")?.split(";")[0] !== "image/png" || declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_IMAGE_BYTES)) {
        await response.body?.cancel();
        throw new WorkspaceError("PDF_PROCESSING_FAILED", "PDF 渲染没有返回有效图像。", 422);
      }
      const reader = response.body.getReader(); let received = 0, finished = false;
      const finish = () => { if (!finished) { finished = true; cleanup(); } };
      const stream = new ReadableStream({
        async pull(output) {
          try {
            if (controller.signal.aborted) throw cancelled();
            const { done, value } = await bounded(reader.read());
            if (done) {
              check(!declared || received === Number(declared), "PDF_PROCESSING_FAILED", "PDF 图像大小与声明不符。", 422);
              finish(); reader.releaseLock(); output.close(); return;
            }
            received += value.byteLength;
            check(received <= MAX_IMAGE_BYTES && (!declared || received <= Number(declared)), "CONVERSION_LIMIT", "PDF 图像超过限制。", 422);
            output.enqueue(value);
          } catch (error) { finish(); await reader.cancel(error).catch(() => {}); output.error(error); }
        },
        async cancel(reason) { finish(); controller.abort(reason); await reader.cancel(reason).catch(() => {}); },
      }, { highWaterMark: 0 });
      // Keep the timeout alive through image consumption, including an idle
      // consumer. The caller must consume/cancel the returned stream.
      untilAbort.catch(async (error) => { finish(); await reader.cancel(error).catch(() => {}); });
      streaming = true;
      return new Response(stream, { status: response.status, headers: response.headers });
    }
    return await bounded(boundedJson(response, controller.signal));
  } catch (error) {
    if (signal?.aborted) throw new WorkspaceError("CANCELLED", "PDF 处理已取消。", 409);
    if (timedOut) throw new WorkspaceError("CONVERSION_TIMEOUT", "PDF 处理超时。", 422);
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError("PDF_RUNTIME_UNAVAILABLE", "PDF 处理运行时不可用。", 503);
  } finally {
    if (!streaming) cleanup();
  }
}
