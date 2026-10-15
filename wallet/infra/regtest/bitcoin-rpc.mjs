import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const env = await readFile(join(root, 'native-data/regtest/wallet.env'), 'utf8');
const password = /^BITCOIND_RPC_PASSWORD=(.+)$/m.exec(env)?.[1];
if (!password) throw new Error('Configurazione RPC privata mancante');
const args = process.argv.slice(2);
if (!args.length || args.some(value => value.length > 200)) throw new Error('Specificare un comando bitcoin-cli breve');
const child = spawn('podman', ['exec', '-i', 'airgb-regtest-bitcoind-1', 'bitcoin-cli', '-regtest', '-rpcuser=user', '-stdinrpcpass', ...args], { stdio: ['pipe', 'inherit', 'inherit'] });
child.stdin.end(`${password}\n`);
child.on('error', error => { throw error; });
child.on('close', code => { process.exitCode = code ?? 1; });
