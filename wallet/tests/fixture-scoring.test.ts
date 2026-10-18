import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QvacRagStore, formatTelemetryDocument, scoreChannelsWithQvac, sanitizeAndValidateChannelScore } from '../apps/local-service/channel-scoring.js';
import { compileConstraints } from '../packages/policy/compile.js';
import { capabilities, loadHistory, manifest, topology } from './helpers/routing-fixtures.js';
import type { ScoreChannelsInput } from '../apps/local-service/channel-scoring.js';

const rawScore = (input: ScoreChannelsInput) => ({ schemaVersion: '1.0', overallProfile: 'balanced',
  recommendedWeights: { fee: -2, reliability: 2000, cltv: 1.4, hops: null },
  channels: [...input.channels.map(channel => ({ channelId: channel.channelId, classification: 'optimal', score: 100, reason: 'Risposta simulata deliberatamente ottimistica.' })),
    { channelId: 'invented-channel', classification: 'optimal', score: 100, reason: 'Da ignorare.' }], summary: 'Classificatore simulato; nessuna valutazione del modello reale.' });

const fixtureIds = new Set(topology.channels.flatMap(channel => [channel.from, channel.to]));
for (const entry of manifest.datasets) for (const node of topology.nodes.filter(node => fixtureIds.has(node.id))) {
  test(`${entry.filename}/${node.alias}: scoring BTC/RGB usa snapshot e RAG della fixture`, async t => {
    const data = loadHistory(entry.transactionCount), directory = await mkdtemp(join(tmpdir(), 'airgb-fixture-score-'));
    const store = new QvacRagStore(directory);
    t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
    const oldUrl = process.env.QVAC_URL, oldModel = process.env.QVAC_MODEL;
    process.env.QVAC_URL = 'http://127.0.0.1:19003'; process.env.QVAC_MODEL = 'fixture-model';
    t.after(() => {
      if (oldUrl === undefined) delete process.env.QVAC_URL; else process.env.QVAC_URL = oldUrl;
      if (oldModel === undefined) delete process.env.QVAC_MODEL; else process.env.QVAC_MODEL = oldModel;
    });
    for (const observation of data.nodeHistories[node.id]) store.saveEpisodeLocal(observation.episode);
    const owned = new Map(data.nodeHistories[node.id].map(o => [o.episode.id, formatTelemetryDocument(o.episode)]));
    let current: ScoreChannelsInput;
    let captured: { ragHistory: { summary: string }[] } | null = null;
    t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
      if (!new URL(String(url)).pathname.endsWith('/chat/completions')) return new Response('offline', { status: 503 });
      const body = JSON.parse(String(init?.body));
      captured = JSON.parse(body.messages[1].content);
      assert.deepEqual(body.response_format.json_schema.schema.properties.channels.items.properties.channelId.enum, current.channels.map(ch => ch.channelId));
      assert(!Object.hasOwn(body.response_format.json_schema.schema.properties.channels.items.properties, 'peerNodeId'));
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(rawScore(current)) } }] });
    });
    for (const asset of [null, data.topology.channels[0].assetId]) {
      current = { amountMsat: '10000000', assetId: asset, assetAmount: asset ? '20' : null,
        payeePubkey: data.currentChannelsByNode[node.id][0].peerNodeId, userPreference: 'Preferisco affidabilita',
        channels: data.currentChannelsByNode[node.id], knownNodes: data.knownNodes };
      const scored = await scoreChannelsWithQvac(current, store);
      assert.equal(scored.channels.length, current.channels.length);
      assert(scored.ragHits.length > 0);
      assert(scored.ragHits.every(hit => owned.get(hit.fileId) === hit.text), 'Scoring did not use this node history');
      assert.deepEqual(captured!.ragHistory.map((hit: { summary: string }) => hit.summary), scored.ragHits.slice(0, 3).map(hit => hit.text.slice(0, 220)));
      assert.equal(scored.overallProfile, 'high_reliability');
      assert(scored.recommendedWeights.reliability > scored.recommendedWeights.fee);
      for (const result of scored.channels) {
        const live = current.channels.find(ch => ch.channelId === result.channelId)!;
        assert(live); assert.equal(result.peerNodeId, live.peerNodeId);
        assert(Number.isInteger(result.score) && result.score >= 0 && result.score <= 100);
        if (asset && BigInt(live.assetLocalAmount!) < 20n) assert.equal(result.classification, 'insufficient_liquidity');
      }
      assert(!scored.excludedNodeIds.includes(current.payeePubkey!));
    }
  });
}

