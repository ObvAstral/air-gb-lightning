import { mkdir, readFile, appendFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = join(root, 'native-data/regtest');
await mkdir(directory, { recursive: true, mode: 0o700 });
const path = join(directory, 'wallet.env');
const password = randomBytes(32).toString('hex');
try {
  await writeFile(path, [
    `BITCOIND_RPC_PASSWORD=${password}`,
    'BITCOIND_RPC_USER=user',
    'BITCOIND_RPC_HOST=127.0.0.1',
    'BITCOIND_RPC_PORT=18443',
    'INDEXER_URL=tcp://127.0.0.1:50001',
    'RGB_PROXY_ENDPOINT=rpc://127.0.0.1:3000/json-rpc',
    'AIRGB_DATA_DIR=../../native-data/wallet',
    'AIRGB_LDK_PEER_PORT=9735',
    'ENABLE_REGTEST_SEND=0',
    '',
  ].join('\n'), { flag: 'wx', mode: 0o600 });
  process.stdout.write('Configurazione regtest privata creata in native-data/regtest/wallet.env\n');
} catch (error) {
  if (error.code === 'EEXIST') {
    const current = await readFile(path, 'utf8');
    if (!/^AIRGB_LDK_PEER_PORT=/m.test(current)) await appendFile(path, 'AIRGB_LDK_PEER_PORT=9735\n');
    process.stdout.write('Configurazione regtest privata già presente; credenziali conservate\n');
  }
  else throw error;
}
