import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { check } from "./errors.mjs";
import { documentation as catalog } from "./authoring-core.mjs";
export * from "./authoring-core.mjs";
const documentation = catalog.map(([name, title, path]) => [name, title, new URL(path, import.meta.url)]);

export async function authoringDocumentation(name) {
  name = name.replace(/^authoring-examples\//, "examples/");
  const found = documentation.find(([filename]) => filename === name);
  check(found, "NOT_FOUND", "没有找到此作者输入约定资料。", 404);
  const resource = { filename: found[0].split("/").at(-1), path: fileURLToPath(found[2]), mediaType: name.endsWith(".json") ? "application/json" : name.endsWith(".png") ? "image/png" : name.endsWith(".zip") ? "application/zip" : "text/markdown; charset=utf-8" };
  if (name.endsWith(".md")) {
    const markdown = await readFile(resource.path, "utf8");
    const links = new Set();
    // Contract documents have local-source links; resolve only against the fixed download catalog.
    resource.body = Buffer.from(markdown.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, target) => {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(target)) return match;
      const resolved = new URL(target, found[2]), fragment = resolved.hash; resolved.hash = "";
      const linked = documentation.find(([, , url]) => url.href === resolved.href);
      if (!linked) return `${label}（仓库内参考：\`${target}\`）`;
      const targetUrl = `/api/authoring/docs/${linked[0].split("/").map(encodeURIComponent).join("/")}${fragment}`;
      links.add(targetUrl);
      return `[${label}](${targetUrl})`;
    }));
    resource.documentationLinks = [...links];
  }
  return resource;
}