test('fixture scoring: disconnessione, liquidita BTC/RGB, asset errato e identificativi inventati non superano i controlli', () => {
  const data = loadHistory(100), base = data.currentChannelsByNode.frank;
  const input: ScoreChannelsInput = { amountMsat: '10000000', assetId: base[0].assetId, assetAmount: '5', knownNodes: data.knownNodes,
    payeePubkey: base[0].peerNodeId, channels: base.map((ch, i) => i === 0 ? { ...ch, isUsable: false }
      : i === 1 ? { ...ch, outboundMsat: '1' } : i === 2 ? { ...ch, assetLocalAmount: '0' } : i === 3 ? { ...ch, assetId: 'rgb:different-synthetic-asset' } : ch) };
  const result = sanitizeAndValidateChannelScore(JSON.stringify(rawScore(input)), input, []);
  assert.equal(result.channels[0].classification, 'avoid');
  for (const i of [1, 2, 3]) assert.equal(result.channels[i].classification, 'insufficient_liquidity');
  assert(!result.excludedNodeIds.includes(input.payeePubkey!));
  assert(!result.channels.some(ch => ch.channelId === 'invented-channel'));
  assert(Object.values(result.recommendedWeights).every(weight => Number.isInteger(weight) && weight >= 1 && weight <= 1000));
});

test('fixture scoring: policy fee zero, esclusioni e limite dei percorsi restano applicati alla raccomandazione', () => {
  const data = loadHistory(100), pubkey = (id: string) => data.topology.nodes.find(n => n.id === id)!.pubkey;
  const policy = compileConstraints({ extracted: { ...topology.expectedExtractionDefaults,
    feeLimit: { value: '0', unit: 'sat', comparison: 'lte' }, excludedNodeReferences: ['Bob'], privacyRequest: 'avoid_extra_probing' },
    payment: { invoice: 'lnbcrtfixturepolicy', amount: '10000000', assetId: 'BTC', network: 'regtest' },
    capabilities, knownNodes: data.knownNodes, payeePubkey: pubkey('judy') }).policy!;
  assert(policy);
  const input: ScoreChannelsInput = { amountMsat: '10000000', channels: data.currentChannelsByNode.alice,
    knownNodes: data.knownNodes, compiledPolicy: policy, payeePubkey: pubkey('judy') };
  const result = sanitizeAndValidateChannelScore(JSON.stringify(rawScore(input)), input, []);
  assert.equal(result.recommendedRouting.max_fee_msat, 0);
  assert.equal(result.recommendedRouting.max_paths, 1);
  assert(result.recommendedRouting.excluded_nodes!.includes(pubkey('bob')));
});

test('fixture scoring: canali nulli o malformati nel modello vengono ignorati mantenendo i limiti fisici', () => {
  const data = loadHistory(20);
  const input: ScoreChannelsInput = { amountMsat: '10000000', channels: data.currentChannelsByNode.alice, knownNodes: data.knownNodes };
  const result = sanitizeAndValidateChannelScore(JSON.stringify({ ...rawScore(input), channels: [null, 42, 'invalid'] }), input, []);
  assert.deepEqual(result.channels.map(ch => ch.channelId), input.channels.map(ch => ch.channelId));
});

