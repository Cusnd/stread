import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { repositoryRoot, runDesktopDevelopment } from './dev.mjs';

// The demo owns a separate profile. Keep both browser storage and the SQLite
// workspace away from the user's regular desktop library.
const profile = join(repositoryRoot, '.audit/continuous-motion/demo-profile');
const result = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(repositoryRoot, 'scripts/seed-motion-demo.mjs')], {
    cwd: repositoryRoot, windowsHide: true, stdio: 'inherit',
  });
  child.once('error', reject);
  child.once('exit', resolve);
});
if (result !== 0) process.exitCode = result || 1;
else {
  console.log('连续动效演示使用独立测试资料：' + profile);
  try { process.exitCode = await runDesktopDevelopment({ args: ['--reader-user-data=' + profile] }); }
  catch (error) { console.error('无法打开动效演示：' + error.message); process.exitCode = 1; }
}
