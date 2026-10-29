import { createHash } from "node:crypto";

export class WorkspaceError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = "WorkspaceError";
    Object.assign(this, { code, status, details });
  }
}
export const fail = (code, message, status = 400, details) => { throw new WorkspaceError(code, message, status, details); };
export const check = (condition, code, message, status = 400, details) => { if (!condition) fail(code, message, status, details); };
export const object = (value, label = "内容") => {
  check(value && typeof value === "object" && !Array.isArray(value), "VALIDATION_FAILED", `${label}必须是对象。`);
  return value;
};
export function text(value, label, maximum = 10000, required = false) {
  check(typeof value === "string" && value.length <= maximum && (!required || value.trim().length > 0), "VALIDATION_FAILED", `${label}${required ? "不能为空，且" : ""}最多 ${maximum} 字。`);
  check(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value), "VALIDATION_FAILED", `${label}包含无效 Unicode。`);
  check(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value), "VALIDATION_FAILED", `${label}包含无效控制字符。`);
  return value;
}
export const identifier = (value, label = "标识") => {
  check(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value), "VALIDATION_FAILED", `${label}无效。`);
  return value;
};
export const version = (value, label = "版本") => { check(Number.isSafeInteger(value) && value >= 1, "VALIDATION_FAILED", `${label}必须是正整数。`); return value; };
export const normalized = (value) => value.normalize("NFKC").trim().toLocaleLowerCase();
export const json = (value) => JSON.stringify(value);
export const clone = (value) => structuredClone(value);
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
}
export function errorBody(error) {
  return error instanceof WorkspaceError
    ? { error: error.message, code: error.code, ...(error.details === undefined ? {} : { details: error.details }) }
    : { error: "工作台暂时无法完成此操作。", code: "INTERNAL_ERROR" };
}
