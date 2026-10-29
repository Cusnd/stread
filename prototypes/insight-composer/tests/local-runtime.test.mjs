import test from "node:test";
import assert from "node:assert/strict";

let sequence = 0;
async function configuration(target) {
  const previous = process.env.WORKSPACE_API_URL;
  if (target === undefined) delete process.env.WORKSPACE_API_URL;
  else process.env.WORKSPACE_API_URL = target;
  try { return (await import(`../vite.config.mjs?local-runtime-test=${++sequence}`)).default; }
  finally { if (previous === undefined) delete process.env.WORKSPACE_API_URL; else process.env.WORKSPACE_API_URL = previous; }
}

test("development and preview bind locally, and every API proxy targets the local workspace", async () => {
  const config = await configuration();
  assert.equal(config.server.host, "127.0.0.1");
  assert.equal(config.preview.host, "127.0.0.1");
  for (const route of ["/api", "/mcp", "/health"]) assert.equal(config.server.proxy[route].target, "http://127.0.0.1:4177");
  for (const target of ["http://localhost:4180", "http://[::1]:4180", "http://127.0.0.1:4180/"]) {
    assert.equal((await configuration(target)).server.proxy["/api"].target, new URL(target).origin);
  }
});

test("development refuses external, credential-bearing and malformed endpoints before creating a proxy", async () => {
  for (const target of [
    "https://reader.example.test", "http://192.168.1.2:4177", "http://localhost.example.test",
    "http://127.0.0.1:4177/api", "http://localhost:4177?token=private-test-secret",
    "http://localhost:4177#private-test-secret", "http://user:private-test-secret@localhost:4177",
    "malformed-private-test-secret", "file:///C:/private-test-secret",
  ]) {
    await assert.rejects(configuration(target), (error) => {
      assert.match(error.message, /本机工作台/);
      assert.ok(!error.message.includes("private-test-secret"));
      return true;
    });
  }
});
