import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatTelemetryDocument,
  QvacRagStore,
  sanitizeAndValidateChannelScore,
  scoreChannelsWithQvac,
  type LiveChannelInput,
} from '../apps/local-service/channel-scoring.js';
import { PaymentStore, type PaymentRecord } from '../apps/local-service/payments.js';
import { compileConstraints } from '../packages/policy/compile.js';
import type { DecodedLightning } from '../apps/local-service/wallet.js';

const ALICE_PUBKEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const BOB_PUBKEY = '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5';
const CAROL_PUBKEY = '02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9';

const SAMPLE_CHANNELS: LiveChannelInput[] = [
  {
    channelId: 'ch-bob-01',
    peerNodeId: BOB_PUBKEY,
    assetId: 'rgb:test-asset',
    capacitySat: '100000',
    outboundMsat: '75000000',
    inboundMsat: '25000000',
    assetLocalAmount: '100',
    assetRemoteAmount: '20',
    isUsable: true,
  },
  {
    channelId: 'ch-carol-02',
    peerNodeId: CAROL_PUBKEY,
    assetId: 'rgb:test-asset',
    capacitySat: '100000',
    outboundMsat: '1000000',
    inboundMsat: '99000000',
    assetLocalAmount: '5',
    assetRemoteAmount: '95',
    isUsable: false,
  },
];

test('formatTelemetryDocument produce un singolo blocco compatto con metriche RGB e Lightning', () => {
  const doc = formatTelemetryDocument({
    id: 'ep-01',
    timestamp: 1700000000000,
    eventType: 'payment_succeeded',
    peerNodeId: BOB_PUBKEY,
    peerAlias: 'Bob',
    channelId: 'ch-bob-01',
    amountMsat: '3000000',
    assetId: 'rgb:test-asset',
    assetAmount: '15',
    routingAlgorithm: 'multi_objective',
    outcome: 'succeeded',
    failureReason: null,
    outboundRatioPct: 75,
    feeMsat: 110,
    notes: 'Trasferimento RGB completato al primo tentativo.',
  });
  assert.match(doc, /\[TELEMETRY ep-01\]/);
  assert.match(doc, /RGB asset rgb:test-asset/);
  assert.match(doc, /OutboundLiquidityRatio=75%/);
  assert.equal(doc.includes('\n\n'), false);
});

test('sanitizeAndValidateChannelScore impone limiti fisici di liquidità e non esclude mai payeePubkey', () => {
  const rawModelJson = JSON.stringify({
    schemaVersion: '1.0',
    overallProfile: 'high_reliability',
    recommendedWeights: { fee: 15, reliability: 160, cltv: 10, hops: 20 },
    channels: [
      {
        channelId: 'ch-bob-01',
        peerNodeId: BOB_PUBKEY,
        classification: 'optimal',
        score: 95,
        reason: 'Liquidità outbound al 75% e storico RAG positivo con Bob.',
      },
      {
        channelId: 'ch-carol-02',
        peerNodeId: CAROL_PUBKEY,
        // Even if the model hallucinated 'good' on an unusable channel, deterministic guard overrides to 'avoid'
        classification: 'good',
        score: 80,
        reason: 'Sembra buono',
      },
    ],
    summary: 'Preferire il canale diretto con Bob ed evitare Carol-Relay.',
  });

  const validated = sanitizeAndValidateChannelScore(
    rawModelJson,
    {
      amountMsat: '3000000',
      assetId: 'rgb:test-asset',
      assetAmount: '10',
      payeePubkey: CAROL_PUBKEY, // Carol is the destination payee -> must NOT be in excludedNodeIds!
      userPreference: 'Massima affidabilità',
      channels: SAMPLE_CHANNELS,
      knownNodes: [
        { alias: 'Bob', pubkey: BOB_PUBKEY },
        { alias: 'Carol', pubkey: CAROL_PUBKEY },
      ],
    },
    [],
  );

  assert.equal(validated.overallProfile, 'high_reliability');
  assert.equal(validated.channels[0].classification, 'optimal');
  assert.equal(validated.channels[1].classification, 'avoid');
  assert.equal(validated.excludedNodeIds.includes(CAROL_PUBKEY), false);

  // Now when Bob is the destination payee, Carol (whose only channel is 'avoid') IS excluded:
  const validatedExcludeCarol = sanitizeAndValidateChannelScore(
    rawModelJson,
    {
      amountMsat: '3000000',
      assetId: 'rgb:test-asset',
      assetAmount: '10',
      payeePubkey: BOB_PUBKEY,
      userPreference: 'Massima affidabilità',
      channels: SAMPLE_CHANNELS,
      knownNodes: [
        { alias: 'Bob', pubkey: BOB_PUBKEY },
        { alias: 'Carol', pubkey: CAROL_PUBKEY },
      ],
    },
    [],
  );
  assert.deepEqual(validatedExcludeCarol.excludedNodeIds, [CAROL_PUBKEY]);
  assert.deepEqual(validatedExcludeCarol.recommendedRouting.excluded_nodes, [CAROL_PUBKEY]);
});

