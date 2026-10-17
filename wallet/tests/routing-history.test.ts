import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QvacRagStore, formatTelemetryDocument } from '../apps/local-service/channel-scoring.js';
import { validNodeId } from '../packages/policy/compile.js';
import { fixtureDirectory, loadHistory, manifest, topology } from './helpers/routing-fixtures.js';
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');

test('i quattro storici sono riproducibili e gli hash corrispondono alla fixture dei canali', () => {
  assert.deepEqual(manifest.datasets.map(entry => entry.transactionCount), [20, 100, 500, 2000]);
  const fixtureIds = new Set(topology.channels.flatMap(channel => [channel.from, channel.to]));
  assert.equal(fixtureIds.size, 10);
  assert.equal(manifest.sourceTopologySha256, 'fca4997ba449b61045199f29a96122ec66e2184d71a8fdb787e66ab2262ec571');
  for (const entry of manifest.datasets) {
    const bytes = readFileSync(new URL(entry.filename, fixtureDirectory));
    assert.equal(sha(bytes), entry.sha256); assert.equal(bytes.length, entry.bytes);
  }
  const checked = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/generate-routing-history.mjs', import.meta.url)), '--check'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
});

for (const entry of manifest.datasets) {
  const data = loadHistory(entry.transactionCount);
  test(`${entry.filename}: topologia, saldi e osservazioni di tutte le transazioni`, () => {
    assert(data.synthetic);
    assert.equal(data.provenance.sourceTopologySha256, manifest.sourceTopologySha256);
    const fixtureIds = new Set(topology.channels.flatMap(channel => [channel.from, channel.to]));
    assert.deepEqual(data.topology.nodes.map(({ id, alias }) => ({ id, alias })), topology.nodes.filter(node => fixtureIds.has(node.id)).map(({ id, alias }) => ({ id, alias })));
    assert.equal(new Set(data.topology.nodes.map(node => node.pubkey)).size, 10);
    assert(data.topology.nodes.every(node => validNodeId(node.pubkey)));
    assert.deepEqual(data.knownNodes, data.topology.nodes.map(({ alias, pubkey }) => ({ alias, pubkey })));
    for (const ch of topology.channels) {
      const historical = data.topology.channels.find(item => item.id === ch.id)!;
      assert(historical); assert.equal(historical.from, ch.from); assert.equal(historical.to, ch.to);
      assert.equal(historical.assetCapacity, String(ch.asset_amount)); assert.equal(historical.forwardFeeBaseMsat, ch.fee_base_msat);
    }
    const channels = new Map(data.topology.channels.map(ch => [ch.channelId, ch]));
    const states = new Map(data.initialChannelStates.map(row => [row.channelId, {
      fromMsat: BigInt(row.fromMsat), toMsat: BigInt(row.toMsat), fromAssetAmount: BigInt(row.fromAssetAmount), toAssetAmount: BigInt(row.toAssetAmount),
    }]));
    const transactions = new Map(data.transactions.map(tx => [tx.id, tx]));
    assert.equal(transactions.size, entry.transactionCount);
    let episodes = 0;
    for (const tx of data.transactions) {
      assert(tx.timestamp < Date.parse(data.provenance.asOf));
      assert.equal(tx.paths.reduce((sum, part) => sum + BigInt(part.amountMsat), 0n), BigInt(tx.amountMsat));
      assert.equal(tx.paths.reduce((sum, part) => sum + BigInt(part.assetAmount ?? '0'), 0n), BigInt(tx.assetAmount ?? '0'));
      let totalFee = 0;
      for (const part of tx.paths) {
        assert.equal(part.nodes[0], tx.senderNodeId); assert.equal(part.nodes.at(-1), tx.recipientNodeId);
        assert.equal(new Set(part.nodes).size, part.nodes.length); assert(BigInt(part.amountMsat) >= 3000000n);
        let carried = BigInt(part.amountMsat), fee = 0;
        for (let i = part.hops.length - 1; i >= 0; i--) {
          const hop = part.hops[i], ch = channels.get(hop.channelId)!;
          assert(ch); assert.equal(hop.fromNodeId, part.nodes[i]); assert.equal(hop.toNodeId, part.nodes[i + 1]);
          assert((ch.from === hop.fromNodeId && ch.to === hop.toNodeId) || (ch.to === hop.fromNodeId && ch.from === hop.toNodeId));
          const expectedFee = i === 0 ? 0 : ch.from === hop.fromNodeId ? ch.forwardFeeBaseMsat : ch.reverseFeeBaseMsat;
          assert.equal(hop.forwardingFeeMsat, expectedFee); assert.equal(BigInt(hop.amountMsat), carried);
          carried += BigInt(expectedFee); fee += expectedFee;
          if (tx.outcome === 'succeeded') {
            const state = states.get(ch.channelId)!, forward = hop.fromNodeId === ch.from;
            const local = forward ? 'fromMsat' : 'toMsat', remote = forward ? 'toMsat' : 'fromMsat';
            const localAsset = forward ? 'fromAssetAmount' : 'toAssetAmount', remoteAsset = forward ? 'toAssetAmount' : 'fromAssetAmount';
            const rgb = BigInt(part.assetAmount ?? '0');
            assert(state[local] >= BigInt(hop.amountMsat)); assert(state[localAsset] >= rgb);
            state[local] -= BigInt(hop.amountMsat); state[remote] += BigInt(hop.amountMsat);
            state[localAsset] -= rgb; state[remoteAsset] += rgb;
            assert.equal(state.fromMsat + state.toMsat, BigInt(ch.capacitySat) * 1000n);
            assert.equal(state.fromAssetAmount + state.toAssetAmount, BigInt(ch.assetCapacity));
          }
        }
        assert.equal(part.plannedFeeMsat, fee); totalFee += fee;
        episodes += tx.outcome === 'succeeded' ? 2 : 1;
      }
      assert.equal(tx.totalFeeMsat, tx.outcome === 'succeeded' ? totalFee : 0);
      if (tx.outcome === 'succeeded') assert(totalFee <= tx.routing.max_fee_msat);
    }
    assert.equal(Object.values(data.nodeHistories).flat().length, episodes);
    for (const final of data.finalChannelStates) {
      const { channelId, ...balances } = final;
      assert.deepEqual(Object.fromEntries(Object.entries(states.get(channelId)!).map(([key, value]) => [key, String(value)])), balances);
    }
    for (const node of data.topology.nodes) {
      const history = data.nodeHistories[node.id];
      assert(history.some(e => e.direction === 'incoming')); assert(history.some(e => e.direction === 'outgoing'));
      for (const observation of history) {
        const tx = transactions.get(observation.transactionId)!, part = tx.paths[observation.pathIndex], ep = observation.episode;
        const outgoing = observation.direction === 'outgoing', hop = outgoing ? part.hops[0] : part.hops.at(-1)!;
        assert.equal(outgoing ? tx.senderNodeId : tx.recipientNodeId, node.id);
        assert.equal(ep.channelId, hop.channelId); assert.equal(ep.amountMsat, part.amountMsat); assert.equal(ep.assetAmount, part.assetAmount);
        assert.equal(ep.peerNodeId, data.topology.nodes.find(n => n.id === (outgoing ? hop.toNodeId : hop.fromNodeId))!.pubkey);
        assert.equal(ep.timestamp, tx.timestamp); assert.equal(ep.outcome, tx.outcome);
        if (!outgoing) { assert.equal(tx.outcome, 'succeeded'); assert.equal(ep.feeMsat, 0); }
      }
      for (const snapshot of data.currentChannelsByNode[node.id]) {
        const state = states.get(snapshot.channelId!)!, ch = channels.get(snapshot.channelId!)!, from = ch.from === node.id;
        assert.equal(snapshot.outboundMsat, String(from ? state.fromMsat : state.toMsat));
        assert.equal(snapshot.assetLocalAmount, String(from ? state.fromAssetAmount : state.toAssetAmount));
      }
    }
  });
  for (const node of data.topology.nodes) test(`${entry.filename}/${node.alias}: import, deduplica, riavvio e ricerca nello storico completo`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'airgb-history-test-'));
    let store = new QvacRagStore(directory);
    t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
    t.mock.method(globalThis, 'fetch', async () => new Response('offline', { status: 503 }));
    const observations = data.nodeHistories[node.id];
    for (const observation of observations) {
      assert(!formatTelemetryDocument(observation.episode).includes('\n'));
      store.saveEpisodeLocal(observation.episode);
      store.saveEpisodeLocal(observation.episode);
    }
    store.close(); store = new QvacRagStore(directory);
    const restored = store.listEpisodes(observations.length + 1);
    assert.equal(restored.length, observations.length);
    const expected = new Map(observations.map(e => [e.episode.id, e.episode]));
    for (const { fileId, vectorStoreId, ...episode } of restored) {
      assert.equal(fileId, null); assert.equal(vectorStoreId, null); assert.deepEqual(episode, expected.get(episode.id));
    }
    // A relevant old payment must not disappear when the sample grows beyond 20 rows.
    const oldestTransactionNumber = observations[0].transactionId.slice(-6);
    const result = await store.searchEpisodes(oldestTransactionNumber, 4);
    assert(result.hits.some(hit => hit.text.includes(`synthetic-ep-${oldestTransactionNumber}-`)), 'Fallback ignored a relevant older transaction');
    assert(result.hits.every(hit => expected.has(hit.fileId)), 'Cross-node history contamination');
  });
}

test('i quattro dataset mantengono prefissi identici per transazioni e storici per nodo', () => {
  for (let i = 1; i < manifest.datasets.length; i++) {
    const previous = loadHistory(manifest.datasets[i - 1].transactionCount), current = loadHistory(manifest.datasets[i].transactionCount);
    assert.deepEqual(current.transactions.slice(0, previous.transactions.length), previous.transactions);
    const fixtureIds = new Set(topology.channels.flatMap(channel => [channel.from, channel.to]));
    for (const node of topology.nodes.filter(node => fixtureIds.has(node.id))) assert.deepEqual(current.nodeHistories[node.id].slice(0, previous.nodeHistories[node.id].length), previous.nodeHistories[node.id]);
  }
});
