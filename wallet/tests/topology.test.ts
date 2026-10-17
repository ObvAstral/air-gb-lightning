import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { interpretWithQvac } from '../apps/local-service/interpret.js';
import { compileConstraints } from '../packages/policy/compile.js';
import { PaymentStore } from '../apps/local-service/payments.js';
import { RgbWallet } from '../apps/local-service/wallet.js';
import { RlnAccount, RlnClient } from '../apps/local-service/rln.js';
import { assertRoutePlan, capabilities, enumeratePaths, loadHistory, maxFlowRgb, pathEdges, pathFee, referencePlans, resolved, topology } from './helpers/routing-fixtures.js';
import type { CompiledPolicy } from '../packages/contracts/types.js';

const history = loadHistory(20);
const pubkey = (id: string) => history.topology.nodes.find(node => node.id === id)!.pubkey;
const canonical = (paths: { nodes: string[]; amountMsat: string; assetAmount?: string | null }[]) => paths.map(path => JSON.stringify({ nodes: path.nodes, amountMsat: path.amountMsat, assetAmount: path.assetAmount ?? null })).sort();

test('topology.json definisce dieci nodi, quindici canali e nove percorsi con capacita RGB totale 100', () => {
  assert.equal(topology.nodes.length, 10); assert.equal(topology.channels.length, 15);
  assert.equal(new Set(topology.nodes.map(node => node.id)).size, 10);
  assert.equal(new Set(topology.nodes.flatMap(node => [node.apiPort, node.p2pPort])).size, 20);
  assert.equal(new Set(topology.scenarios.map(s => s.id)).size, topology.scenarios.length);
  assert.equal(topology.scenarios.length, 16);
  assert.deepEqual(topology.algorithmMatrix.map(a => a.algorithm), ['ldk_dijkstra', 'yen', 'min_cost_flow', 'multi_objective']);
  assert.equal(topology.channelDefaults.fee_proportional_millionths, 0, 'Extend the reference fee calculation before adding proportional fees');
  for (const asset of topology.assets) assert.equal(Object.values(asset.initialAllocations).reduce((sum, n) => sum + BigInt(n), 0n), BigInt(asset.supply));
  assert.equal(enumeratePaths(topology.scenarios[0]).length, 9);
  assert.equal(maxFlowRgb(topology.scenarios[0]), 100);
});