test('QvacRagStore e scoreChannelsWithQvac integrano /v1/files, /v1/vector_stores e /v1/chat/completions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'airgb-rag-score-'));
  const uploadedFiles = new Map<string, string>();
  const attachedFiles: string[] = [];
  let searchCalls = 0;
  let chatCalls = 0;

  const mockQvac = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let body = '';
    for await (const chunk of req) body += chunk;

    if (req.method === 'GET' && url.pathname === '/v1/vector_stores') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: attachedFiles.length
            ? [{ id: 'vs_mock_turbovec_01', name: 'airgb-channel-telemetry', status: 'completed' }]
            : [],
        }),
      );
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/vector_stores') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'vs_mock_turbovec_01', name: 'airgb-channel-telemetry', status: 'in_progress' }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/files') {
      const id = `file-mock-${uploadedFiles.size + 1}`;
      uploadedFiles.set(id, body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id, object: 'file', status: 'uploaded' }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/vector_stores/vs_mock_turbovec_01/files') {
      const parsed = JSON.parse(body) as { file_id: string };
      attachedFiles.push(parsed.file_id);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: parsed.file_id, object: 'vector_store.file', status: 'completed' }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/vector_stores/vs_mock_turbovec_01/search') {
      searchCalls++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'vector_store.search_results.page',
          data: [
            {
              file_id: attachedFiles[0] ?? 'file-mock-1',
              filename: 'ep-demo-rgb-success-01.txt',
              score: 0.9123,
              content: [
                {
                  type: 'text',
                  text: '[TELEMETRY ep-demo-rgb-success-01] Event=payment_succeeded Outcome=succeeded Peer=Bob Channel=ch-bob-01.',
                },
              ],
            },
          ],
        }),
      );
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      chatCalls++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({
                  schemaVersion: '1.0',
                  overallProfile: 'fee_saver',
                  recommendedWeights: { fee: 120, reliability: 25, cltv: 5, hops: 10 },
                  channels: [
                    {
                      channelId: 'ch-bob-01',
                      peerNodeId: BOB_PUBKEY,
                      classification: 'optimal',
                      score: 94,
                      reason: 'Canale ch-bob-01 ottimale con commissioni basse e 75% outbound.',
                    },
                    {
                      channelId: 'ch-carol-02',
                      peerNodeId: CAROL_PUBKEY,
                      classification: 'avoid',
                      score: 5,
                      reason: 'Canale disconnesso e saldo RGB insufficiente.',
                    },
                  ],
                  summary: 'Selezionato profilo fee_saver con instradamento su ch-bob-01 ed esclusione di Carol.',
                }),
              },
            },
          ],
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>(resolve => mockQvac.listen(0, '127.0.0.1', resolve));
  const address = mockQvac.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const prevUrl = process.env.QVAC_URL;
  const prevModel = process.env.QVAC_MODEL;
  process.env.QVAC_URL = `http://127.0.0.1:${port}`;
  process.env.QVAC_MODEL = 'qwen-fast';

  const ragStore = new QvacRagStore(dir);
  try {
    const seeded = await ragStore.seedDemoEpisodes({
      channels: SAMPLE_CHANNELS,
      knownNodes: [
        { alias: 'Alice', pubkey: ALICE_PUBKEY },
        { alias: 'Bob', pubkey: BOB_PUBKEY },
      ],
    });
    assert.equal(seeded.seededCount, 5);
    assert.equal(seeded.vectorStoreId, 'vs_mock_turbovec_01');
    assert.equal(attachedFiles.length, 5);

    const compiled = compileConstraints({
      extracted: {
        schemaVersion: '1.0',
        status: 'parsed',
        feeLimit: { value: '8', unit: 'sat', comparison: 'lte' },
        excludedNodeReferences: [],
        priority: 'lowest_fee',
        privacyRequest: 'avoid_extra_probing',
        unhandledRequests: [],
      },
      payment: { invoice: 'lnbcrt-score-test', amount: '3000000', assetId: 'rgb:test-asset', network: 'regtest' },
      capabilities: {
        backendVersion: 'test',
        revision: 'rgb-mpp-1',
        hardFeeCap: true,
        hardNodeExclusion: true,
        hardChannelExclusion: false,
        perPaymentScoringProfile: true,
        avoidExtraProbing: true,
        canInspectFullRoute: true,
        canGuaranteeConstraintsAcrossRetries: true,
      },
      knownNodes: [{ alias: 'Bob', pubkey: BOB_PUBKEY }],
    });

    const result = await scoreChannelsWithQvac(
      {
        amountMsat: '3000000',
        assetId: 'rgb:test-asset',
        assetAmount: '10',
        payeePubkey: BOB_PUBKEY,
        userPreference: 'Voglio spendere il meno possibile',
        compiledPolicy: compiled.policy,
        channels: SAMPLE_CHANNELS,
        knownNodes: [
          { alias: 'Bob', pubkey: BOB_PUBKEY },
          { alias: 'Carol', pubkey: CAROL_PUBKEY },
        ],
      },
      ragStore,
    );

    assert.equal(searchCalls, 1);
    assert.equal(chatCalls, 1);
    assert.equal(result.vectorStoreId, 'vs_mock_turbovec_01');
    assert.equal(result.ragBackend, 'qvac-turbovec');
    assert.equal(result.ragHits.length, 1);
    assert.equal(result.channels.length, 2);
    assert.equal(result.channels[0].classification, 'optimal');
    assert.equal(result.channels[1].classification, 'avoid');
    assert.deepEqual(result.excludedNodeIds, [CAROL_PUBKEY]);
    assert.deepEqual(result.recommendedRouting, {
      algorithm: 'multi_objective',
      weights: result.recommendedWeights,
      max_fee_msat: 8000,
      excluded_nodes: [CAROL_PUBKEY],
      max_paths: 1,
    });
  } finally {
    ragStore.close();
    mockQvac.close();
    if (prevUrl === undefined) delete process.env.QVAC_URL;
    else process.env.QVAC_URL = prevUrl;
    if (prevModel === undefined) delete process.env.QVAC_MODEL;
    else process.env.QVAC_MODEL = prevModel;
    await rm(dir, { recursive: true, force: true });
  }
});

