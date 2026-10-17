import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RlnAccount, RlnClient, RlnDaemon, verifiedBinary } from './rln.js';
import sourceLock from '../../infra/native/source-lock.json' with { type: 'json' };

async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  return { client: new RlnClient(`http://127.0.0.1:${port}`), close: async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}

test('il runtime rifiuta un binario alterato o compilato da un altro commit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'airgb-artifact-test-'));
  const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
  const binary = join(directory, 'rgb-lightning-node');
  const manifest = {
    source: sourceLock, platform: process.platform, arch: process.arch,
    patchSha256: hash(await readFile(join(import.meta.dirname, '../../infra/native/loopback.patch'))),
    telemetryPatchSha256: hash(await readFile(join(import.meta.dirname, '../../infra/native/benchmark-telemetry.patch'))),
    binarySha256: hash('test-binary'),
  };
  try {
    await writeFile(binary, 'test-binary');
    await writeFile(join(directory, 'build.json'), JSON.stringify(manifest));
    assert.equal(await verifiedBinary(directory), binary);
    await writeFile(binary, 'altered-binary');
    await assert.rejects(verifiedBinary(directory), { code: 'RLN_BUILD_REQUIRED' });
    await writeFile(binary, 'test-binary');
    await writeFile(join(directory, 'build.json'), JSON.stringify({ ...manifest, source: { ...sourceLock, lightning: { ...sourceLock.lightning, commit: '0'.repeat(40) } } }));
    await assert.rejects(verifiedBinary(directory), { code: 'RLN_BUILD_REQUIRED' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('REST della fork: invoice, sync e pagamenti mantengono importi e stato', async () => {
  const calls: { path: string; method: string; body: Record<string, unknown> }[] = [];
  const payment = { payment_hash: 'f'.repeat(64), asset_id: 'rgb:test', asset_amount: 100, amt_msat: 10_000_000, status: 'Succeeded' };
  const api = await fixture(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    calls.push({ path: req.url!, method: req.method!, body: raw ? JSON.parse(raw) : {} });
    const data = req.url === '/getpayment' ? { payment }
      : req.url === '/listpayments' ? { payments: [payment] }
      : req.url === '/btcbalance' ? { vanilla: { spendable: 500000 }, colored: { spendable: 10000 } }
      : req.url === '/lninvoice' ? { invoice: 'lnbcrt-test-mpp' } : {};
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data));
  });
  try {
    const account = new RlnAccount(api.client, 'rpc://proxy:3000/json-rpc');
    await account.createLightningInvoice({ amountMsat: 10_000_000, expirySec: 3600, assetId: 'rgb:test', assetAmount: 100 });
    await account.sync();
    await account.createRgbInvoice({ asset_id: 'rgb:test', assignment_amount: 25, duration_seconds: 3600, min_confirmations: 1, witness: false });
    await account.listTransfers('rgb:test');
    assert.deepEqual(await account.getPayment(payment.payment_hash), payment);
    assert.deepEqual(await account.listPayments(), [payment]);
    assert.equal(await account.getBalance(), 500000n);
    assert.deepEqual(calls[0], { path: '/lninvoice', method: 'POST', body: { amt_msat: 10_000_000, expiry_sec: 3600, asset_id: 'rgb:test', asset_amount: 100 } });
    assert.deepEqual(calls[1].body, { options: { keychain: { Vanilla: { lookback: 20 } }, strategy: 'FullSync' } });
    assert.deepEqual(calls[2].body, { options: { keychain: 'Colored', strategy: 'FullSync' } });
    const invoice = calls[3].body;
    assert.deepEqual(invoice.assignment, { type: 'Fungible', value: 25 });
    assert.deepEqual(invoice.transport_endpoints, ['rpc://proxy:3000/json-rpc']);
    assert.ok(Number(invoice.expiration_timestamp) > Date.now() / 1000 + 3500);
    assert.equal(Object.hasOwn(invoice, 'duration_seconds'), false);
    assert.deepEqual(calls[4].body, { asset_filter: { type: 'Id', value: 'rgb:test' } });
    assert.equal(calls[6].method, 'GET');
  } finally { await api.close(); }
});

test('un timeout dopo sendpayment non ritenta la mutazione', async () => {
  let sends = 0;
  const api = await fixture((req, _res) => { if (req.url === '/sendpayment') { sends++; req.socket.destroy(); } });
  try {
    const account = new RlnAccount(api.client, 'rpc://proxy');
    await assert.rejects(account.sendPayment({ invoice: 'lnbcrt-test' }));
    assert.equal(sends, 1);
  } finally { await api.close(); }
});

test('gli errori REST conservano il nome senza accettare risposte malformate', async () => {
  const api = await fixture((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/nodeinfo') { res.statusCode = 403; res.end(JSON.stringify({ name: 'LockedNode', error: 'Node is locked', code: 403 })); }
    else res.end('[]');
  });
  try {
    await assert.rejects(api.client.request('nodeinfo'), { code: 'LockedNode' });
    await assert.rejects(api.client.request('listpayments'), { code: 'RLN_SHAPE' });
  } finally { await api.close(); }
});

test('il servizio avvia il daemon con porte distinte e attende la chiusura', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'airgb-daemon-test-'));
  const fake = join(directory, 'fake-daemon.cjs');
  await writeFile(fake, `
    const { createServer } = require('node:http');
    const args = process.argv.slice(2);
    if (!args.includes('--disable-authentication') || args[args.indexOf('--network') + 1] !== 'regtest') process.exit(2);
    if (!/^[0-9a-f]{64}$/.test(process.env.AIRGB_RLN_TOKEN ?? '')) process.exit(3);
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.headers['x-airgb-rln-token'] !== process.env.AIRGB_RLN_TOKEN) { res.statusCode = 403; res.end('{}'); return; }
      if (req.url === '/nodeinfo') { res.statusCode = 403; res.end(JSON.stringify({ name: 'LockedNode', error: 'locked' })); }
      else { res.end('{}'); if (req.url === '/shutdown') server.close(); }
    });
    server.listen(Number(args[args.indexOf('--daemon-listening-port') + 1]), '127.0.0.1');
  `);
  const daemon = new RlnDaemon();
  try {
    const client = await daemon.start(directory, 9735, process.execPath, [fake]);
    assert.equal(daemon.running, true);
    assert.equal((await fetch(client.url + '/nodeinfo')).status, 403);
    assert.deepEqual(await client.request('sync', {}), {});
    await daemon.stop();
    assert.equal(daemon.running, false);
    await daemon.stop();
  } finally { await daemon.stop(); await rm(directory, { recursive: true, force: true }); }
});
