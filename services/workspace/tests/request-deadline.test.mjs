import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { createRequestDeadline } from "../request-deadline.mjs";
import { createSyncTransport } from "../sync-http-client.mjs";
import { createOnlinePreviewClient } from "../online-preview.mjs";
import { freezeAuthoringPreview } from "../authoring-preview.mjs";
import { hash } from "../errors.mjs";

function trackedClock(t) {
  let nextId = 0; const pending = new Map();
  t.mock.method(globalThis, "setTimeout", (callback, milliseconds) => {
    assert.equal(milliseconds, 60000);
    const id = ++nextId; pending.set(id, callback); return id;
  });
  t.mock.method(globalThis, "clearTimeout", id => pending.delete(id));
  return { pending, fire() { for (const [id, callback] of [...pending]) { pending.delete(id); callback(); } } };
}

test("a request deadline releases its timer and caller listener on completion or either abort", t => {
  const clock = trackedClock(t);
  for (const ending of ["complete", "caller", "timeout", "already-cancelled"]) {
    const caller = new AbortController();
    if (ending === "already-cancelled") caller.abort();
    const deadline = createRequestDeadline(60000, caller.signal);
    if (ending === "already-cancelled") {
      assert.equal(clock.pending.size, 0); assert.equal(deadline.signal.aborted, true);
    } else {
      assert.equal(clock.pending.size, 1); assert.equal(getEventListeners(caller.signal, "abort").length, 1);
      if (ending === "caller") caller.abort(new Error("caller stopped"));
      else if (ending === "timeout") clock.fire();
      else deadline.dispose();
    }
    assert.equal(clock.pending.size, 0); assert.equal(getEventListeners(caller.signal, "abort").length, 0);
    assert.equal(deadline.timedOut, ending === "timeout");
    if (ending === "timeout") assert.equal(deadline.signal.reason.name, "TimeoutError");
    if (ending === "caller" || ending === "already-cancelled") assert.equal(deadline.signal.reason, caller.signal.reason);
    deadline.dispose(); caller.abort(); clock.fire();
    assert.equal(deadline.signal.aborted, ending !== "complete", "completion must not leave a later abort behind");
  }
});

const configuration = { origin: "https://deadline.reader.test", token: "synthetic-deadline-token-123456" };
// The transport fixture has fully hashed immutable artifacts; semantic authoring
// and publication validation are exercised by the existing preview integration suite.
const snapshot = { ...freezeAuthoringPreview({ compiled: { authoring: {}, identity: {}, report: {} },
  validated: { document: { id: "deadline-fixture", meta: { title: "Deadline transport fixture", language: "en" }, blocks: [] }, index: [], fingerprints: {}, report: {}, readOnly: false },
  resourceMap: {}, authoringFile: { sha256: hash("authoring"), size: 9, mediaType: "application/json" },
  validation: { summary: {} } }), draftId: "deadline-draft" };
const reply = kind => kind === "sync" ? { cursor: 4, changes: [] } : {
  previewId: snapshot.id, hash: snapshot.hash, snapshotUrl: configuration.origin + "/?preview=" + snapshot.id,
};
function request(kind, fetchImpl, signal) {
  if (kind === "sync") return createSyncTransport({ ...configuration, fetchImpl }).pull({ signal });
  const client = createOnlinePreviewClient({ ...configuration, fetchImpl, transport: { async hasObject() { return true; } } });
  return client.publish(snapshot, { signal });
}

for (const kind of ["sync", "preview"]) {
  test(`${kind} keeps its deadline through the complete response body and clears it before returning`, async t => {
    const clock = trackedClock(t), caller = new AbortController(), headersRead = Promise.withResolvers();
    let body, usedSignal;
    const pending = request(kind, async (_url, { signal }) => {
      usedSignal = signal;
      const response = new Response(new ReadableStream({ start(controller) { body = controller; } }), { headers: { "Content-Type": "application/json" } });
      headersRead.resolve(); return response;
    }, caller.signal);
    await headersRead.promise;
    assert.equal(clock.pending.size, 1); assert.equal(getEventListeners(caller.signal, "abort").length, 1);
    body.enqueue(Buffer.from(JSON.stringify(reply(kind)))); body.close();
    const value = await pending;
    assert.equal(kind === "sync" ? value.cursor : value.status, kind === "sync" ? 4 : "ready");
    assert.equal(clock.pending.size, 0); assert.equal(getEventListeners(caller.signal, "abort").length, 0);
    caller.abort(); clock.fire(); assert.equal(usedSignal.aborted, false);
  });

  test(`${kind} cancels stalled response bodies on caller abort and deadline expiry`, async t => {
    const clock = trackedClock(t);
    for (const ending of ["caller", "timeout"]) {
      const caller = new AbortController(), headersRead = Promise.withResolvers();
      const pending = request(kind, async (_url, { signal }) => {
        const response = new Response(new ReadableStream({ start(controller) {
          signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        } }), { headers: { "Content-Type": "application/json" } });
        headersRead.resolve(); return response;
      }, caller.signal);
      await headersRead.promise;
      assert.equal(clock.pending.size, 1);
      const rejected = assert.rejects(pending, { code: ending === "caller" ? "SYNC_CANCELLED" : "SYNC_TIMEOUT" });
      if (ending === "caller") caller.abort(); else clock.fire();
      await rejected;
      assert.equal(clock.pending.size, 0); assert.equal(getEventListeners(caller.signal, "abort").length, 0);
    }
  });

  test(`${kind} releases deadline resources on fetch, HTTP and validation failures`, async t => {
    const clock = trackedClock(t);
    for (const [fetchImpl, code] of [
      [async () => { throw new Error("untrusted network detail"); }, "SYNC_OFFLINE"],
      [async () => new Response("denied", { status: 401 }), "SYNC_UNAUTHORIZED"],
      [async () => Response.json(null), kind === "sync" ? "SYNC_INVALID_RESPONSE" : "PREVIEW_HASH_MISMATCH"],
    ]) {
      const caller = new AbortController();
      await assert.rejects(request(kind, fetchImpl, caller.signal), { code });
      assert.equal(clock.pending.size, 0); assert.equal(getEventListeners(caller.signal, "abort").length, 0);
    }
  });
}
