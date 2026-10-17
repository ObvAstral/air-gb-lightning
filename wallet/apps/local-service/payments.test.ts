import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PaymentStore } from './payments.js';
import type { DecodedLightning } from './wallet.js';
import type { PaymentRouting } from '../../packages/contracts/types.js';
import { compileConstraints } from '../../packages/policy/compile.js';

test('un intento persistente impedisce doppi invii e resta unknown dopo timeout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'airgb-payments-'));
  let sends = 0;
  let nativeStatus = 'Pending';
  const routing = { algorithm: 'yen' };
  const decoded: DecodedLightning = { invoice: 'lnbcrt-demo', network: 'regtest', paymentHash: 'f'.repeat(64), payeePubkey: null, amountMsat: '1000', assetId: null, assetAmount: null, expiresAt: Date.now() + 60000, description: null };
  const wallet = { canSend: true, decodeLightning: async () => decoded, sendLightning: async (_decoded: DecodedLightning, _amount: string, selected: PaymentRouting) => { assert.deepEqual(selected, routing); sends++; throw new Error('timeout'); }, paymentStatus: async () => ({ status: nativeStatus }) };
  let store: PaymentStore | null = null;
  try {
    store = new PaymentStore(dir, wallet);
    const first = await store.prepare({ id: 'intent-0001', invoice: decoded.invoice, constraints: {}, routing });
    assert.equal(first.status, 'prepared');
    assert.equal((await store.prepare({ id: 'intent-0001', invoice: decoded.invoice, routing })).id, first.id);
    await assert.rejects(store.prepare({ id: 'intent-0001', invoice: decoded.invoice, routing: { algorithm: 'min_cost_flow' } }), { code: 'INTENT_CONFLICT' });
    await assert.rejects(store.prepare({ id: 'intent-0002', invoice: decoded.invoice, routing }), { code: 'DUPLICATE_INVOICE' });
    await assert.rejects(store.prepare({ id: 'intent-0003', invoice: decoded.invoice, constraints: { feeLimit: '10' } }));
    const [one, two] = await Promise.all([store.confirm(first.id), store.confirm(first.id)]);
    assert.equal(sends, 1);
    assert.equal(one.status, 'unknown'); assert.equal(two.status, 'unknown');
    store.close(); store = new PaymentStore(dir, wallet);
    assert.deepEqual(store.get(first.id)?.routing, routing);
    assert.equal((await store.confirm(first.id)).status, 'unknown');
    assert.equal(sends, 1);
    assert.equal((await store.reconcile(first.id)).status, 'pending');
    nativeStatus = 'Succeeded';
    assert.equal((await store.listReconciled())[0].status, 'succeeded');
    assert.equal(sends, 1);
  } finally { store?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('algoritmo e pesi persistono prima della conferma e vengono inviati senza fallback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'airgb-routing-'));
  const decoded: DecodedLightning = { invoice: 'lnbcrt-routing', network: 'regtest', paymentHash: 'a'.repeat(64), payeePubkey: null, amountMsat: '3000000', assetId: 'rgb:test', assetAmount: '10', expiresAt: Date.now() + 60000, description: null };
  let selected: PaymentRouting | null = null;
  let sends = 0;
  const wallet = { canSend: true, decodeLightning: async () => decoded, sendLightning: async (_decoded: DecodedLightning, _amount: string, routing: PaymentRouting) => { selected = routing; sends++; return { status: 'Failed' }; }, paymentStatus: async () => ({ status: 'Failed' }) };
  let store: PaymentStore | null = null;
  const policies: PaymentRouting[] = [{ algorithm: 'ldk_dijkstra' }, { algorithm: 'yen' }, { algorithm: 'min_cost_flow' }, { algorithm: 'multi_objective', weights: { fee: 1, reliability: 2, cltv: 0, hops: 10 } }];
  try {
    for (const [index, routing] of policies.entries()) {
      decoded.paymentHash = String(index).repeat(64);
      decoded.invoice = `lnbcrt-routing-${index}`;
      store = new PaymentStore(dir, wallet);
      const prepared = await store.prepare({ id: `routing-000${index}`, invoice: decoded.invoice, routing });
      if (routing.algorithm === 'multi_objective') await assert.rejects(store.prepare({ id: prepared.id, invoice: decoded.invoice, routing: { ...routing, weights: { ...routing.weights, fee: 2 } } }), { code: 'INTENT_CONFLICT' });
      store.close(); store = new PaymentStore(dir, wallet);
      assert.deepEqual(store.get(prepared.id)?.routing, routing);
      assert.equal((await store.confirm(prepared.id)).status, 'failed');
      assert.deepEqual(selected, routing);
      assert.equal(sends, index + 1);
      await store.confirm(prepared.id);
      assert.equal(sends, index + 1);
      store.close(); store = null;
    }
  } finally { store?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('routing assente, algoritmi sconosciuti e pesi invalidi non creano intenti', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'airgb-invalid-routing-'));
  let decodes = 0;
  const wallet = { canSend: true, decodeLightning: async (): Promise<DecodedLightning> => { decodes++; throw new Error('non deve decodificare'); }, sendLightning: async () => ({}), paymentStatus: async () => ({}) };
  const store = new PaymentStore(dir, wallet);
  try {
    const weights = { fee: 1, reliability: 2, cltv: 1, hops: 10 };
    const invalid = [undefined, null, {}, [], { algorithm: 'auto' }, { algorithm: 'yen', weights }, { algorithm: 'yen', max_fee_msat: 10 }, { algorithm: 'multi_objective' }, { algorithm: 'multi_objective', weights: {} }, ...[
      { fee: 0, reliability: 0, cltv: 0, hops: 0 }, { ...weights, fee: -1 }, { ...weights, fee: 0.5 }, { ...weights, fee: 1000001 }, { ...weights, fee: '1' }, { ...weights, extra: 1 },
    ].map(weights => ({ algorithm: 'multi_objective', weights }))];
    for (const routing of invalid) await assert.rejects(store.prepare({ id: 'invalid-0001', invoice: 'lnbcrt-unused', routing }), { code: 'INVALID_ROUTING' });
    assert.equal(decodes, 0);
    assert.deepEqual(store.list(), []);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('la migrazione conserva gli intenti precedenti con ldk_dijkstra', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'airgb-legacy-routing-'));
  const legacy = new DatabaseSync(join(dir, 'payments.sqlite'));
  legacy.exec('CREATE TABLE intents (id TEXT PRIMARY KEY, payment_hash TEXT UNIQUE NOT NULL, invoice TEXT NOT NULL, amount_msat TEXT NOT NULL, asset_id TEXT, asset_amount TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, native_payment_id TEXT)');
  legacy.prepare('INSERT INTO intents VALUES (?,?,?,?,?,?,?,?,?,?)').run('legacy-0001', 'b'.repeat(64), 'lnbcrt-legacy', '1000', null, null, 'prepared', 1, 1, null);
  legacy.close();
  const decoded: DecodedLightning = { invoice: 'lnbcrt-legacy', network: 'regtest', paymentHash: 'b'.repeat(64), payeePubkey: null, amountMsat: '1000', assetId: null, assetAmount: null, expiresAt: Date.now() + 60000, description: null };
  let sent: PaymentRouting | null = null;
  const wallet = { canSend: true, decodeLightning: async () => decoded, sendLightning: async (_decoded: DecodedLightning, _amount: string, routing: PaymentRouting) => { sent = routing; return { status: 'Pending' }; }, paymentStatus: async () => ({}) };
  const store = new PaymentStore(dir, wallet);
  try {
    assert.deepEqual(store.get('legacy-0001')?.routing, { algorithm: 'ldk_dijkstra' });
    assert.equal((await store.confirm('legacy-0001')).status, 'pending');
    assert.deepEqual(sent, { algorithm: 'ldk_dijkstra' });
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('CompiledPolicy validata applica max_fee_msat, excluded_nodes e max_paths al routing inviato a RLN', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'airgb-policy-routing-'));
  const bobPubkey = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
  const decoded: DecodedLightning = { invoice: 'lnbcrt-policy', network: 'regtest', paymentHash: 'c'.repeat(64), payeePubkey: null, amountMsat: '5000000', assetId: null, assetAmount: null, expiresAt: Date.now() + 60000, description: null };
  let sentRouting: PaymentRouting | null = null;
  const wallet = {
    canSend: true,
    decodeLightning: async () => decoded,
    sendLightning: async (_decoded: DecodedLightning, _amount: string, routing: PaymentRouting) => {
      sentRouting = routing;
      return { status: 'Succeeded', payment_id: 'pid-01' };
    },
    paymentStatus: async () => ({ status: 'Succeeded' }),
  };
  const compiled = compileConstraints({
    extracted: {
      schemaVersion: '1.0',
      status: 'parsed',
      feeLimit: { value: '10', unit: 'sat', comparison: 'lte' },
      excludedNodeReferences: ['Bob'],
      priority: 'reliability',
      privacyRequest: 'avoid_extra_probing',
      unhandledRequests: [],
    },
    payment: { invoice: decoded.invoice, amount: decoded.amountMsat!, assetId: 'BTC', network: 'regtest' },
    capabilities: {
      backendVersion: 'ObvAstral/rgb-lightning-node@7106edd0fa3d',
      revision: 'rgb-mpp-1',
      hardFeeCap: true,
      hardNodeExclusion: true,
      hardChannelExclusion: false,
      perPaymentScoringProfile: true,
      avoidExtraProbing: true,
      canInspectFullRoute: true,
      canGuaranteeConstraintsAcrossRetries: true,
    },
    knownNodes: [{ alias: 'Bob', pubkey: bobPubkey }],
  });
  assert.equal(compiled.status, 'validated');
  const store = new PaymentStore(dir, wallet);
  try {
    const prepared = await store.prepare({
      id: 'policy-intent-01',
      invoice: decoded.invoice,
      constraints: compiled.policy,
      routing: { algorithm: 'yen' },
    });
    assert.deepEqual(prepared.routing, {
      algorithm: 'yen',
      max_fee_msat: 10000,
      excluded_nodes: [bobPubkey],
      max_paths: 1,
    });
    const confirmed = await store.confirm(prepared.id);
    assert.equal(confirmed.status, 'succeeded');
    assert.deepEqual(sentRouting, {
      algorithm: 'yen',
      max_fee_msat: 10000,
      excluded_nodes: [bobPubkey],
      max_paths: 1,
    });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
