import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { QvacRagStore, scoreChannelsWithQvac } from '../../apps/local-service/channel-scoring.ts';
import { compileConstraints } from '../../packages/policy/compile.ts';
import { capabilities, loadHistory, manifest, resolved, topology } from '../../tests/helpers/routing-fixtures.ts';

const { values } = parseArgs({ options: {
  history: { type: 'string', default: '20' }, node: { type: 'string', default: 'alice' },
  all: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false },
} });
const fixtureNodes = topology.nodes.filter(node => topology.channels.some(ch => ch.from === node.id || ch.to === node.id));
const sizes = values.all ? manifest.datasets.map(entry => entry.transactionCount) : [Number(values.history)];
const nodeIds = values.all ? fixtureNodes.map(node => node.id) : [values.node];
assert(sizes.every(size => manifest.datasets.some(entry => entry.transactionCount === size)), 'Use --history 20|100|500|2000');
assert(nodeIds.every(id => fixtureNodes.some(node => node.id === id)), 'Unknown --node in topology.json');
const matrix = sizes.flatMap(size => nodeIds.map(nodeId => ({ size, nodeId })));
for (const item of matrix) {
  const fixture = loadHistory(item.size);
  assert(fixture.nodeHistories[item.nodeId].length > 0);
}
if (values['dry-run']) {
  console.log(JSON.stringify({ mode: 'dry-run', topology: topology.name, cases: matrix.map(({ size, nodeId }) => ({
    transactions: size, nodeId, episodes: loadHistory(size).nodeHistories[nodeId].length,
  })), realInference: false, uploads: 0 }));
  process.exit(0);
}
const base = new URL(process.env.QVAC_URL ?? 'http://127.0.0.1:11434');
assert(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'QVAC must run on HTTP loopback');
process.env.QVAC_URL = base.href;
process.env.QVAC_MODEL ??= 'qwen-fast';
try {
  const models = await fetch(new URL('/v1/models', base), { signal: AbortSignal.timeout(2000) });
  assert(models.ok, `QVAC models HTTP ${models.status}`);
} catch (error) {
  throw new Error('QVAC non raggiungibile: avviare npm run qvac:serve prima dello smoke test.', { cause: error });
}

// A live smoke test must fail on a RAG outage rather than pass using SQLite fallback.
class StrictQvacRagStore extends QvacRagStore {
  async searchEpisodes(query, topK = 4, signal) {
    const vectorStoreId = await this.ensureVectorStore(signal);
    const response = await fetch(new URL(`/v1/vector_stores/${encodeURIComponent(vectorStoreId)}/search`, base), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, max_num_results: Math.max(1, Math.min(10, topK)) }),
      signal: AbortSignal.any([AbortSignal.timeout(25000), ...(signal ? [signal] : [])]),
    });
    assert(response.ok, `Real QVAC search failed: HTTP ${response.status}`);
    const body = await response.json();
    const hits = (body.data ?? []).map(item => ({ fileId: item.file_id, filename: item.filename ?? `${item.file_id}.txt`,
      score: item.score ?? 0, text: (item.content ?? []).map(block => block.text ?? '').join(' ') })).filter(hit => hit.text);
    assert(hits.length > 0, 'Real QVAC returned no indexed telemetry; SQLite fallback is disabled for this test');
    return { vectorStoreId, hits };
  }
}
let passed = 0;
const failures = [];
for (const { size, nodeId } of matrix) {
  const fixture = loadHistory(size), directory = await mkdtemp(join(tmpdir(), 'airgb-live-fixture-score-'));
  const store = new StrictQvacRagStore(directory, `airgb-fixture-${size}-${nodeId}-${randomUUID()}`);
  try {
    const entries = fixture.nodeHistories[nodeId];
    console.log(JSON.stringify({ step: 'ingest', transactions: size, nodeId, episodes: entries.length }));
    for (const [index, entry] of entries.entries()) {
      const result = await store.ingestEpisode(entry.episode);
      assert(result.fileId && result.vectorStoreId, `Episode ${entry.episode.id} was only saved locally, not indexed in QVAC`);
      if ((index + 1) % 25 === 0) console.log(JSON.stringify({ step: 'ingest_progress', nodeId, uploaded: index + 1, total: entries.length }));
    }
    const ownFiles = new Set(store.listEpisodes(-1).map(ep => ep.fileId));
    const scenario = topology.scenarios.find(s => s.id === 'fee-inclusive-boundary');
    const extracted = resolved(scenario).extracted;
    const channels = fixture.currentChannelsByNode[nodeId];
    const payeePubkey = channels[0].peerNodeId;
    const compiled = compileConstraints({ extracted,
      payment: { invoice: 'lnbcrtfixtureqvac', amount: topology.paymentDefaults.amountMsat, assetId: channels[0].assetId, network: 'regtest' },
      capabilities, knownNodes: fixture.knownNodes, payeePubkey });
    assert.equal(compiled.status, 'validated');
    const result = await scoreChannelsWithQvac({ amountMsat: topology.paymentDefaults.amountMsat,
      assetId: channels[0].assetId, assetAmount: '5', payeePubkey, userPreference: 'Preferisco affidabilita',
      compiledPolicy: compiled.policy, channels, knownNodes: fixture.knownNodes }, store);
    assert(result.ragHits.every(hit => ownFiles.has(hit.fileId)), 'RAG retrieved episodes from another node or dataset');
    assert.equal(result.channels.length, channels.length);
    assert.deepEqual(new Set(result.channels.map(ch => ch.channelId)), new Set(channels.map(ch => ch.channelId)));
    assert.equal(result.recommendedRouting.max_fee_msat, 3000);
    assert(!result.excludedNodeIds.includes(payeePubkey));
    for (const scored of result.channels) {
      const channel = channels.find(ch => ch.channelId === scored.channelId);
      assert.equal(scored.peerNodeId, channel.peerNodeId);
      assert(Number.isInteger(scored.score) && scored.score >= 0 && scored.score <= 100);
      if (BigInt(channel.assetLocalAmount) < 5n || BigInt(channel.outboundMsat) < BigInt(topology.paymentDefaults.amountMsat)) {
        assert.equal(scored.classification, 'insufficient_liquidity');
      }
    }
    passed++;
    console.log(JSON.stringify({ step: 'passed', transactions: size, nodeId, realInference: true, ragHits: result.ragHits.length, profile: result.overallProfile }));
  } catch (error) {
    failures.push({ transactions: size, nodeId, error: error.message });
    console.error(JSON.stringify({ step: 'failed', ...failures.at(-1) }));
  } finally {
    const files = store.listEpisodes(-1).map(ep => ep.fileId).filter(Boolean);
    const vectorStoreId = store.getSavedVectorStoreId();
    store.close();
    // Delete only resources belonging to this fresh, uniquely named test store.
    for (const path of [...(vectorStoreId ? [`/v1/vector_stores/${encodeURIComponent(vectorStoreId)}`] : []), ...files.map(id => `/v1/files/${encodeURIComponent(id)}`)]) {
      try {
        const response = await fetch(new URL(path, base), { method: 'DELETE', signal: AbortSignal.timeout(10000) });
        assert(response.ok || response.status === 404, `Cleanup HTTP ${response.status}`);
      } catch (error) {
        failures.push({ transactions: size, nodeId, error: `Cleanup: ${error.message}` });
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ cases: matrix.length, passed, failures, mode: 'live_qvac_fixture_scoring', nativeRoutingExecuted: false }));
assert.equal(failures.length, 0, 'Live fixture scoring failed');