test('PaymentStore invoca onTerminalOutcome quando un pagamento termina con succeeded o failed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'airgb-pay-hook-'));
  const decoded: DecodedLightning = {
    invoice: 'lnbcrt-hook-test',
    network: 'regtest',
    paymentHash: 'd'.repeat(64),
    payeePubkey: BOB_PUBKEY,
    amountMsat: '3000000',
    assetId: 'rgb:test-asset',
    assetAmount: '10',
    expiresAt: Date.now() + 60000,
    description: null,
  };
  const recorded: PaymentRecord[] = [];
  const wallet = {
    canSend: true,
    decodeLightning: async () => decoded,
    sendLightning: async () => ({ status: 'Succeeded', payment_id: 'pid-hook-1' }),
    paymentStatus: async () => ({ status: 'Succeeded' }),
  };
  const store = new PaymentStore(dir, wallet, rec => {
    recorded.push(rec);
  });
  try {
    const prepared = await store.prepare({
      id: 'hook-intent-01',
      invoice: decoded.invoice,
      routing: {
        algorithm: 'multi_objective',
        weights: { fee: 40, reliability: 60, cltv: 10, hops: 20 },
        excluded_nodes: [CAROL_PUBKEY],
      },
    });
    const confirmed = await store.confirm(prepared.id);
    assert.equal(confirmed.status, 'succeeded');
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].id, 'hook-intent-01');
    assert.deepEqual(recorded[0].routing.excluded_nodes, [CAROL_PUBKEY]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
