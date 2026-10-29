import test from "node:test";
import assert from "node:assert/strict";
import { parseRoute, routeUrl } from "../src/workspace-api.js";

test("article notes have an explicit document-scoped route without hijacking Reader links", () => {
  for (const documentId of ["paper-1", "article/中文 & #?"]) {
    const route = { page: "notes", documentId };
    assert.deepEqual(parseRoute(routeUrl(route)), route);
  }
  assert.deepEqual(parseRoute("?document=paper&view=notes&revision=2&insight=old"), { page: "notes", documentId: "paper" });
  assert.deepEqual(parseRoute("?document=paper&revision=2&insight=old"), { page: "reader", documentId: "paper", insightId: "old", revision: 2 });
  assert.deepEqual(parseRoute("?view=notes"), { page: "collection" });
  assert.deepEqual(parseRoute("?example=attention&view=notes&document=paper"), { page: "legacy" });
});
