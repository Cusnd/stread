// Retry receipts retain the same durable content and resource identities while
// renewing short-lived delivery credentials. Compare those concerns separately.
export function withoutFileAccess(value) {
  if (Array.isArray(value)) return value.map(withoutFileAccess);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "accessExpiresAt").map(([key, item]) => [key, withoutFileAccess(item)]));
  if (typeof value === "string" && /^https?:\/\//.test(value)) {
    const url = new URL(value); url.searchParams.delete("access"); return url.href;
  }
  return value;
}