for (const scenario of topology.scenarios) {
  test(`${scenario.id}: fattibilita e percorsi attesi della fixture`, () => {
    if (['needs_clarification', 'rejected_before_submission'].includes(scenario.expected.outcome)) return;
    const plans = referencePlans(scenario);
    assert.equal(plans.length > 0, scenario.expected.graphFeasible, scenario.id);
    if (scenario.expected.paths) {
      assert(plans.some(plan => JSON.stringify(canonical(plan)) === JSON.stringify(canonical(scenario.expected.paths!))), 'Expected split was not feasible');
      assert.equal(scenario.expected.paths.reduce((sum, path) => sum + pathFee(path.nodes), 0), Number(scenario.expected.totalFeeMsat));
      assert.equal(scenario.expected.paths.length, scenario.expected.pathCount);
      if (resolved(scenario).routing.max_paths <= 2) assert.equal(plans.length, 1, 'Expected route must be forced by constraints, not assumed optimal');
    }
    if (scenario.expected.maximumDeliverableAssetAmount !== undefined) {
      const maximum = resolved(scenario).routing.max_paths === 1
        ? Math.max(0, ...enumeratePaths(scenario).map(path => Math.min(...pathEdges(path).map(edge => edge.asset_amount))))
        : maxFlowRgb(scenario);
      assert.equal(maximum, Number(scenario.expected.maximumDeliverableAssetAmount));
    }
  });
  test(`${scenario.id}: interpretazione, compilazione e payload RLN su tutti gli algoritmi`, async t => {
    const oldUrl = process.env.QVAC_URL, oldModel = process.env.QVAC_MODEL, oldSend = process.env.ENABLE_REGTEST_SEND;
    process.env.QVAC_URL = 'http://127.0.0.1:19001'; process.env.QVAC_MODEL = 'fixture-model'; process.env.ENABLE_REGTEST_SEND = '1';
    t.after(() => {
      for (const [key, value] of [['QVAC_URL', oldUrl], ['QVAC_MODEL', oldModel], ['ENABLE_REGTEST_SEND', oldSend]]) {
        if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
      }
    });
    for (const algorithm of topology.algorithmMatrix) await t.test(algorithm.algorithm, async child => {
      const directory = await mkdtemp(join(tmpdir(), 'airgb-topology-policy-'));
      const wallet = new RgbWallet(directory);
      Object.assign(wallet, { account: new RlnAccount(new RlnClient('http://127.0.0.1:19002', 'fixture-token'), 'rpc://fixture-proxy') });
      let store: PaymentStore = new PaymentStore(directory, wallet);
      child.after(async () => { store.close(); await wallet.shutdown(); await rm(directory, { recursive: true, force: true }); });
      const { payment, routing, extracted: expectedExtraction } = resolved(scenario);
      const invoice = 'lnbcrt' + createHash('sha256').update(scenario.id + algorithm.algorithm).digest('hex');
      const calls: Record<string, unknown>[] = [];
      child.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname === '/v1/chat/completions') {
          const body = JSON.parse(String(init?.body));
          assert.equal(body.messages[1].content, scenario.prompt);
          // The model returns no inferred constraints: test the real deterministic
          // sanitizer independently from the expected extraction in topology.json.
          return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(topology.expectedExtractionDefaults) } }] });
        }
        if (pathname === '/decodelninvoice') return Response.json({ network: 'regtest', payment_hash: invoice.slice(6),
          amt_msat: Number(payment.amountMsat), asset_id: payment.asset ? history.topology.channels[0].assetId : null,
          asset_amount: payment.assetAmount === null ? null : Number(payment.assetAmount), payee_pubkey: pubkey(payment.recipient),
          timestamp: Math.floor(Date.now() / 1000), expiry_sec: 3600 });
        if (pathname === '/sendpayment') {
          assert.equal(new Headers(init?.headers).get('x-airgb-rln-token'), 'fixture-token');
          calls.push(JSON.parse(String(init?.body)));
          // Transport contract only. No simulated route is reported as a Rust result.
          return Response.json({ status: 'Pending', payment_id: invoice.slice(6) });
        }
        throw new Error(`Unexpected RPC: ${pathname}`);
      });
      const decoded = await wallet.decodeLightning(invoice);
      const draft = { invoice, amount: payment.amountMsat, assetId: decoded.assetId ?? 'BTC', network: 'regtest' as const };
      const extracted = scenario.prompt ? (await interpretWithQvac(scenario.prompt)).extracted : expectedExtraction;
      assert.deepEqual(extracted, expectedExtraction);
      const compiled = compileConstraints({ extracted, payment: draft, capabilities, knownNodes: history.knownNodes, payeePubkey: decoded.payeePubkey });
      if (scenario.expected.outcome === 'needs_clarification' || scenario.expected.outcome === 'rejected_before_submission') {
        assert.equal(compiled.status, scenario.expected.outcome === 'needs_clarification' ? 'needs_clarification' : 'conflict');
        assert.equal(compiled.policy, null); assert.deepEqual(store.list(), []); assert.equal(calls.length, 0);
        return;
      }
      assert.equal(compiled.status, 'validated');
      // The fixture default fee budget is a manual limit, not inferred AI text.
      const policy = compileConstraints({ extracted: { ...extracted, feeLimit: extracted.feeLimit ?? { value: String(routing.max_fee_msat), unit: 'msat', comparison: 'lte' } },
        payment: draft, capabilities, knownNodes: history.knownNodes, payeePubkey: decoded.payeePubkey }).policy!;
      const base = { ...algorithm, max_paths: routing.max_paths };
      const expected = { ...base, max_fee_msat: routing.max_fee_msat,
        ...(routing.excludedNodeIds.length ? { excluded_nodes: routing.excludedNodeIds.map(pubkey) } : {}) };
      const prepared = await store.prepare({ id: 'fixture-intent-0001', invoice, constraints: policy, routing: base });
      assert.deepEqual(prepared.routing, expected);
      const changed: CompiledPolicy = { ...policy, hard: { ...policy.hard, maxRoutingFeeMsat: String(routing.max_fee_msat + 1) } };
      await assert.rejects(store.prepare({ id: prepared.id, invoice, constraints: changed, routing: base }), { code: 'INTENT_CONFLICT' });
      store.close(); store = new PaymentStore(directory, wallet);
      assert.deepEqual(store.get(prepared.id)?.routing, expected);
      assert.equal((await store.confirm(prepared.id)).status, 'pending');
      await store.confirm(prepared.id);
      assert.equal(calls.length, 1); assert.deepEqual(calls[0].routing, expected);
      assert.equal(calls[0].invoice, invoice);
      if (payment.asset) assert.equal(calls[0].asset_amount, Number(payment.assetAmount));
    });
  });
}

test('il controllo dei percorsi respinge violazioni di fee, esclusioni, capacita condivisa, cicli e canali inesistenti', () => {
  const mpp = topology.scenarios.find(s => s.id === 'mpp-60-40')!;
  assertRoutePlan(mpp, mpp.expected.paths!);
  assert.throws(() => assertRoutePlan({ ...mpp, routing: { ...mpp.routing, max_fee_msat: 8999 } }, mpp.expected.paths!), /aggregate fee budget/);
  assert.throws(() => assertRoutePlan({ ...mpp, routing: { ...mpp.routing, excludedNodeIds: ['bob'] } }, mpp.expected.paths!), /excluded node/);
  assert.throws(() => assertRoutePlan({ ...mpp, routing: { ...mpp.routing, max_paths: 1 } }, mpp.expected.paths!), /path count/);
  const excessive = structuredClone(mpp.expected.paths!); excessive[0].assetAmount = '61'; excessive[1].assetAmount = '39';
  assert.throws(() => assertRoutePlan(mpp, excessive), /shared RGB capacity/);
  const baseline = topology.scenarios[0];
  assert.throws(() => assertRoutePlan(baseline, [{ nodes: ['alice', 'judy'], amountMsat: '10000000', assetAmount: '30' }]), /Unknown directed topology edge/);
  assert.throws(() => assertRoutePlan(baseline, [{ nodes: ['alice', 'bob', 'alice', 'judy'], amountMsat: '10000000', assetAmount: '30' }]), /cyclic route/);
});
