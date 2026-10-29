// Generate documentation/examples from the exact public registry. --check is
// read-only; neither mode connects to a profile nor calls a business tool.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { createWorkspaceMcp } from "../mcp.mjs";

const destination = new URL("../generated/", import.meta.url);
const branches = (schema) => schema.oneOf || schema.anyOf || [schema];
function sample(schema, key = "", root = schema) {
  if (schema.$ref) return sample(schema.$ref.slice(2).split("/").reduce((at, part) => at[part], root), key, root);
  if (schema.const !== undefined) return schema.const;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum) return schema.enum[0];
  if (schema.anyOf || schema.oneOf) return sample(branches(schema)[0], key, root);
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === "null") return null;
  if (type === "boolean") return true;
  if (["integer", "number"].includes(type)) return Math.max(schema.minimum || 0, schema.exclusiveMinimum === undefined ? 0 : schema.exclusiveMinimum + 1);
  if (type === "array") return Array.from({ length: Math.max(1, schema.minItems || 0) }, () => sample(schema.items || {}, key, root));
  if (type === "object" || schema.properties) return Object.fromEntries((schema.required || []).map((field) => [field, sample(schema.properties[field], field, root)]));
  if (schema.format === "uuid") return "00000000-0000-4000-8000-000000000001";
  if (schema.format === "uri" || schema.format === "url") return "https://example.invalid/resource";
  if (schema.pattern?.includes("sha256:")) return "sha256:" + "0".repeat(64);
  if (schema.pattern?.includes("[a-f0-9]{64}")) return "0".repeat(64);
  if (schema.pattern?.includes("\\d{4}")) return "2026-01-01";
  if (key === "request_id") return "example-request-do-not-reuse";
  if (key === "reference") return "#Q00001";
  return "example".padEnd(schema.minLength || 0, "x");
}
function examplesFor(tool) {
  const inputs = [];
  for (const branch of branches(tool.inputSchema)) {
    const op = branch.properties?.operation;
    if (op) for (const operation of branches(op)) inputs.push({ ...sample(branch, "", tool.inputSchema), operation: sample(operation, "", tool.inputSchema) });
    else if (branch.properties?.operations?.items) for (const operation of branches(branch.properties.operations.items)) inputs.push({ ...sample(branch, "", tool.inputSchema), operations: [sample(operation, "", tool.inputSchema)] });
    else inputs.push(sample(branch, "", tool.inputSchema));
  }
  for (const input of inputs) {
    const checked = z.fromJSONSchema(tool.inputSchema).safeParse(input);
    if (!checked.success) throw new Error("Generated example violates " + tool.name + " schema: " + JSON.stringify(checked.error.issues));
  }
  return inputs.map((arguments_) => ({ name: tool.name, arguments: arguments_ }));
}

const server = createWorkspaceMcp({}), client = new Client({ name: "contract-documentation", version: "1" });
const [left, right] = InMemoryTransport.createLinkedPair();
let catalog, instructions, identity;
try {
  await server.connect(right); await client.connect(left);
  catalog = await client.listTools(); instructions = client.getInstructions(); identity = client.getServerVersion();
} finally { await client.close(); await server.close(); }
const mapping = JSON.parse(await readFile(new URL("../mcp-tool-mapping.json", import.meta.url), "utf8"));
const expected = mapping.tools.map((tool) => tool.name).sort(), names = catalog.tools.map((tool) => tool.name).sort();
if (names.length !== 32 || JSON.stringify(names) !== JSON.stringify(expected)) throw new Error("The independently maintained 32-name contract disagrees with the registry.");
const registryHash = createHash("sha256").update(JSON.stringify({ identity, instructions, tools: catalog.tools })).digest("hex");
const examples = catalog.tools.flatMap(examplesFor);
const exampleDocument = { format: "mcp-branch-examples-1", registryHash, notice: "Illustrative schema-valid placeholders; not business-valid calls, authorization or reusable request IDs. Generated without executing tools.", examples };
const sections = catalog.tools.map((tool) => {
  const selected = examples.filter((item) => item.name === tool.name);
  return ["## " + tool.name, "", tool.description, "", "- Access: " + (tool.annotations.readOnlyHint ? "read" : "write"), "- Output contract: " + (tool.outputSchema ? "declared and validated" : "domain result"), "", ...selected.flatMap((item) => ["```json", JSON.stringify(item.arguments, null, 2), "```", ""])].join("\n");
});
const markdown = ["# Generated current MCP contract", "", "Server: " + identity.name + " " + identity.version, "Registry SHA-256: `" + registryHash + "`", "", "Generated from the public registry. Examples use illustrative placeholders and never grant authorization or execute business operations.", "", instructions, "", ...sections].join("\n") + "\n";
const artifacts = { "generated-contract.md": markdown, "branch-examples.json": JSON.stringify(exampleDocument, null, 2) + "\n" };
if (process.argv.includes("--check")) {
  for (const [filename, content] of Object.entries(artifacts)) if (await readFile(new URL(filename, destination), "utf8") !== content) throw new Error(filename + " is stale; regenerate the current contract.");
} else {
  await mkdir(destination, { recursive: true });
  for (const [filename, content] of Object.entries(artifacts)) await writeFile(new URL(filename, destination), content);
}
console.log(JSON.stringify({ checked: process.argv.includes("--check"), tools: names.length, examples: examples.length, registryHash, artifacts: Object.keys(artifacts) }));
