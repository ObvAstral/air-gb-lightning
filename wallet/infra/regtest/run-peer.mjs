import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const lines = (await readFile(join(root, 'native-data/regtest/wallet.env'), 'utf8')).split(/\r?\n/);
const regtest = Object.fromEntries(lines.filter(line => /^[A-Z_][A-Z_0-9]*=/.test(line)).map(line => {
  const separator = line.indexOf('=');
  return [line.slice(0, separator), line.slice(separator + 1)];
}));
for (const name of ['BITCOIND_RPC_USER', 'BITCOIND_RPC_PASSWORD', 'INDEXER_URL', 'RGB_PROXY_ENDPOINT']) {
  if (!regtest[name]) throw new Error(`Configurazione regtest mancante: ${name}`);
}
const environment = {
  ...process.env, ...regtest,
  AIRGB_DATA_DIR: join(root, 'native-data/peer-wallet'),
  AIRGB_LDK_PEER_PORT: '9736',
  AIRGB_WEB_PORT: process.env.AIRGB_WEB_PORT ?? '5173',
  PORT: '8788',
  ENABLE_REGTEST_SEND: process.env.ENABLE_REGTEST_SEND ?? regtest.ENABLE_REGTEST_SEND ?? '0',
};
const children = [
  spawn(process.execPath, ['--import', 'tsx', 'apps/local-service/server.ts'], { cwd: root, env: environment, stdio: 'inherit' }),
];
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
for (const child of children) {
  child.once('error', error => { process.stderr.write(`${error.message}\n`); stop(); });
  child.once('exit', code => { if (!stopping && code !== 0) process.exitCode = code ?? 1; stop(); });
}
