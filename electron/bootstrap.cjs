'use strict';

const { app, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

if (!app.isPackaged) {
  require('./main.cjs');
} else {
  const profileOption = process.argv.find((argument) => argument.startsWith('--reader-user-data='));
  const profile = profileOption ? path.resolve(profileOption.slice('--reader-user-data='.length)) : path.join(app.getPath('home'), '.continuous-reader');
  const mcp = process.argv.includes('--mcp');
  fs.mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
  app.readerOwnsInstance = !mcp && app.requestSingleInstanceLock();
  if (!mcp && !app.readerOwnsInstance) {
    app.quit();
  } else {
    try {
      const { createUpdater } = require('./update-core.cjs');
      const updater = createUpdater({ app, profile, resourcesPath: process.resourcesPath, appRoot: path.resolve(__dirname, '..') });
      const selected = updater.select({ mcp });
      app.readerUpdater = updater;
      app.readerRuntime = selected.runtime;
      require(path.join(selected.appRoot, 'electron/main.cjs'));
    } catch (error) {
      try { app.readerUpdater?.markFailed(); } catch {}
      if (mcp) process.stderr.write('Stread update startup failed. Reopen the desktop app.\n');
      else dialog.showErrorBox('Stread 无法启动', '程序更新启动失败，请重新打开以恢复上一版本。\n\n' + error.message);
      app.exit(1);
    }
  }
}
