// Shared by local MCP and authoring adapters so configuration cannot turn a
// loopback client into a cloud proxy. Never include credentials in diagnostics.
export function localWorkspaceUrl(value, fallback = "http://127.0.0.1:4177") {
  let url;
  try { url = new URL(value || fallback); } catch { throw new Error("工作台地址必须是本机 HTTP 地址。"); }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("工作台地址必须是本机 HTTP 地址，且不能包含凭证或路径。");
  }
  return url;
}
