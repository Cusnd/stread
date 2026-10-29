import { generateKeyPairSync } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function generateUpdateKey({ publicFile = join(root, 'electron/update-public-key.pem'), privateFile = join(root, '.desktop/update-signing-private.pem') } = {}) {
  for (const file of [publicFile, privateFile]) {
    try { await readFile(file); throw new Error('Key already exists; refusing to replace it: ' + file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  await mkdir(dirname(privateFile), { recursive: true });
  await mkdir(dirname(publicFile), { recursive: true });
  const secret = await open(privateFile, 'wx', 0o600);
  let publicCreated = false;
  try {
    await secret.writeFile(privateKey);
    const visible = await open(publicFile, 'wx', 0o644);
    publicCreated = true;
    try { await visible.writeFile(publicKey); } finally { await visible.close(); }
  } catch (error) {
    await secret.close();
    await unlink(privateFile);
    if (publicCreated) await unlink(publicFile);
    throw error;
  }
  await secret.close();
  return { publicFile, privateFile };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('Usage: node electron/update-keygen.mjs');
  generateUpdateKey().then(({ publicFile, privateFile }) => console.log('Created update signing key. Public key: ' + publicFile + '\nPrivate key (keep outside Git): ' + privateFile)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