test('fixture scoring: ingestione RAG, deduplicazione, ricerca e classificazione usano documenti dei log', async t => {
  const data = loadHistory(100), directory = await mkdtemp(join(tmpdir(), 'airgb-fixture-rag-'));
  const store = new QvacRagStore(directory, 'airgb-fixture-isolated');
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const oldUrl = process.env.QVAC_URL, oldModel = process.env.QVAC_MODEL;
  process.env.QVAC_URL = 'http://127.0.0.1:19004'; process.env.QVAC_MODEL = 'fixture-model';
  t.after(() => { if (oldUrl === undefined) delete process.env.QVAC_URL; else process.env.QVAC_URL = oldUrl;
    if (oldModel === undefined) delete process.env.QVAC_MODEL; else process.env.QVAC_MODEL = oldModel; });
  const uploaded = new Map<string, string>(), attached = new Set<string>();
  const input: ScoreChannelsInput = { amountMsat: '10000000', channels: data.currentChannelsByNode.alice, knownNodes: data.knownNodes };
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === '/v1/vector_stores' && (!init?.method || init.method === 'GET')) return Response.json({ data: [] });
    if (pathname === '/v1/vector_stores') {
      assert.equal(JSON.parse(String(init?.body)).name, 'airgb-fixture-isolated');
      return Response.json({ id: 'vs_fixture' });
    }
    if (pathname === '/v1/files') {
      const file = (init!.body as FormData).get('file') as Blob;
      const id = `file-fixture-${uploaded.size}`; uploaded.set(id, await file.text());
      return Response.json({ id });
    }
    if (pathname.endsWith('/files')) {
      const fileId = JSON.parse(String(init!.body)).file_id; assert(uploaded.has(fileId)); attached.add(fileId);
      return Response.json({ id: fileId });
    }
    if (pathname.endsWith('/search')) return Response.json({ data: [...attached].slice(0, 4).map(id => ({ file_id: id, filename: id + '.txt', score: 0.9, content: [{ text: uploaded.get(id) }] })) });
    if (pathname.endsWith('/chat/completions')) return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(rawScore(input)) } }] });
    throw new Error(`Unexpected mock endpoint ${pathname}`);
  });
  const episodes = data.nodeHistories.alice.map(entry => entry.episode);
  for (const ep of episodes) assert((await store.ingestEpisode(ep)).fileId);
  for (const ep of episodes) await store.ingestEpisode(ep);
  assert.equal(uploaded.size, episodes.length); assert.equal(attached.size, episodes.length);
  assert.deepEqual([...uploaded.values()].sort(), episodes.map(formatTelemetryDocument).sort());
  const scored = await scoreChannelsWithQvac(input, store);
  assert.equal(scored.vectorStoreId, 'vs_fixture');
  assert(scored.ragHits.length > 0 && scored.ragHits.every(hit => uploaded.get(hit.fileId) === hit.text));
});

for (const [name, response, code] of [
  ['HTTP failure', () => new Response('failure', { status: 500 }), 'AI_HTTP'],
  ['invalid HTTP JSON', () => new Response('not JSON'), 'AI_MALFORMED_RESPONSE'],
  ['truncated', () => Response.json({ choices: [{ finish_reason: 'length' }] }), 'AI_TRUNCATED'],
  ['incomplete', () => Response.json({ choices: [{ finish_reason: 'tool_calls' }] }), 'AI_INCOMPLETE'],
  ['malformed model JSON', () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{' } }] }), 'AI_MALFORMED_JSON'],
  ['null model JSON', () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'null' } }] }), 'AI_SCHEMA'],
  ['timeout', () => { throw new DOMException('fixture timeout', 'TimeoutError'); }, 'AI_TIMEOUT'],
] as const) test(`fixture scoring: ${name} non produce una raccomandazione utilizzabile`, async t => {
  const data = loadHistory(20), directory = await mkdtemp(join(tmpdir(), 'airgb-score-error-'));
  const store = new QvacRagStore(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const oldModel = process.env.QVAC_MODEL; process.env.QVAC_MODEL = 'fixture-model';
  t.after(() => { if (oldModel === undefined) delete process.env.QVAC_MODEL; else process.env.QVAC_MODEL = oldModel; });
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => new URL(String(url)).pathname.endsWith('/chat/completions') ? response() : new Response('offline', { status: 503 }));
  await assert.rejects(scoreChannelsWithQvac({ amountMsat: '10000000', channels: data.currentChannelsByNode.alice, knownNodes: data.knownNodes }, store), { code });
});

