import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createWorkspace, localActor } from "../service.mjs";
import { createWorkspaceSync } from "../sync-engine.mjs";
import { canonical, hash } from "../errors.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "reader-snapshot-revision-"));
  const source = await createWorkspace({ dataDir: join(directory, "source"), bootstrap: false, glossaryPath: false });
  let target, engine;
  const open = async () => {
    target = await createWorkspace({ dataDir: join(directory, "target"), bootstrap: false, glossaryPath: false });
    engine = await createWorkspaceSync(target, { mode: "client", replicaId: "snapshot-target" });
  };
  await open();
  t.after(async () => {
    await target.close(); await source.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith("reader-snapshot-revision-"));
    await rm(directory, { recursive: true, force: true });
  });
  const authoring = { format: "reader-authoring-1", key: "snapshot-real-revision", meta: { title: "Snapshot revision", language: "en" },
    blocks: [{ key: "heading", type: "heading", level: 1, text: "A heading without translations" }, { key: "paragraph", type: "para", text: "Original immutable content." }] };
  const file = await source.upload(localActor, Buffer.from(JSON.stringify(authoring)), { filename: "snapshot-authoring.json", mediaType: "application/json" });
  // This is a persisted-revision fixture, including deliberately absent optional
  // translations. It does not exercise or claim conversion review acceptance.
  const publication = await source.publishAuthoring(localActor, { authoringSourceId: file.sourceId, requestId: "snapshot-publication" });
  const authority = await createWorkspaceSync(source, { mode: "server" });
  while (authority.status().dirty) authority.capture();
  const states = source.db.prepare("SELECT * FROM sync_entities ORDER BY entity,key").all().map(row => ({ ...row, value: authority.decode(row.value) }));
  const revision = states.find(value => value.entity === "revisions");
  const [prepared] = await authority.prepareRows([revision]);
  assert.ok(Object.hasOwn(prepared.navigation.blocks[0], "translations")); assert.equal(prepared.navigation.blocks[0].translations, undefined);
  const snapshotId = "real-revision-snapshot", historyId = "real-revision-history", sequence = authority.head;
  const chunk = Buffer.from(JSON.stringify({ format: "reader-sync-snapshot-chunk-1", snapshotId, historyId, sequence, index: 0, states }));
  const manifest = { format: "reader-sync-snapshot-1", snapshotId, historyId, sequence, entityCount: states.length,
    chunks: [{ index: 0, sha256: hash(chunk), size: chunk.byteLength, rowCount: states.length }] };
  const bytes = Buffer.from(JSON.stringify(manifest)), reference = { snapshotId, sequence, sha256: hash(bytes), size: bytes.byteLength };
  let chunkDownloads = 0;
  const transport = { snapshotDescriptor: async () => bytes, snapshotChunk: async () => { chunkDownloads++; return chunk; } };
  const download = async ({ objects }) => {
    for (const ref of objects) {
      if (ref.key.startsWith("objects/")) {
        const parts = []; for await (const bytes of await source.resources.openObject(ref)) parts.push(Buffer.from(bytes));
        await target.resources.importObject(ref, Buffer.concat(parts));
      } else await target.resources.put(await source.resources.read(ref.sha256), { filename: ref.sha256 });
    }
  };
  return { publication, prepared, manifest, get target() { return target; }, get engine() { return engine; }, get chunkDownloads() { return chunkDownloads; },
    restore: () => engine.restoreSnapshot({ reference, historyId, head: sequence, transport, download }),
    restart: async () => { await target.close(); await open(); } };
}

test("a complete document snapshot hashes the persisted revision indexes and installs a heading without optional translations", async (t) => {
  const h = await fixture(t), restored = await h.restore();
  assert.equal(restored.installed, true); assert.equal(h.engine.cursor, h.manifest.sequence);
  const id = h.publication.document.id, revision = await h.target.revision(id);
  assert.equal(revision.document.blocks[0].text, "A heading without translations");
  assert.equal(revision.document.blocks[1].text, "Original immutable content.");
  const saved = h.target.db.prepare("SELECT sha256,payload FROM sync_snapshot_indexes").get();
  assert.equal(hash(canonical(h.engine.decode(saved.payload))), saved.sha256);
  const navigation = h.target.storage.nav(h.target.revisionRow(id));
  assert.equal(navigation.blocks[0].text, "A heading without translations");
});

test("a pending older revision-index stage is rebuilt from verified chunks after restart", async (t) => {
  const h = await fixture(t), apply = h.engine.applyRows.bind(h.engine);
  h.engine.applyRows = () => { throw new Error("Synthetic installation interruption"); };
  await assert.rejects(h.restore(), /Synthetic installation interruption/);
  h.engine.applyRows = apply;
  const downloads = h.chunkDownloads;
  // Reproduce the old saved representation: the checksum included undefined
  // fields which JSON omitted from the payload. Only derived staging is legacy.
  h.target.db.prepare("UPDATE sync_snapshot_indexes SET sha256=?").run(hash(canonical(h.prepared)));
  h.target.db.prepare("DELETE FROM schema_versions WHERE scope='replication-snapshot' AND version=2").run();
  await h.restart();
  assert.equal((await h.restore()).installed, true);
  assert.equal(h.chunkDownloads, downloads, "verified immutable chunk bytes are reused");
  assert.equal((await h.target.revision(h.publication.document.id)).document.blocks[1].text, "Original immutable content.");
});
