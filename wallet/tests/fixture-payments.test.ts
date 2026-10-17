import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PaymentStore } from '../apps/local-service/payments.js';
import { QvacRagStore } from '../apps/local-service/channel-scoring.js';
import { compileConstraints } from '../packages/policy/compile.js';
import { capabilities, loadHistory, topology } from './helpers/routing-fixtures.js';
import type { DecodedLightning } from '../apps/local-service/wallet.js';
import type { PaymentRouting } from '../packages/contracts/types.js';
const data = loadHistory(100);
const transaction = data.transactions.find(tx => tx.assetId && tx.paths.length === 1 && tx.outcome === 'succeeded')!;
const fixtureDecoded = (): DecodedLightning => ({ invoice: 'lnbcrt' + createHash('sha256').update(transaction.id).digest('hex'),
  paymentHash: createHash('sha256').update(transaction.id).digest('hex'), network: 'regtest', amountMsat: transaction.amountMsat,
  assetId: transaction.assetId, assetAmount: transaction.assetAmount, expiresAt: Date.now() + 60000, description: null,
  payeePubkey: data.topology.nodes.find(node => node.id === transaction.recipientNodeId)!.pubkey });

for (const outcome of ['succeeded', 'failed'] as const) test(`storico fixture: timeout, riavvio e riconciliazione ${outcome} non duplicano pagamenti o episodi`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'airgb-fixture-payment-'));
  const rag = new QvacRagStore(directory);
  const decoded = fixtureDecoded();
  let sends = 0, terminal = false, notifications = 0;
  const wallet = { canSend: true, decodeLightning: async () => decoded,
    sendLightning: async () => { sends++; throw new Error('simulated transport timeout after submission'); },
    paymentStatus: async () => ({ status: terminal ? outcome : 'Pending' }) };
  const episode = data.nodeHistories[transaction.senderNodeId].find(e => e.transactionId === transaction.id)!.episode;
  const onTerminal = () => { notifications++; rag.saveEpisodeLocal({ ...episode, outcome, eventType: outcome === 'succeeded' ? 'payment_succeeded' : 'payment_failed' }); };
  let store = new PaymentStore(directory, wallet, onTerminal);
  t.after(async () => { store.close(); rag.close(); await rm(directory, { recursive: true, force: true }); });
  const prepared = await store.prepare({ id: 'history-intent-0001', invoice: decoded.invoice, routing: transaction.routing.algorithm === 'multi_objective'
    ? { algorithm: 'multi_objective', weights: transaction.routing.weights } : { algorithm: transaction.routing.algorithm } });
  await Promise.all([store.confirm(prepared.id), store.confirm(prepared.id)]);
  assert.equal(sends, 1); assert.equal(notifications, 0);
  store.close(); store = new PaymentStore(directory, wallet, onTerminal);
  assert.equal((await store.confirm(prepared.id)).status, 'unknown'); assert.equal(sends, 1);
  assert.equal((await store.reconcile(prepared.id)).status, 'pending');
  terminal = true;
  assert.equal((await store.reconcile(prepared.id)).status, outcome);
  await store.confirm(prepared.id); await store.reconcile(prepared.id);
  assert.equal(sends, 1); assert.equal(notifications, 1);
  assert.equal(rag.listEpisodes().length, 1); assert.equal(rag.listEpisodes()[0].outcome, outcome);
});

test('policy e invoice della fixture: fingerprint diverso e destinatario escluso impediscono la preparazione', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'airgb-fixture-binding-'));
  const decoded = fixtureDecoded(); let sends = 0;
  const wallet = { canSend: true, decodeLightning: async () => decoded, sendLightning: async () => { sends++; return {}; }, paymentStatus: async () => ({}) };
  const store = new PaymentStore(directory, wallet);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const draft = { invoice: decoded.invoice, amount: decoded.amountMsat!, assetId: decoded.assetId!, network: 'regtest' as const };
  for (const changed of [{ ...draft, invoice: draft.invoice + '0' }, { ...draft, amount: String(BigInt(draft.amount) + 1n) }, { ...draft, assetId: 'BTC' }]) {
    const compiled = compileConstraints({ extracted: topology.expectedExtractionDefaults, payment: changed, capabilities, knownNodes: data.knownNodes });
    await assert.rejects(store.prepare({ id: 'binding-intent-001', invoice: decoded.invoice, routing: { algorithm: 'yen' }, constraints: compiled.policy }), { code: 'CONSTRAINT_MISMATCH' });
  }
  await assert.rejects(store.prepare({ id: 'binding-intent-001', invoice: decoded.invoice,
    routing: { algorithm: 'yen', excluded_nodes: [decoded.payeePubkey!] } }), { code: 'CONSTRAINT_CONFLICT' });
  assert.deepEqual(store.list(), []); assert.equal(sends, 0);
});

test('invoice della fixture modificata dopo prepare non viene inviata e i limiti aggiuntivi non perdono le esclusioni AI', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'airgb-fixture-confirm-'));
  const decoded = fixtureDecoded(); let sends = 0;
  const wallet = { canSend: true, decodeLightning: async () => decoded, sendLightning: async (_invoice: DecodedLightning, _amount: string, routing: PaymentRouting) => { sends++; return { status: 'Succeeded', routing }; }, paymentStatus: async () => ({}) };
  const store = new PaymentStore(directory, wallet);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const excluded = data.knownNodes.filter(n => n.pubkey !== decoded.payeePubkey).slice(0, 2);
  const policy = compileConstraints({ extracted: { ...topology.expectedExtractionDefaults,
    feeLimit: { value: '3', unit: 'sat', comparison: 'lte' }, excludedNodeReferences: [excluded[0].alias] },
    payment: { invoice: decoded.invoice, amount: decoded.amountMsat!, assetId: decoded.assetId!, network: 'regtest' }, capabilities, knownNodes: data.knownNodes }).policy!;
  const prepared = await store.prepare({ id: 'confirm-intent-001', invoice: decoded.invoice, constraints: policy,
    routing: { algorithm: 'yen', max_paths: 1, excluded_nodes: [excluded[1].pubkey] } });
  assert.deepEqual(new Set(prepared.routing.excluded_nodes), new Set(excluded.map(n => n.pubkey)));
  assert.equal(prepared.routing.max_fee_msat, 3000); assert.equal(prepared.routing.max_paths, 1);
  decoded.assetAmount = String(BigInt(decoded.assetAmount!) + 1n);
  await assert.rejects(store.confirm(prepared.id), { code: 'PAYMENT_CHANGED' });
  assert.equal(sends, 0); assert.equal(store.get(prepared.id)?.status, 'prepared');
});
