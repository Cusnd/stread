'use strict';

module.exports = Object.freeze({
  repository: 'Cusnd/stread',
  manifestName: 'reader-update-win32-x64.json',
  schema: 1,
  platform: 'win32',
  arch: 'x64',
  limits: Object.freeze({ manifest: 8 * 1024 * 1024, compressed: 128 * 1024 * 1024, expanded: 256 * 1024 * 1024, file: 64 * 1024 * 1024, files: 20000 }),
});
