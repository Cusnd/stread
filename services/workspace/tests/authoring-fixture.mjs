import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// Seed synthetic documents for unrelated business tests through the retained
// internal business API. These fixtures do not claim an independent Agent or
// browser review and do not exercise the MCP conversion completion boundary.
// Dedicated authoring-completion tests cover that boundary separately.
export async function publishAuthoringFixture({ base, headers = {}, authoring, resources = {} }) {
  const request = async (path, body, expected = 200) => {
    const response = await fetch(new URL(path, base), {
      method: body === undefined ? "GET" : "POST",
      headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json();
    assert.equal(response.status, expected, `${path}: ${JSON.stringify(value)}`);
    return value;
  };
  const file = await request("/api/sources?filename=fixture-authoring.json", authoring, 201);
  const publication = await request("/api/authoring/publish", { authoringSourceId: file.sourceId, resources, requestId: randomUUID() }, 201);
  const { document } = await request(`/api/documents/${publication.document.id}`);
  const identity = await request(publication.artifacts.artifacts.find((artifact) => artifact.kind === "identity").url);
  assert.equal(document.id, identity.documentId);
  assert.equal(document.blocks.length, authoring.blocks.length);
  assert.equal(publication.document.id, document.id);
  return { publication, document, identity, blockIds: Object.fromEntries(Object.entries(identity.blocks).map(([key, block]) => [key, block.id])) };
}
