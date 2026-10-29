import { inspectWorkspaceStorage, copyValidateWorkspaceStorage } from "../storage-maintenance.mjs";

const [action, source, destination, ...extra] = process.argv.slice(2);
try {
  if (!source || extra.length || !["inspect", "plan", "copy-validate"].includes(action) || (action === "copy-validate" ? !destination : destination)) {
    throw new Error("Usage: node services/workspace/scripts/storage-maintenance.mjs inspect|plan <data-directory> OR copy-validate <data-directory> <new-evidence-directory>");
  }
  const result = action === "copy-validate" ? await copyValidateWorkspaceStorage(source, destination)
    : await inspectWorkspaceStorage(source, { verifyObjects: action === "inspect" });
  if (action === "plan") result.plan = {
    sourceMutation: false, nextAction: "copy-validate", schemaPolicy: "Versioned additive migrations are applied to the new candidate only; changed or future migration definitions fail closed.",
    actions: ["Take a consistent SQLite backup into before/", "Copy retained immutable objects and original files", "Verify references and record semantic table fingerprints", "Apply migrations and repair only derived indexes in candidate/", "Recheck every revision, preview, original and business-state fingerprint"],
    rollback: "before/ is retained together with its objects. The tool never replaces the source or performs an automatic rollback.",
  };
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} catch (error) {
  process.stderr.write(JSON.stringify({ error: error.message, code: error.code || "MAINTENANCE_FAILED", details: error.details }, null, 2) + "\n"); process.exitCode = 1;
}
