import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VaultStore } from './vault.js';
import { RgbWallet } from './wallet.js';
import { prepareRlnStorage } from './rln.js';
import type { PaymentRouting } from '../../packages/contracts/types.js';

test('keystore cifra entropia, recupera frase e respinge password errata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'airgb-vault-'));
  try {
    const store = new VaultStore(dir);
    const phrase = await store.create('password-di-test-lunga');
    assert.equal(phrase?.split(' ').length, 12);
    assert.equal(await store.exists(), true);
    assert.equal(await store.unlockMnemonic('password-di-test-lunga'), phrase);
    await assert.rejects(store.unlockMnemonic('password-errata-lunga'));
    await assert.rejects(store.create('un-altra-password-lunga'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('decoder Lightning verifica rete, scadenza e campi RGB', async () => {
  const wallet = new RgbWallet(join(tmpdir(), 'airgb-unused'));
  const invoice = 'lnbcrt' + 'a'.repeat(40);
  const base = { network: 'regtest', payment_hash: 'a'.repeat(64), timestamp: Math.floor(Date.now() / 1000), expiry_sec: 3600, amt_msat: 3000000, asset_id: 'rgb:test-contract', asset_amount: 2 };
  (wallet as unknown as { account: unknown }).account = { decodeInvoice: async () => base };
  const decoded = await wallet.decodeLightning(invoice);
  assert.equal(decoded.amountMsat, '3000000');
  assert.equal(decoded.assetId, 'rgb:test-contract');
  assert.equal(decoded.assetAmount, '2');
  (wallet as unknown as { account: unknown }).account = { decodeInvoice: async () => ({ ...base, network: 'testnet' }) };
  await assert.rejects(wallet.decodeLightning(invoice));
  (wallet as unknown as { account: unknown }).account = { decodeInvoice: async () => ({ ...base, timestamp: 1 }) };
  await assert.rejects(wallet.decodeLightning(invoice));
});

test('canali normalizzano liquidità direzionale e importi RGB del binding nativo', async () => {
  const wallet = new RgbWallet(join(tmpdir(), 'airgb-unused-channels'));
  (wallet as unknown as { account: unknown }).account = { listChannels: async () => [{
    channel_id: 'channel-test', peer_pubkey: 'peer-test', capacity_sat: '150000',
    outbound_balance_msat: '142840000', inbound_balance_msat: 0,
    asset_id: 'rgb:test', asset_local_amount: '10000', asset_remote_amount: '0',
    is_usable: true, public: false, funding_txid: 'ab'.repeat(32),
  }] };
  const [channel] = await wallet.channels();
  assert.equal(channel.outboundMsat, '142840000');
  assert.equal(channel.inboundMsat, '0');
  assert.equal(channel.assetLocalAmount, '10000');
  assert.equal(channel.assetRemoteAmount, '0');
  assert.equal(channel.fundingTxid, 'ab'.repeat(32));
});

test('la fork MPP rifiuta lo stato UTEXO senza modificarlo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'airgb-signer-state-'));
  try {
    const legacy = join(dir, 'wdk-rgb-lightning');
    await mkdir(legacy);
    await writeFile(join(legacy, 'previous-native-state'), 'state');
    await assert.rejects(prepareRlnStorage(dir), { code: 'LEGACY_NODE_STATE' });
    assert.equal(await readFile(join(legacy, 'previous-native-state'), 'utf8'), 'state');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('ricezione RGB generica richiede una scelta esplicita e rifiuta importi senza asset', async () => {
  const wallet = new RgbWallet(join(tmpdir(), 'airgb-unused-rgb-receive'));
  let calls = 0;
  (wallet as unknown as { account: unknown }).account = { createRgbInvoice: async (request: Record<string, unknown>) => {
    calls++;
    assert.equal(Object.hasOwn(request, 'asset_id'), false);
    assert.equal(Object.hasOwn(request, 'assignment_amount'), false);
    return { invoice: 'rgb:test-generic-invoice' };
  } };
  await assert.rejects(wallet.createRgbInvoice({ assetId: null, amount: '1000', expirySec: 3600 }));
  await assert.rejects(wallet.createRgbInvoice({ assetId: 'rgb:test', amount: null, expirySec: 3600 }));
  assert.equal(calls, 0);
  assert.equal((await wallet.createRgbInvoice({ assetId: null, amount: null, expirySec: 3600 })).invoice, 'rgb:test-generic-invoice');
  assert.equal(calls, 1);
});

test('parametri UTXO invalidi bloccano la mutazione nativa', async () => {
  const wallet = new RgbWallet(join(tmpdir(), 'airgb-unused-rgb-utxos'));
  let calls = 0;
  (wallet as unknown as { account: unknown }).account = { createUtxos: async () => { calls++; } };
  const valid = { count: 4, sizeSat: '200000', feeRateSatPerVbyte: '2' };
  for (const invalid of [{ ...valid, count: 0 }, { ...valid, sizeSat: '-1' }, { ...valid, sizeSat: '1' }, { ...valid, feeRateSatPerVbyte: '101' }]) {
    await assert.rejects(wallet.prepareRgbUtxos(invalid));
  }
  assert.equal(calls, 0);
  assert.equal((await wallet.prepareRgbUtxos(valid)).status, 'requested');
  assert.equal(calls, 1);
});

test('UTXO RGB già presenti non sono un errore', async () => {
  const wallet = new RgbWallet(join(tmpdir(), 'airgb-unused-rgb-utxos-ready'));
  (wallet as unknown as { account: unknown }).account = { createUtxos: async () => { throw new Error('Rln(Conflict): Allocations already available'); } };
  assert.deepEqual(await wallet.prepareRgbUtxos({ count: 4, sizeSat: '200000', feeRateSatPerVbyte: '2' }), { status: 'ready', confirmationRequired: false });
});

test('issueNia rifiuta input invalidi e inoltra il body NIA valido', async () => {
  const wallet = new RgbWallet(join(tmpdir(), 'airgb-unused-issue'));
  let calls = 0;
  let request: unknown;
  (wallet as unknown as { account: unknown }).account = {
    issueAssetNia: async (body: unknown) => {
      calls++;
      request = body;
      return { asset: { asset_id: 'rgb:test-asset', issued_supply: 1000 } };
    },
    sync: async () => undefined,
    refreshTransfers: async () => undefined,
  };
  const valid = { ticker: 'DEMO', name: 'Demo', precision: 0, amounts: [1000] };
  for (const invalid of [
    { ...valid, ticker: 'd' },
    { ...valid, name: 'riga\nrotta' },
    { ...valid, precision: 7 },
    { ...valid, amounts: [] },
    { ...valid, amounts: [0] },
  ]) await assert.rejects(wallet.issueNia(invalid));
  assert.equal(calls, 0);
  const issued = await wallet.issueNia(valid);
  assert.equal(calls, 1);
  assert.deepEqual(request, valid);
  assert.equal(issued.assetId, 'rgb:test-asset');
  assert.equal(issued.issuedSupply, '1000');
});

test('listAssets accetta gli schemi non richiesti null della fork', async () => {
  const wallet = new RgbWallet(join(tmpdir(), 'airgb-unused-assets'));
  (wallet as unknown as { account: unknown }).account = { listAssets: async () => ({ nia: [{ asset_id: 'rgb:test', ticker: 'TEST', name: 'Test' }], uda: null, cfa: [], ifa: null }) };
  assert.deepEqual(await wallet.assets(), [{ assetId: 'rgb:test', ticker: 'TEST', name: 'Test', kind: 'nia' }]);
});

test('sendLightning inoltra il routing scelto per invoice BTC, RGB e senza importo', async () => {
  const wallet = new RgbWallet(join(tmpdir(), 'airgb-unused-send-routing'));
  const previous = process.env.ENABLE_REGTEST_SEND;
  process.env.ENABLE_REGTEST_SEND = '1';
  let body: unknown;
  (wallet as unknown as { account: unknown }).account = { sendPayment: async (request: unknown) => { body = request; return { status: 'Pending' }; } };
  const base = { invoice: 'lnbcrt-routing', network: 'regtest' as const, paymentHash: 'a'.repeat(64), payeePubkey: null, amountMsat: '3000000', assetId: null, assetAmount: null, expiresAt: Date.now() + 60000, description: null };
  const policies: PaymentRouting[] = [{ algorithm: 'ldk_dijkstra' }, { algorithm: 'yen' }, { algorithm: 'min_cost_flow' }, { algorithm: 'multi_objective', weights: { fee: 1, reliability: 2, cltv: 1, hops: 10 } }];
  try {
    for (const routing of policies) {
      await wallet.sendLightning(base, '3000000', routing);
      assert.deepEqual(body, { invoice: base.invoice, routing });
      await wallet.sendLightning({ ...base, amountMsat: null }, '3000000', routing);
      assert.deepEqual(body, { invoice: base.invoice, amt_msat: 3000000, routing });
      await wallet.sendLightning({ ...base, assetId: 'rgb:test', assetAmount: '10' }, '3000000', routing);
      assert.deepEqual(body, { invoice: base.invoice, asset_id: 'rgb:test', asset_amount: 10, routing });
    }
  } finally {
    if (previous === undefined) delete process.env.ENABLE_REGTEST_SEND;
    else process.env.ENABLE_REGTEST_SEND = previous;
  }
});
