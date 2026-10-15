import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PaymentStore } from './payments.js';
import type { DecodedLightning } from './wallet.js';

test('un intento persistente impedisce doppi invii e resta unknown dopo timeout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'airgb-payments-'));
  let sends = 0;
  let nativeStatus = 'Pending';
  const decoded: DecodedLightning = { invoice: 'lnbcrt-demo', network: 'regtest', paymentHash: 'f'.repeat(64), payeePubkey: null, amountMsat: '1000', assetId: null, assetAmount: null, expiresAt: Date.now() + 60000, description: null };
  const wallet = { canSend: true, decodeLightning: async () => decoded, sendLightning: async () => { sends++; throw new Error('timeout'); }, paymentStatus: async () => ({ status: nativeStatus }) };
  let store: PaymentStore | null = null;
  try {
    store = new PaymentStore(dir, wallet);
    const first = await store.prepare({ id: 'intent-0001', invoice: decoded.invoice, constraints: {} });
    assert.equal(first.status, 'prepared');
    assert.equal((await store.prepare({ id: 'intent-0001', invoice: decoded.invoice })).id, first.id);
    await assert.rejects(store.prepare({ id: 'intent-0002', invoice: decoded.invoice }));
    await assert.rejects(store.prepare({ id: 'intent-0003', invoice: decoded.invoice, constraints: { feeLimit: '10' } }));
    const [one, two] = await Promise.all([store.confirm(first.id), store.confirm(first.id)]);
    assert.equal(sends, 1);
    assert.equal(one.status, 'unknown'); assert.equal(two.status, 'unknown');
    store.close(); store = new PaymentStore(dir, wallet);
    assert.equal((await store.confirm(first.id)).status, 'unknown');
    assert.equal(sends, 1);
    assert.equal((await store.reconcile(first.id)).status, 'pending');
    nativeStatus = 'Succeeded';
    assert.equal((await store.listReconciled())[0].status, 'succeeded');
    assert.equal(sends, 1);
  } finally { store?.close(); await rm(dir, { recursive: true, force: true }); }
});
