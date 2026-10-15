import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VaultStore } from './vault.js';
import { WdkWallet } from './wallet.js';
import { prepareSignerStorage } from './persistent-signer.js';

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
  const wallet = new WdkWallet(join(tmpdir(), 'airgb-unused'));
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
  const wallet = new WdkWallet(join(tmpdir(), 'airgb-unused-channels'));
  (wallet as unknown as { account: unknown }).account = { listChannels: async () => [{
    channel_id: 'channel-test', peer_pubkey: 'peer-test', capacity_sat: '150000',
    outbound_balance_msat: '142840000', inbound_balance_msat: 0,
    asset_id: 'rgb:test', asset_local_amount: '10000', asset_remote_amount: '0',
    is_usable: true, public: false,
  }] };
  const [channel] = await wallet.channels();
  assert.equal(channel.outboundMsat, '142840000');
  assert.equal(channel.inboundMsat, '0');
  assert.equal(channel.assetLocalAmount, '10000');
  assert.equal(channel.assetRemoteAmount, '0');
});

test('il signer persistente rifiuta stato nativo precedente privo di stato VLS', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'airgb-signer-state-'));
  try {
    await prepareSignerStorage(dir);
    await writeFile(join(dir, 'previous-native-state'), 'state');
    await assert.rejects(prepareSignerStorage(dir), { code: 'SIGNER_STATE_MISSING' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('ricezione RGB generica richiede una scelta esplicita e rifiuta importi senza asset', async () => {
  const wallet = new WdkWallet(join(tmpdir(), 'airgb-unused-rgb-receive'));
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
  const wallet = new WdkWallet(join(tmpdir(), 'airgb-unused-rgb-utxos'));
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
