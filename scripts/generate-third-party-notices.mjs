import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicNotices = join(root, 'prototypes/insight-composer/public/third-party');

export async function generateThirdPartyNotices() {
  const packages = new Map();
  async function visitModules(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const path = join(directory, entry.name);
      if (entry.name.startsWith('@')) {
        for (const child of await readdir(path, { withFileTypes: true })) {
          if (child.isDirectory()) await visitPackage(join(path, child.name));
        }
      } else await visitPackage(path);
    }
  }
  async function visitPackage(path) {
    let pkg;
    try { pkg = JSON.parse(await readFile(join(path, 'package.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const id = `${pkg.name}@${pkg.version}`;
    if (!packages.has(id)) {
      const licenses = [];
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.isFile() && /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(entry.name)) {
          licenses.push(`[${entry.name}]\n${(await readFile(join(path, entry.name), 'utf8')).replace(/\r\n/g, '\n').trim()}`);
        }
      }
      packages.set(id, { license: typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license || pkg.licenses || 'See upstream package'), licenses });
    }
    try { await visitModules(join(path, 'node_modules')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const directory of ['node_modules', 'prototypes/insight-composer/node_modules', 'services/workspace/node_modules', 'services/glossary/node_modules']) await visitModules(join(root, directory));
  await mkdir(publicNotices, { recursive: true });
  const sorted = [...packages].sort(([a], [b]) => a.localeCompare(b));
  const header = 'Stread — JavaScript dependency notices\n\nGenerated from installed locked dependencies, including build tools and packages that may be removed by tree shaking. Third-party notices remain under their respective licenses.\n\n';
  const body = sorted.map(([id, item]) => `${'='.repeat(78)}\n${id} (${item.license})\n${'='.repeat(78)}\n\n${item.licenses.length ? item.licenses.join('\n\n') : 'No root-level license file was supplied by this installed package; consult its package metadata and upstream source.'}\n`).join('\n');
  await writeFile(join(publicNotices, 'dependencies-LICENSES.txt'), header + body, 'utf8');
  await copyFile(join(root, 'LICENSE'), join(publicNotices, 'stread-LICENSE.txt'));
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const notices = (await readFile(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8')).replace(/\]\((?![a-z]+:|#)([^)]+)\)/gi,
    (_, target) => `](https://github.com/Cusnd/stread/blob/v${version}/${target})`);
  await writeFile(join(publicNotices, 'stread-NOTICES.md'), notices, 'utf8');
  console.log(`Prepared third-party notices for ${sorted.length} installed packages.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generateThirdPartyNotices().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
