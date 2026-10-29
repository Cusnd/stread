import assert from "node:assert/strict";
import test from "node:test";
import { parseSyncArguments, runSyncCli } from "../sync-cli.mjs";

test("the sync CLI requires an explicit workspace and versioned conflict choice", () => {
  assert.throws(() => parseSyncArguments(["once"]));
  assert.throws(() => parseSyncArguments(["once", "--data-dir=local", "--token=must-not-be-on-command-line"]));
  assert.throws(() => parseSyncArguments(["resolve", "--data-dir=local", "--conflict=c1", "--choice=local"]));
  const parsed = parseSyncArguments(["resolve", "--data-dir=local", "--conflict=c1", "--choice=remote", "--expected-version=2"]);
  assert.deepEqual(parsed.resolution, { id: "c1", choice: "remote", expectedVersion: 2 });
});

test("status and conflict inspection require no cloud credential or network request", async () => {
  const outputs = [], events = [];
  const options = { args: ["status", "--data-dir=local"], environment: {}, verifyProfile: async () => {}, openWorkspace: async () => ({ close: async () => events.push("closed") }), openEngine: async () => ({ status: () => ({ pending: 4 }), conflicts: () => [{ id: "c1", actual: { version: 2 } }] }), openClient: async () => { throw new Error("Network must not start"); }, output: (value) => outputs.push(value) };
  await runSyncCli(options); await runSyncCli({ ...options, args: ["conflicts", "--data-dir=local"] });
  assert.deepEqual(outputs, [{ pending: 4 }, [{ id: "c1", actual: { version: 2 } }]]); assert.equal(events.length, 2);
});

test("retired network actions stop before accessing any profile or client", async () => {
  for (const action of ["once", "watch"]) {
    await assert.rejects(runSyncCli({ args: [action, "--data-dir=local"],
      environment: { CONTINUOUS_READER_SYNC_URL: "https://reader.example", CONTINUOUS_READER_SYNC_TOKEN: "old-test-token" },
      verifyProfile: async () => assert.fail("must not open a profile"),
      openWorkspace: async () => assert.fail("must not open a workspace"),
      openClient: async () => assert.fail("must not contact cloud") }), /云端同步已停用/);
  }
});

test("reading a fresh local profile never creates a replica identity or capture queue", async () => {
  const values = [], events = [];
  const options = { verifyProfile: async () => {},
    openWorkspace: async () => ({ db: { prepare: () => ({ get: () => undefined }) }, close: async () => events.push("closed") }),
    openEngine: async () => assert.fail("must not enroll a local library"), output: value => values.push(value) };
  await runSyncCli({ ...options, args: ["status", "--data-dir=local"] });
  await runSyncCli({ ...options, args: ["conflicts", "--data-dir=local"] });
  assert.deepEqual(values, [{ mode: "local", configured: false, pending: 0, conflicts: 0 }, { conflicts: [] }]);
  assert.equal(events.length, 2);
});
