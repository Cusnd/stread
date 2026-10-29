import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createWorkspace, localActor } from "../service.mjs";
import { createWorkspaceSync } from "../sync-engine.mjs";
import { canonical, hash } from "../errors.mjs";
import { projectReadingChanges } from "../reading-projection.mjs";

const long = label => label + " · immutable source value ".repeat(25);
const key = id => canonical([id]);
async function fixture(t, name, { mode = "client", currentValues = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "reader-current-values-"));
  const workspace = await createWorkspace({ dataDir: directory, bootstrap: false, glossaryPath: false });
  const sync = await createWorkspaceSync(workspace, { replicaId: name, mode, currentValues });
  t.after(async () => {
    await workspace.close(); assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + "reader-current-values-"));
    await rm(directory, { recursive: true, force: true });
  });
  return { workspace, sync, db: workspace.db };
}
const add = (h, id, label) => h.db.prepare("INSERT INTO collections VALUES(?,?,NULL,1)").run(id, long(label));
const edit = (h, id, label) => h.db.prepare("UPDATE collections SET label=?,version=version+1 WHERE id=?").run(long(label), id);
const stored = (h, entity, id) => h.db.prepare("SELECT value FROM sync_entities WHERE entity=? AND key=?").get(entity, id)?.value;
const borrowed = (h, entity, id) => Boolean(JSON.parse(stored(h, entity, id) || "null")?.$readerSyncCurrent);
async function pair(t) {
  const server = await fixture(t, "hub", { mode: "server", currentValues: false }), client = await fixture(t, "replica");
  add(server, "item", "original"); add(server, "target", "target");
  client.sync.acceptEnrollment(server.sync.enroll(localActor, { replicaId: "replica", requestId: "enrollment" }));
  await client.sync.applyPull(server.sync.pull({ after: 0 })); client.sync.capture();
  assert.equal(client.sync.status().pending, 0); assert.equal(borrowed(client, "collections", key("item")), true);
  return { server, client };
}

test("client opt-in borrows complete matching values without changing wire state or default replicas", async t => {
  const { server, client } = await pair(t), plain = await fixture(t, "plain", { currentValues: false });
  await plain.sync.applyPull(server.sync.pull({ after: 0 }));
  assert.equal(borrowed(plain, "collections", key("item")), false);
  assert.deepEqual(client.sync.known("collections", key("item")), plain.sync.known("collections", key("item")));
  assert.deepEqual(client.sync.row("collections", key("item")), server.sync.row("collections", key("item")));
  assert.equal(client.sync.cursor, plain.sync.cursor);
});

test("COW preserves the exact base through edits, rollback, PK changes and both REPLACE forms", async t => {
  const { client } = await pair(t), base = client.sync.known("collections", key("item")), target = client.sync.known("collections", key("target"));
  assert.throws(() => client.db.transaction(() => { edit(client, "item", "rolled back"); throw new Error("rollback"); }));
  assert.equal(borrowed(client, "collections", key("item")), true); assert.deepEqual(client.sync.known("collections", key("item")), base);
  client.db.exec("PRAGMA recursive_triggers=OFF");
  client.db.prepare("INSERT OR REPLACE INTO collections VALUES(?,?,NULL,7)").run("item", long("replacement"));
  assert.equal(borrowed(client, "collections", key("item")), false); assert.deepEqual(client.sync.known("collections", key("item")), base);
  client.db.prepare("UPDATE OR REPLACE collections SET id='item',label=? WHERE id='target'").run(long("moved target"));
  assert.deepEqual(client.sync.known("collections", key("target")), target);
  assert.deepEqual(client.sync.known("collections", key("item")), base);
  client.db.prepare("DELETE FROM collections WHERE id='item'").run();
  assert.deepEqual(client.sync.known("collections", key("item")), base);
});

