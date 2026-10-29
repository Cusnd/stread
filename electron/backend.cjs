const { pathToFileURL } = require('node:url');
const path = require('node:path');
let server;
process.parentPort.on('message', async ({ data }) => {
  try {
    if (data.type === 'start') {
      const sourceRoot = data.sourceRoot || data.runtime;
      const { createWorkspaceServer } = await import(pathToFileURL(path.join(sourceRoot, 'services/workspace/server.mjs')));
      server = await createWorkspaceServer({ dataDir: data.dataDir,
        staticRoot: data.sourceRoot ? false : path.join(data.runtime, 'client'),
        sampleRoot: data.sourceRoot ? path.join(sourceRoot, 'prototypes/insight-composer/public/articles') : path.join(data.runtime, 'client/articles'),
        pythonPath: path.join(data.runtime, 'python/python.exe'), glossaryPath: false, authToken: data.token,
        sync: false, syncServer: false, onlinePreview: false });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      process.parentPort.postMessage({ type: 'ready', port: server.address().port, node: process.versions.node });
    } else if (data.type === 'stop') {
      await server?.shutdown(); process.parentPort.postMessage({ type: 'stopped' }); process.exit(0);
    }
  } catch (error) { process.parentPort.postMessage({ type: 'error', message: error.stack || String(error) }); }
});
