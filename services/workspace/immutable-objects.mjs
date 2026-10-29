import { createHash } from "node:crypto";
import { check } from "./errors.mjs";

export const OBJECT_MARKER = "$readerObject";
export const MAX_OBJECT_BYTES = 100 * 1024 * 1024;
export function objectReference(value) {
  return value && typeof value === "object" && Object.keys(value).length === 1 && value[OBJECT_MARKER] ? validateObjectReference(value[OBJECT_MARKER]) : null;
}
export function validateObjectReference(ref) {
  check(ref && /^[a-f0-9]{64}$/.test(ref.sha256) && ref.key === `objects/sha256/${ref.sha256}` && Number.isSafeInteger(ref.size) && ref.size > 0 && ref.size <= MAX_OBJECT_BYTES && ref.version === 1,
    "OBJECT_REFERENCE_INVALID", "内容对象引用无效。", 400);
  return ref;
}
export function objectBytes(value) {
  const bytes = Buffer.from(JSON.stringify(value));
  check(bytes.length > 0 && bytes.length <= MAX_OBJECT_BYTES, "OBJECT_TOO_LARGE", "内容对象超过 100 MiB 限制。", 413);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { bytes, ref: { key: `objects/sha256/${sha256}`, sha256, size: bytes.length, version: 1 } };
}
export async function checkedObjectBytes(ref, input) {
  validateObjectReference(ref);
  const chunks = []; let size = 0;
  if (input instanceof ArrayBuffer) input = new Uint8Array(input);
  if (input instanceof Uint8Array) {
    const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    check(bytes.length === ref.size && createHash("sha256").update(bytes).digest("hex") === ref.sha256, "OBJECT_INTEGRITY_FAILED", "内容对象校验失败。", 409);
    return bytes;
  }
  for await (const chunk of input) {
    size += chunk.byteLength;
    check(size <= ref.size, "OBJECT_INTEGRITY_FAILED", "内容对象大小不符。", 409);
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  check(size === ref.size && createHash("sha256").update(bytes).digest("hex") === ref.sha256, "OBJECT_INTEGRITY_FAILED", "内容对象校验失败。", 409);
  return bytes;
}
export function parseObjectBytes(bytes) {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { check(false, "OBJECT_INVALID_JSON", "内容对象不是有效的 UTF-8 JSON。", 409); }
}
export async function hydrateObjectPointers(value, resources) {
  const ref = objectReference(value);
  if (ref) return resources.readObject(ref);
  if (Array.isArray(value)) return Promise.all(value.map((entry) => hydrateObjectPointers(entry, resources)));
  if (value && typeof value === "object") {
    const entries = await Promise.all(Object.entries(value).map(async ([key, entry]) => [key, await hydrateObjectPointers(entry, resources)]));
    return Object.fromEntries(entries);
  }
  return value;
}
