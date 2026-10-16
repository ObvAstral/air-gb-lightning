import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'airgb-api-smoke-'));
const reservation = createServer();
await new Promise((accept, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', accept); });
const port = reservation.address().port;
await new Promise(accept => reservation.close(accept));
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
  cwd: join(root, 'apps/local-service'),
  env: { ...process.env, PORT: String(port), AIRGB_WEB_PORT: '5173', AIRGB_DATA_DIR: directory, ENABLE_REGTEST_SEND: '0' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let startupError = '';
let processError = null;
child.once('error', error => { processError = error; });
child.stderr.on('data', chunk => { startupError = (startupError + chunk).slice(-4000); });
const exited = new Promise(accept => child.once('close', accept));
const request = async (path, headers = {}, body) => {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, body: await response.json() };
};
try {
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (processError) throw processError;
    if (child.exitCode !== null) throw new Error(`API non avviata: ${startupError}`);
    try { ready = (await request('/api/health')).status === 200; } catch { /* Wait for the server to listen. */ }
    if (ready) break;
    await new Promise(accept => setTimeout(accept, 200));
  }
  assert.equal(ready, true, 'API non raggiungibile');
  const badHostStatus = await new Promise((accept, reject) => {
    const req = httpRequest(base + '/api/health', { headers: { host: `evil.invalid:${port}` } }, response => {
      response.resume(); response.once('end', () => accept(response.statusCode));
    });
    req.once('error', reject); req.setTimeout(5000, () => req.destroy(new Error('Timeout HTTP'))); req.end();
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await request('/api/session', { origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await request('/api/wallet/state')).status, 403);
  const { body: session } = await request('/api/session');
  assert.match(session.token, /^[0-9a-f]{64}$/);
  const authorized = { 'x-session-token': session.token, origin: 'http://127.0.0.1:5173' };
  const state = await request('/api/wallet/state', authorized);
  assert.equal(state.status, 200);
  assert.equal(state.body.node, 'locked');
  assert.equal(state.body.keystoreExists, false);
  assert.equal((await request('/api/payments/prepare', { 'x-session-token': session.token }, {})).status, 403);
  assert.equal((await request('/api/wallet/state', { ...authorized, 'x-session-token': 'invalid' })).status, 403);
  const blocked = await request('/api/payments/prepare', authorized, { id: 'smoke-constraint-01', invoice: 'lnbcrt-unused', constraints: { feeLimitMsat: '0' } });
  assert.equal(blocked.status, 422);
  assert.equal(blocked.body.code, 'CONSTRAINT_UNSUPPORTED');
  for (const routing of [undefined, { algorithm: 'auto' }, { algorithm: 'multi_objective' }]) {
    const invalid = await request('/api/payments/prepare', authorized, { id: 'smoke-routing-01', invoice: 'lnbcrt-unused', routing });
    assert.equal(invalid.status, 422);
    assert.equal(invalid.body.code, 'INVALID_ROUTING');
  }
  const disabled = await request('/api/payments/confirm', authorized, { id: 'smoke-constraint-01' });
  assert.equal(disabled.body.code, 'SEND_DISABLED');
  assert.deepEqual((await request('/api/payments', authorized)).body, []);
  process.stdout.write(JSON.stringify({ api: 'passed', session: 'passed', host: 'passed', origin: 'passed', unsupportedConstraintBlocked: true, intentsCreated: 0, paymentsSent: 0 }) + '\n');
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  await exited;
  await rm(directory, { recursive: true, force: true });
}
