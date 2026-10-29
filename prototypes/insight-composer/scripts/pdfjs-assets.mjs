import { createReadStream } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../node_modules/pdfjs-dist/", import.meta.url);
const directories = ["cmaps", "standard_fonts", "wasm", "iccs"];
const contentTypes = { js: "text/javascript", wasm: "application/wasm", ttf: "font/ttf" };

// PDF.js also loads CMaps, non-embedded fonts and image decoders. Keep every
// dependency on our own origin, both in Vite and the packaged/offline Reader.
export function pdfjsAssets() {
  let prefix, files;
  async function inventory() {
    if (files) return;
    const { version } = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
    prefix = `assets/pdfjs-${version}/`;
    files = new Map([["LICENSE", new URL("LICENSE", root)]]);
    for (const directory of directories) {
      for (const entry of await readdir(new URL(directory + "/", root), { withFileTypes: true })) {
        if (entry.isFile()) files.set(directory + "/" + entry.name, new URL(directory + "/" + entry.name, root));
      }
    }
  }
  return {
    name: "reader-pdfjs-assets",
    async configureServer(server) {
      await inventory();
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url, "http://vite.local").pathname;
        if (!pathname.startsWith("/" + prefix)) return next();
        const name = pathname.slice(prefix.length + 1), file = files.get(name);
        if (!file || !["GET", "HEAD"].includes(request.method)) { response.statusCode = 404; response.end(); return; }
        response.setHeader("Content-Type", contentTypes[name.split(".").at(-1)] || "application/octet-stream");
        if (request.method === "HEAD") { response.end(); return; }
        const stream = createReadStream(fileURLToPath(file));
        stream.on("error", () => { response.statusCode = 500; response.end(); });
        stream.pipe(response);
      });
    },
    async generateBundle() {
      await inventory();
      for (const [name, file] of files) this.emitFile({ type: "asset", fileName: prefix + name, source: await readFile(file) });
    },
  };
}
