// Isolated UI verification server: no workspace database, publication or reading
// activity. Every API request is recorded so backend PDF computation is visible.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative, extname } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assets = resolve(root, "dist/client"), sample = resolve(root, "public/articles/attention-is-all-you-need");
const grant = "pdf-fixture-grant", requests = [];
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function makePdf() {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>"];
  for (const lines of [["Source paragraph one.", "Source paragraph two."], ["First list item.", "Second list item."]]) {
    const content = lines.map((line, index) => `BT /F1 18 Tf 60 ${680 - index * 70} Td (${line}) Tj ET`).join("\n");
    const stream = objects.length + 2;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents ${stream} 0 R >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  let output = "%PDF-1.7\n", offsets = [0];
  for (const [index, body] of objects.entries()) { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${body}\nendobj\n`; }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map((offset) => String(offset).padStart(10, "0") + " 00000 n \n").join("");
  return Buffer.from(output + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
const original = makePdf();
const source = (page, top) => [{ page, box: [.1, top, .8, top + .04] }];
const synthetic = { format: "continous-reader", schema: 1, id: "pdf-browser-fixture", revision: 1,
  meta: { title: "PDF browser interaction fixture", language: "en" },
  source: { path: "source.pdf", media_type: "application/pdf", sha256: sha(original) },
  blocks: [{ id: "first", type: "para", text: "Source paragraph one.", source: source(1, .13) },
    { id: "second", type: "para", text: "Source paragraph two.", source: source(1, .2175) },
    { id: "page-only", type: "para", text: "Page-only reference.", source: [{ page: 1 }] },
    { id: "unmapped", type: "para", text: "No original coordinates." },
    { id: "list", type: "list", items: [{ id: "list-one", text: "First list item.", source: source(2, .13) },
      { id: "list-two", text: "Second list item.", source: source(2, .2175) }] }], extensions: {} };
const attention = JSON.parse(await readFile(resolve(sample, "document.json"), "utf8"));
const mime = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".pdf": "application/pdf", ".wasm": "application/wasm", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".ttf": "font/ttf" };
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost"), path = decodeURIComponent(url.pathname);
  const send = (status, body, type = "application/json") => { response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" }); response.end(typeof body === "object" && !Buffer.isBuffer(body) ? JSON.stringify(body) : body); };
  try {
    if (path === "/__pdf_test_log") return send(200, requests);
    if (path.startsWith("/api/")) {
      requests.push({ method: request.method, path, access: url.searchParams.get("access") === grant });
      if (url.searchParams.get("access") !== grant) return send(403, { error: "Fixture preview access required" });
      const match = /^\/api\/authoring\/previews\/(preview-fixture|preview-attention)(.*)$/.exec(path);
      if (!match) return send(404, { error: "Fixture endpoint not found" });
      const [, id, suffix] = match, paper = id === "preview-fixture" ? synthetic : attention;
      if (!suffix) return send(200, { preview: { id, hash: sha(JSON.stringify(paper)) }, document: paper, readOnly: true, assetBase: `/api/authoring/previews/${id}/assets/` });
      const byHash = /^\/assets-by-hash\/([a-f0-9]{64})$/.exec(suffix);
      if (byHash) {
        if (byHash[1] !== paper.source.sha256) return send(404, "Missing");
        response.setHeader("Content-Disposition", "inline");
        return send(200, id === "preview-fixture" ? original : await readFile(resolve(sample, paper.source.path)), "application/vnd.continuous-reader.source");
      }
      if (!suffix.startsWith("/assets/")) return send(500, { error: "Backend PDF computation must never be requested" });
      const name = suffix.slice("/assets/".length);
      if (id === "preview-fixture") return name === "source.pdf" ? send(200, original, "application/pdf") : send(404, "Missing");
      const file = resolve(sample, name);
      if (relative(sample, file).startsWith("..")) return send(403, "Denied");
      return send(200, await readFile(file), mime[extname(file)] || "application/octet-stream");
    }
    const file = path === "/" ? resolve(assets, "index.html") : resolve(assets, "." + path);
    if (relative(assets, file).startsWith("..")) return send(403, "Denied");
    return send(200, await readFile(file), mime[extname(file)] || "application/octet-stream");
  } catch (error) { send(404, { error: error.code || error.message }); }
});
server.listen(Number(process.argv[2] || 0), "127.0.0.1", () => console.log(JSON.stringify({ origin: `http://127.0.0.1:${server.address().port}`, preview: `/?preview=preview-fixture&access=${grant}`, attention: `/?preview=preview-attention&access=${grant}` })));