test("an ACK received after another local edit retains the sent base and the unchanged outbox request", async t => {
  const { server, client } = await pair(t);
  edit(client, "item", "sent first"); client.sync.capture();
  const batch = client.sync.pending().batches[0], frozen = stored(client, "collections", key("item"));
  edit(client, "item", "edited while sending");
  assert.equal(stored(client, "collections", key("item")), frozen);
  assert.deepEqual(client.sync.pending().batches[0], batch);
  const receipt = await server.sync.push(localActor, batch); client.sync.acknowledge(receipt);
  assert.equal(borrowed(client, "collections", key("item")), false);
  assert.equal(client.sync.known("collections", key("item")).value.label, long("sent first"));
  client.sync.capture(); const next = client.sync.pending().batches[0].mutations.find(row => row.entity === "collections");
  assert.equal(next.value.label, long("edited while sending")); assert.equal(next.expected.version, 2);
  assert.deepEqual(await server.sync.push(localActor, batch), receipt, "old exact receipt remains replayable");
});

test("small borrowed rows can grow beyond the inline limit without losing the old base or exact ACK", async t => {
  const { server, client } = await pair(t), before = client.sync.known("collections", key("item"));
  const large = "Long Unicode payload 中文 ".repeat(4000);
  client.db.prepare("UPDATE collections SET label=?,version=version+1 WHERE id='item'").run(large);
  assert.deepEqual(client.sync.known("collections", key("item")), before);
  client.sync.capture(); const batch = client.sync.pending().batches[0];
  assert.equal(JSON.stringify(batch).includes("$readerSyncCurrent"), false);
  const receipt = await server.sync.push(localActor, batch); client.sync.acknowledge(receipt);
  assert.equal(client.sync.known("collections", key("item")).value.label, large);
  assert.ok(JSON.parse(stored(client, "collections", key("item"))).$readerSyncPayload);
  assert.deepEqual(await server.sync.push(localActor, batch), receipt);
  client.sync.currentValues.compact({ limit: 100 });
  assert.equal(borrowed(client, "collections", key("item")), false);
});

test("remote apply, dirty atomic conflicts and tombstones preserve all value choices", async t => {
  const { server, client } = await pair(t);
  edit(server, "item", "remote clean"); await client.sync.applyPull(server.sync.pull({ after: client.sync.cursor }));
  assert.equal(borrowed(client, "collections", key("item")), true);
  client.db.transaction(() => { edit(client, "item", "local conflict"); edit(client, "target", "atomic companion"); });
  edit(server, "item", "remote conflict"); await client.sync.applyPull(server.sync.pull({ after: client.sync.cursor }));
  assert.equal(borrowed(client, "collections", key("item")), false);
  const conflict = client.sync.conflicts().conflicts[0];
  assert.equal(conflict.remote.find(row => row.key === key("target")).value.label, long("target"));
  assert.equal(conflict.local.find(row => row.key === key("item")).value.label, long("local conflict"));
  await client.sync.resolveConflict({ id: conflict.id, choice: "remote", expectedVersion: conflict.version });
  client.sync.capture();
  server.db.prepare("DELETE FROM collections WHERE id='item'").run();
  await client.sync.applyPull(server.sync.pull({ after: client.sync.cursor }));
  assert.equal(client.sync.known("collections", key("item")).value, null);
  assert.equal(client.sync.known("collections", key("item")).hash, null);
  assert.equal(stored(client, "collections", key("item")), null);
});

test("derived activity updates keep borrowed facts while sync-applying writes still preserve preimages", async t => {
  const { server, client } = await pair(t), start = Date.parse("2026-10-20T12:00:00Z"), end = start + 15000;
  server.db.transaction(() => {
    server.db.prepare("INSERT INTO documents VALUES('doc',1,1,'{}',NULL,?,?)").run(new Date(start).toISOString(), new Date(start).toISOString());
    server.db.prepare("INSERT INTO reading_sessions(id,actor_id,document_id,document_revision,started_ms,start_input,created_at) VALUES('session','local','doc',1,?,'{}',?)").run(start, new Date(start).toISOString());
    server.db.prepare("INSERT INTO reading_activity VALUES('session',1,?,?,15000,0,?)").run(start, end, canonical({ startedAt: new Date(start).toISOString(), endedAt: new Date(end).toISOString(), activeMs: 15000 }));
    projectReadingChanges(server.db, { inTransaction: true });
  });
  await client.sync.applyPull(server.sync.pull({ after: client.sync.cursor }));
  const factKey = canonical(["session", 1]), before = client.sync.known("reading_activity", factKey);
  assert.equal(borrowed(client, "reading_activity", factKey), true);
  client.db.prepare("UPDATE reading_activity SET accepted_ms=1 WHERE session_id='session'").run();
  assert.equal(borrowed(client, "reading_activity", factKey), true); assert.deepEqual(client.sync.known("reading_activity", factKey), before);
  client.sync.transact(() => { client.sync.setState("applying", "1"); client.db.prepare("DELETE FROM reading_activity WHERE session_id='session'").run(); client.sync.setState("applying", "0"); });
  assert.equal(borrowed(client, "reading_activity", factKey), false); assert.deepEqual(client.sync.known("reading_activity", factKey), before);
});

