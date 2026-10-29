import { canonical, check, clone, hash, json } from "./errors.mjs";
import { OBJECT_MARKER, objectReference } from "./immutable-objects.mjs";
import { normalizeRow, rowHash, rowKey, stateKey, syncSchema } from "./sync-schema.mjs";

const parse = (value) => value === null || value === undefined ? null : JSON.parse(value);
const pointer = (value) => json({ [OBJECT_MARKER]: value });

// Keep both immutable histories. Only the explicitly selected local branch and
// its unsynchronized source addresses are renumbered; published remote rows and
// old request receipts/preview snapshots retain their original bytes.
export async function prepareRevisionConflict(workspace, conflict) {
  const schema = workspace.sync?.schema || syncSchema(workspace.db), db = workspace.db;
  const preparationRevision = workspace.meta("revision"), preparationActivityRevision = workspace.flow.revision;
  const remote = new Map(conflict.remote.map((item) => [stateKey(item.entity, item.key), item]));
  const mutations = new Map(), guards = new Map(), mappings = [], documents = new Map();
  const keyOf = (entity, value) => rowKey(schema.get(entity), value);
  const current = (entity, key) => {
    const table = schema.get(entity), keys = JSON.parse(key);
    const row = db.prepare(`SELECT * FROM "${entity}" WHERE ${table.keys.map((name) => `"${name}"=?`).join(" AND ")}`).get(...keys);
    return row ? normalizeRow(schema, entity, row) : null;
  };
  const guard = (entity, key) => {
    const id = stateKey(entity, key);
    if (!guards.has(id)) guards.set(id, { entity, key, hash: rowHash(current(entity, key)) });
  };
  const put = (entity, value, key = keyOf(entity, value)) => {
    guard(entity, key);
    mutations.set(stateKey(entity, key), { entity, key, value: value === null ? null : normalizeRow(schema, entity, value) });
  };
  const localRows = new Map(conflict.local.map((item) => [stateKey(item.entity, item.key), item]));
  for (const item of conflict.local) {
    const remoteItem = remote.get(stateKey(item.entity, item.key));
    // Unchanged siblings in an atomic remote group are retained. Choosing the
    // local edit does not mean deleting unrelated new remote notes or versions.
    const unchanged = rowHash(item.value) === (item.expected?.hash ?? null);
    const selected = unchanged && remoteItem ? remoteItem.value : item.value;
    put(item.entity, selected, item.key);
  }
  for (const item of conflict.remote) {
    if (!localRows.has(stateKey(item.entity, item.key))) put(item.entity, item.value, item.key);
    if (item.entity !== "revisions" || !item.value) continue;
    const local = current("revisions", item.key);
    // A published immutable revision always wins its existing address.
    put("revisions", item.value, item.key);
    if (local && rowHash(local) !== rowHash(item.value)) {
      const old = documents.get(local.document_id);
      documents.set(local.document_id, { first: Math.min(old?.first ?? Infinity, local.revision) });
    }
  }
  if (!documents.size) return { mutations: [...mutations.values()], indexes: [], mappings, guards: [...guards.values()], preparationRevision, preparationActivityRevision };

  const revisionMaps = new Map();
  for (const [documentId, item] of documents) {
    const document = current("documents", canonical([documentId]));
    check(document, "SYNC_DOCUMENT_MISSING", "冲突文档已不存在。", 409);
    guard("documents", canonical([documentId]));
    const localRevisions = db.prepare("SELECT * FROM revisions WHERE document_id=? AND revision>=? ORDER BY revision").all(documentId, item.first);
    const remoteRevisions = conflict.remote.filter((entry) => entry.entity === "revisions" && entry.value?.document_id === documentId);
    const remoteDocument = remote.get(stateKey("documents", canonical([documentId])))?.value;
    let next = Math.max(document.current_revision, remoteDocument?.current_revision || 0,
      ...localRevisions.map((row) => row.revision), ...remoteRevisions.map((row) => row.value.revision)) + 1;
    const map = new Map(); revisionMaps.set(documentId, map);
    for (const source of localRevisions) {
      const sourceKey = canonical([documentId, source.revision]), published = remote.get(stateKey("revisions", sourceKey));
      guard("revisions", sourceKey);
      if (published?.value && rowHash(source) === rowHash(published.value)) continue;
      const newRevision = next++, sourceDocument = await workspace.storage.unpack(parse(source.content));
      const content = clone(sourceDocument); content.revision = newRevision;
      const index = workspace.revisionIndex(documentId, source.revision).map((entry) => ({ ...entry, revision: newRevision }));
      const report = await workspace.storage.unpack(parse(source.report));
      const contentHash = objectReference(parse(source.content))?.sha256 || hash(json(sourceDocument));
      const mapping = { documentId, fromRevision: source.revision, toRevision: newRevision, sourceContentHash: contentHash };
      const nextReport = { ...report, syncRebase: { conflictId: conflict.id || null, ...mapping, resolvedAt: new Date().toISOString() } };
      const revised = { ...source, revision: newRevision, content: pointer(await workspace.storage.stage(content)),
        text_index: pointer(await workspace.storage.stage(index)), report: pointer(await workspace.storage.stage(nextReport)),
        created_at: new Date().toISOString(), actor: "sync-conflict:" + (conflict.id || "local") };
      map.set(source.revision, newRevision); mappings.push(mapping);
      put("revisions", revised);
      if (!published?.value) {
        const known = workspace.sync?.known("revisions", sourceKey);
        // Never erase a previously published version. An unpublished local
        // collision address can be removed after its exact bytes get a new one.
        if (!known?.hash) put("revisions", null, sourceKey);
        else put("revisions", known.value || source, sourceKey);
      }
    }
    const head = map.get(document.current_revision);
    check(head, "SYNC_REBASE_HEAD", "本机当前版本不在待合并分支中。", 409);
    put("documents", { ...document, current_revision: head,
      version: Math.max(document.version, remoteDocument?.version || 0) + 1, updated_at: new Date().toISOString() });
  }

  const remapPosition = (value, documentId) => {
    if (!value || typeof value !== "object") return value;
    const next = clone(value), map = revisionMaps.get(next.documentId || documentId);
    if (map?.has(next.revision)) next.revision = map.get(next.revision);
    if (map?.has(next.documentRevision)) next.documentRevision = map.get(next.documentRevision);
    return next;
  };
  const locallyChanged = (entity, value) => {
    const key = keyOf(entity, value), normalized = normalizeRow(schema, entity, value);
    const remoteValue = remote.get(stateKey(entity, key))?.value;
    if (remoteValue && rowHash(remoteValue) === rowHash(normalized)) return false;
    const known = workspace.sync?.known(entity, key);
    return !known?.hash || known.hash !== rowHash(normalized);
  };
  const versioned = (entity, row, value) => {
    const previous = remote.get(stateKey(entity, keyOf(entity, row)))?.value;
    const nextVersion = Math.max(row.version || 0, previous?.version || 0) + 1;
    if (Object.hasOwn(row, "version")) row.version = nextVersion;
    if (value && Object.hasOwn(value, "version")) value.version = nextVersion;
    if (value && Object.hasOwn(value, "updatedAt")) value.updatedAt = new Date().toISOString();
  };
  for (const [documentId, map] of revisionMaps) {
    for (const entity of ["insights", "change_requests", "reading", "document_relations", "bibliographic_documents", "reading_sessions"]) {
      if (!schema.has(entity)) continue;
      for (const original of db.prepare(`SELECT * FROM "${entity}" WHERE document_id=?`).all(documentId)) {
        if (!locallyChanged(entity, original)) continue;
        const row = clone(original);
        if (entity === "reading_sessions") {
          if (!map.has(row.document_revision)) continue;
          row.document_revision = map.get(row.document_revision);
          for (const field of ["start_position", "end_position"]) if (row[field]) row[field] = json(remapPosition(parse(row[field]), documentId));
          for (const field of ["start_input", "end_input"]) if (row[field]) {
            const input = remapPosition(parse(row[field]), documentId);
            if (input.position) input.position = remapPosition(input.position, documentId);
            row[field] = canonical(input);
          }
        } else if (entity === "bibliographic_documents") {
          if (!map.has(row.revision)) continue;
          row.revision = map.get(row.revision);
        } else {
          const value = parse(row.payload), before = json(value);
          if (map.has(value.revision)) value.revision = map.get(value.revision);
          if (map.has(value.appliedRevision)) value.appliedRevision = map.get(value.appliedRevision);
          if (map.has(value.sourceRevision)) value.sourceRevision = map.get(value.sourceRevision);
          if (value.source) value.source = remapPosition(value.source, documentId);
          if (value.sources) value.sources = value.sources.map((source) => remapPosition(source, documentId));
          if (json(value) === before) continue;
          versioned(entity, row, value); row.payload = json(value);
        }
        put(entity, row);
      }
    }
    for (const original of db.prepare("SELECT * FROM proposals WHERE document_id=? AND status='pending'").all(documentId)) {
      if (!locallyChanged("proposals", original)) continue;
      guard("proposals", keyOf("proposals", original));
      const proposal = await workspace.storage.unpack(parse(original.payload));
      if (!map.has(proposal.expectedRevision)) continue;
      proposal.expectedRevision = map.get(proposal.expectedRevision);
      if (proposal.kind !== "relation") {
        proposal.before.revision = proposal.expectedRevision;
        proposal.after.revision = proposal.expectedRevision + 1;
        proposal.payloadHash = hash(canonical(proposal.after));
        await workspace.storage.stage(proposal.before); await workspace.storage.stage(proposal.after);
      }
      if (proposal.changeRequestId) {
        const request = mutations.get(stateKey("change_requests", canonical([proposal.changeRequestId])))?.value;
        if (request) proposal.expectedChangeRequestVersion = request.version;
      }
      put("proposals", { ...original, payload: workspace.storage.pack(proposal) });
    }
  }
  const values = [...mutations.values()];
  const indexes = await workspace.prepareImportedRevisionIndexes(values.filter((item) => item.entity === "revisions" && item.value).map((item) => item.value));
  return { mutations: values, indexes, mappings, guards: [...guards.values()], preparationRevision, preparationActivityRevision };
}