test('driver QVAC live: legge le fixture, isola e ripulisce lo store, e fallisce se la ricerca remota non funziona', { timeout: 30000 }, async t => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const files = new Map<string, string>(), deleted = new Set<string>();
  const errors: Error[] = [];
  let searchAvailable = true, uploads = 0, deletes = 0, vectorName = '';
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks), path = new URL(req.url!, 'http://127.0.0.1').pathname;
      const json = (value: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (path === '/v1/models') return json({ data: [{ id: 'fixture-model' }] });
      if (path === '/v1/vector_stores' && req.method === 'GET') return json({ data: [] });
      if (path === '/v1/vector_stores') {
        vectorName = JSON.parse(body.toString()).name;
        assert.match(vectorName, /^airgb-fixture-20-alice-/); return json({ id: 'vs_cli_fixture' });
      }
      if (req.method === 'DELETE') {
        assert(path === '/v1/vector_stores/vs_cli_fixture' || files.has(path.split('/').at(-1)!));
        deleted.add(path); deletes++; res.writeHead(204).end(); return;
      }
      if (path === '/v1/files') {
        const form = await new Request('http://127.0.0.1/v1/files', { method: 'POST',
          headers: { 'content-type': req.headers['content-type']! }, body: new Uint8Array(body) }).formData();
        const file = form.get('file') as Blob;
        const id = `file-cli-${uploads++}`; files.set(id, await file.text()); return json({ id });
      }
      if (path.endsWith('/files')) {
        const id = JSON.parse(body.toString()).file_id; assert(files.has(id)); return json({ id });
      }
      if (path.endsWith('/search')) {
        if (!searchAvailable) { res.writeHead(503).end(); return; }
        return json({ data: [...files].slice(-4).map(([id, text]) => ({ file_id: id, filename: id + '.txt', score: 0.9, content: [{ text }] })) });
      }
      if (path.endsWith('/chat/completions')) {
        const input = JSON.parse(JSON.parse(body.toString()).messages[1].content);
        return json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ schemaVersion: '1.0', overallProfile: 'balanced',
          recommendedWeights: { fee: 1, reliability: 1, cltv: 1, hops: 1 },
          channels: input.channels.map((ch: { channelId: string }) => ({ channelId: ch.channelId, classification: 'good', score: 75, reason: 'Fixture transport test' })), summary: 'Fixture transport test' }) } }] });
      }
      throw new Error(`Unexpected live-driver request ${req.method} ${path}`);
    } catch (error) {
      errors.push(error as Error); res.writeHead(500).end();
    }
  });
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
  t.after(() => new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept())));
  const port = (server.address() as import('node:net').AddressInfo).port;
  const run = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((accept, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'infra/regtest/smoke-qvac-scoring.mjs', ...args], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), env: { ...process.env, QVAC_URL: `http://127.0.0.1:${port}`, QVAC_MODEL: 'fixture-model' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Live driver exceeded test timeout')); }, 10000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); accept({ code, stdout, stderr }); });
  });
  const dry = await run(['--all', '--dry-run']);
  assert.equal(dry.code, 0, dry.stderr); assert.equal(JSON.parse(dry.stdout).cases.length, 40); assert.equal(uploads, 0);
  const result = await run(['--history', '20', '--node', 'alice']);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const expected = loadHistory(20).nodeHistories.alice.map(entry => formatTelemetryDocument(entry.episode));
  assert.deepEqual([...files.values()].sort(), expected.sort());
  assert.equal(uploads, expected.length); assert.equal(deletes, expected.length + 1);
  assert(deleted.has('/v1/vector_stores/vs_cli_fixture'));
  searchAvailable = false; files.clear(); deleted.clear(); uploads = 0; deletes = 0;
  const failed = await run(['--history', '20', '--node', 'alice']);
  assert.notEqual(failed.code, 0); assert.match(failed.stdout, /Real QVAC search failed/);
  assert.equal(deletes, expected.length + 1); assert.deepEqual(errors, []);
});