test("bounded maintenance borrows old clean values and excludes large, legacy and secondary-unique rows", async t => {
  const h = await fixture(t, "maintenance", { currentValues: false });
  for (let i = 0; i < 5; i++) { add(h, "item-" + i, "value-" + i); const value = h.sync.row("collections", key("item-" + i)); h.sync.remember("collections", key("item-" + i), { version: 1, hash: hash(canonical(value)), value }); }
  for (const [id, payload] of [["large", "x".repeat(50000)], ["legacy", '$continuousReaderSqlValue'.repeat(25)]]) {
    h.db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?)").run(id, hash(payload), payload, "local", "2026-10-20");
    const value = h.sync.row("receipts", key(id)); h.sync.remember("receipts", key(id), { version: 1, hash: hash(canonical(value)), value });
  }
  h.db.prepare("INSERT INTO glossary VALUES('g',1,'term',?,NULL)").run(long("glossary"));
  const glossary = h.sync.row("glossary", key("g")); h.sync.remember("glossary", key("g"), { version: 1, hash: hash(canonical(glossary)), value: glossary });
  h.sync = await createWorkspaceSync(h.workspace, { currentValues: true });
  let after, scanned = 0, compacted = 0;
  for (;;) { const result = h.sync.currentValues.compact({ limit: 2, after }); assert.ok(result.scanned <= 2); scanned += result.scanned; compacted += result.compacted; after = result.nextKey; if (!result.hasMore) break; }
  assert.equal(scanned, 8); assert.equal(compacted, 5);
  assert.equal(borrowed(h, "receipts", key("large")), false); assert.equal(borrowed(h, "receipts", key("legacy")), false); assert.equal(borrowed(h, "glossary", key("g")), false);
});

test("persisted activation survives omitted options and schema/version changes stop before removing protection", async t => {
  const { client } = await pair(t), base = client.sync.known("collections", key("item"));
  client.sync = await createWorkspaceSync(client.workspace, { currentValues: false });
  assert.equal(client.sync.currentValues.active, true); edit(client, "item", "after restart");
  assert.deepEqual(client.sync.known("collections", key("item")), base);
  const protection = client.db.prepare("SELECT sql FROM sqlite_master WHERE name='reader_sync_current_collections_update'").get().sql;
  client.db.exec("ALTER TABLE collections ADD COLUMN future TEXT");
  await assert.rejects(createWorkspaceSync(client.workspace, { currentValues: true }), { code: "SYNC_CURRENT_VALUES_SCHEMA" });
  assert.equal(client.db.prepare("SELECT sql FROM sqlite_master WHERE name='reader_sync_current_collections_update'").get().sql, protection);
  client.db.prepare("UPDATE sync_state SET value='9' WHERE key='currentValuesVersion'").run();
  await assert.rejects(createWorkspaceSync(client.workspace), { code: "SYNC_CURRENT_VALUES_VERSION" });
});

test("a corrupt or missing current row fails integrity checks instead of becoming a tombstone", async t => {
  const { client } = await pair(t);
  client.db.exec("DROP TRIGGER reader_sync_current_collections_update");
  edit(client, "item", "tampered without COW");
  assert.throws(() => client.sync.known("collections", key("item")), { code: "SYNC_CURRENT_VALUES_INTEGRITY" });
  const ref = JSON.parse(stored(client, "collections", key("target"))); ref.$readerSyncCurrent.key = key("other");
  client.db.prepare("UPDATE sync_entities SET value=? WHERE entity='collections' AND key=?").run(JSON.stringify(ref), key("target"));
  assert.throws(() => client.sync.known("collections", key("target")), { code: "SYNC_CURRENT_VALUES_INTEGRITY" });
});
