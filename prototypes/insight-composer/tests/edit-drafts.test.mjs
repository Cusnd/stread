import test from "node:test";
import assert from "node:assert/strict";
import { cancelledEditDrafts, collectionDraftFor, documentDraftFor, rebaseCollectionDraft, rebaseDocumentDraft } from "../src/workspace/edit-drafts.js";

const material = { id: "doc-one", version: 2, title: "Original", kind: "论文", summary: "Original summary", collectionIds: ["research"], tags: ["attention"], status: "unread" };

test("cancel ends only the active editing transaction and reopening captures the current version", () => {
  const initial = { documentDraft: { ...documentDraftFor(material), title: "Cancelled" }, collectionDraft: collectionDraftFor({ id: "c1", version: 1, label: "Keep" }), selectedId: material.id, listScrollTop: 120 };
  const after = { ...initial, ...cancelledEditDrafts("edit-document") };
  assert.equal(after.documentDraft, null);
  assert.equal(after.collectionDraft, initial.collectionDraft);
  assert.equal(after.listScrollTop, 120);
  const reopened = documentDraftFor({ ...material, version: 3, status: "reading" });
  assert.equal(reopened.expectedVersion, 3);
  assert.equal(reopened.title, "Original");
  assert.equal(reopened.status, "reading");
  assert.deepEqual(cancelledEditDrafts("edit-collection"), { collectionDraft: null });
  assert.deepEqual(cancelledEditDrafts("detail"), {});
});

test("recovering a concurrent edit preserves user input and adopts updates to untouched fields", () => {
  const draft = { ...documentDraftFor(material), title: "My title", tagsText: "attention，review" };
  const latest = { ...material, version: 5, title: "Other title", summary: "A newer summary", status: "reading", collectionIds: ["research", "recent"] };
  const before = structuredClone({ draft, latest });
  const recovered = rebaseDocumentDraft(draft, latest);
  assert.equal(recovered.draft.expectedVersion, 5);
  assert.equal(recovered.draft.title, "My title");
  assert.equal(recovered.draft.tagsText, "attention，review");
  assert.equal(recovered.draft.summary, "A newer summary");
  assert.equal(recovered.draft.status, "reading");
  assert.deepEqual(recovered.draft.collectionIds, ["research", "recent"]);
  assert.deepEqual(recovered.conflicts, [{ field: "title", latest: "Other title", retained: "My title" }]);
  assert.deepEqual({ draft, latest }, before);
  const again = rebaseDocumentDraft(recovered.draft, { ...latest, version: 6, summary: "Updated again" });
  assert.equal(again.draft.title, "My title");
  assert.equal(again.draft.summary, "Updated again");
  assert.equal(again.draft.expectedVersion, 6);
});

test("old persisted drafts without baselines keep every input during recovery", () => {
  const { base, ...old } = documentDraftFor(material);
  old.title = "Unsaved legacy input";
  const recovered = rebaseDocumentDraft(old, { ...material, version: 9, summary: "New summary", tags: ["new"] });
  assert.equal(recovered.draft.title, old.title);
  assert.equal(recovered.draft.summary, old.summary);
  assert.equal(recovered.draft.tagsText, old.tagsText);
  assert.equal(recovered.draft.expectedVersion, 9);
  assert.ok(recovered.conflicts.some((item) => item.field === "summary"));
});

test("collection recovery preserves a renamed category while accepting its concurrently changed parent", () => {
  const initial = { id: "c1", version: 3, label: "Before", parentId: null };
  const draft = { ...collectionDraftFor(initial), label: "My category" };
  const recovered = rebaseCollectionDraft(draft, { ...initial, version: 4, parentId: "parent" });
  assert.equal(recovered.draft.label, "My category");
  assert.equal(recovered.draft.parentId, "parent");
  assert.equal(recovered.draft.expectedVersion, 4);
  assert.deepEqual(recovered.conflicts, []);
});
