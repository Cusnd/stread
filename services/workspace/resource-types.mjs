export const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
export const PDF_REGION_ALGORITHM_VERSION = "6-list-item-heading-geometry";
const types = { pdf: "application/pdf", json: "application/json", txt: "text/plain", md: "text/markdown", html: "text/html", htm: "text/html", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", zip: "application/zip" };
export const mediaTypeFor = (name) => types[String(name).split(".").at(-1).toLowerCase()] || "application/octet-stream";
