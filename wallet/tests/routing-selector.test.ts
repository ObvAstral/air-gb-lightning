import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertFirstPartyEpisode,
  QvacRagStore,
  type LiveChannelInput,
} from '../apps/local-service/channel-scoring.js';
import {
  EphemeralRoutingContext,
  selectRoutingAlgorithmWithQvac,
  selectRoutingStrategyDeterministic,
} from '../apps/local-service/routing-selector.js';
import { compileConstraints } from '../packages/policy/compile.js';

const ALICE_PUBKEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const BOB_PUBKEY = '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5';
const CAROL_PUBKEY = '02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9';
const DAVE_PUBKEY = '03fff97bd5755eeea420453a14355235d382f6472f8568a18b2f057a1460297556';

test('assertFirstPartyEpisode accetta episodi TelemetryEpisode legittimi e rifiuta dati di terze parti o segreti', () => {
  assertFirstPartyEpisode({
    id: 'ep-valid-1',
    timestamp: 1700000000000,
    eventType: 'payment_succeeded',
    peerNodeId: BOB_PUBKEY,
    peerAlias: 'Bob',
    channelId: 'ch-bob-01',
    amountMsat: '3000000',
    assetId: null,
    assetAmount: null,
    routingAlgorithm: 'ldk_dijkstra',
    outcome: 'succeeded',
    failureReason: null,
    outboundRatioPct: 75,
    feeMsat: 50,
    notes: 'Pagamento uscito regolarmente.',
  });

  // Rejects third-party remote node balance fields ("don't hold other people's data")
  assert.throws(
    () =>
      assertFirstPartyEpisode({
        id: 'ep-bad-1',
        timestamp: 1700000000000,
        eventType: 'payment_succeeded',
        peerNodeId: BOB_PUBKEY,
        peerAlias: 'Bob',
        channelId: 'ch-bob-01',
        amountMsat: '3000000',
        assetId: null,
        assetAmount: null,
        routingAlgorithm: 'ldk_dijkstra',
        outcome: 'succeeded',
        failureReason: null,
        outboundRatioPct: 75,
        feeMsat: 50,
        notes: 'ok',
        remoteBalanceMsat: '90000000',
      }),
    /PRIVACY_VIOLATION|Vietato salvare dati di terze parti/,
  );

  // Rejects multi-hop path / third-party route fields
  assert.throws(
    () =>
      assertFirstPartyEpisode({
        id: 'ep-bad-2',
        timestamp: 1700000000000,
        eventType: 'payment_succeeded',
        peerNodeId: BOB_PUBKEY,
        peerAlias: 'Bob',
        channelId: 'ch-bob-01',
        amountMsat: '3000000',
        assetId: null,
        assetAmount: null,
        routingAlgorithm: 'ldk_dijkstra',
        outcome: 'succeeded',
        failureReason: null,
        outboundRatioPct: 75,
        feeMsat: 50,
        notes: 'ok',
        hops: [{ fromNodeId: 'bob', toNodeId: 'erin' }],
      }),
    /PRIVACY_VIOLATION|Vietato salvare dati di terze parti/,
  );
});

test('EphemeralRoutingContext calcola i limiti dicotomici single-path vs MPP e azzera la RAM in wipe()', () => {
  const splitChannels: LiveChannelInput[] = [
    {
      channelId: 'ch-split-1',
      peerNodeId: BOB_PUBKEY,
      assetId: 'rgb:synthetic-route-test',
      capacitySat: '100000',
      outboundMsat: '12000000',
      inboundMsat: '88000000',
      assetLocalAmount: '12',
      assetRemoteAmount: '88',
      isUsable: true,
    },
    {
      channelId: 'ch-split-2',
      peerNodeId: CAROL_PUBKEY,
      assetId: 'rgb:synthetic-route-test',
      capacitySat: '100000',
      outboundMsat: '11000000',
      inboundMsat: '89000000',
      assetLocalAmount: '12',
      assetRemoteAmount: '88',
      isUsable: true,
    },
  ];

  // Requesting 18,000,000 msat and 20 RGB units: neither channel alone covers it, but together they do (24M msat, 24 RGB)
  const input = {
    amountMsat: '18000000',
    assetId: 'rgb:synthetic-route-test',
    assetAmount: '20',
    channels: splitChannels,
    knownNodes: [
      { alias: 'Bob', pubkey: BOB_PUBKEY },
      { alias: 'Carol', pubkey: CAROL_PUBKEY },
    ],
  };

  const ctx = new EphemeralRoutingContext(
    input,
    [
      {
        channelId: 'ch-split-1',
        peerNodeId: BOB_PUBKEY,
        classification: 'insufficient_liquidity',
        score: 25,
        reason: 'Sotto soglia per singolo canale',
      },
      {
        channelId: 'ch-split-2',
        peerNodeId: CAROL_PUBKEY,
        classification: 'insufficient_liquidity',
        score: 25,
        reason: 'Sotto soglia per singolo canale',
      },
    ],
    [],
  );

  const analysis = ctx.analyzeFeasibility(input);
  assert.equal(analysis.summary.singlePathPossible, false);
  assert.equal(analysis.summary.mppPossible, true);
  assert.equal(analysis.summary.recommendedMaxPaths, 2);
  assert.equal(analysis.summary.ephemeralRamWiped, true);
  assert.equal(ctx.isWiped(), false);

  ctx.wipe();
  assert.equal(ctx.isWiped(), true);
  assert.throws(() => ctx.analyzeFeasibility(input), /already wiped/);
});

test('selectRoutingStrategyDeterministic sceglie dinamicamente tutti e 4 gli algoritmi in base al contesto', () => {
  const defaultWeights = { fee: 40, reliability: 60, cltv: 10, hops: 20 };

  // 1. Small/fast native BTC on healthy single channel -> ldk_dijkstra (max_paths: 1)
  const fastBtc = selectRoutingStrategyDeterministic({
    input: {
      amountMsat: '4000000',
      assetId: null,
      assetAmount: null,
      channels: [
        {
          channelId: 'ch-1',
          peerNodeId: BOB_PUBKEY,
          assetId: null,
          capacitySat: '100000',
          outboundMsat: '80000000',
          inboundMsat: '20000000',
          assetLocalAmount: null,
          assetRemoteAmount: null,
          isUsable: true,
        },
      ],
      knownNodes: [{ alias: 'Bob', pubkey: BOB_PUBKEY }],
    },
    overallProfile: 'balanced',
    recommendedWeights: defaultWeights,
    excludedNodeIds: [],
    scoredChannels: [
      {
        channelId: 'ch-1',
        peerNodeId: BOB_PUBKEY,
        classification: 'optimal',
        score: 95,
        reason: 'Ottimo',
      },
    ],
    feasibility: {
      singlePathPossible: true,
      mppPossible: false,
      recommendedMaxPaths: 1,
      usableChannelCount: 1,
      singlePathHealthyChannelCount: 1,
      ephemeralRamWiped: true,
    },
    hasCongestedOrUnreliableHistory: false,
    ragHits: [],
  });
  assert.equal(fastBtc.selectedAlgorithm, 'ldk_dijkstra');
  assert.equal(fastBtc.reasonCode, 'small_fast_single_path');
  assert.equal(fastBtc.recommendedRouting.max_paths, 1);

  // 2. MPP split required across 2 channels -> min_cost_flow (max_paths: 2)
  const mppSplit = selectRoutingStrategyDeterministic({
    input: {
      amountMsat: '20000000',
      assetId: 'rgb:synthetic-route-test',
      assetAmount: '20',
      channels: [],
      knownNodes: [],
    },
    overallProfile: 'liquidity_preserving',
    recommendedWeights: defaultWeights,
    excludedNodeIds: [],
    scoredChannels: [],
    feasibility: {
      singlePathPossible: false,
      mppPossible: true,
      recommendedMaxPaths: 2,
      usableChannelCount: 3,
      singlePathHealthyChannelCount: 0,
      ephemeralRamWiped: true,
    },
    hasCongestedOrUnreliableHistory: false,
    ragHits: [],
  });
  assert.equal(mppSplit.selectedAlgorithm, 'min_cost_flow');
  assert.equal(mppSplit.reasonCode, 'mpp_liquidity_split');
  assert.equal(mppSplit.recommendedRouting.max_paths, 2);

  // 3. Congested channels / excluded nodes on BTC -> yen (alternative_paths_exploration)
  const yenChoice = selectRoutingStrategyDeterministic({
    input: {
      amountMsat: '5000000',
      assetId: null,
      assetAmount: null,
      channels: [],
      knownNodes: [],
    },
    overallProfile: 'high_reliability',
    recommendedWeights: defaultWeights,
    excludedNodeIds: [DAVE_PUBKEY],
    scoredChannels: [
      {
        channelId: 'ch-congested',
        peerNodeId: CAROL_PUBKEY,
        classification: 'congested',
        score: 48,
        reason: 'Congestionato',
      },
    ],
    feasibility: {
      singlePathPossible: true,
      mppPossible: true,
      recommendedMaxPaths: 1,
      usableChannelCount: 2,
      singlePathHealthyChannelCount: 1,
      ephemeralRamWiped: true,
    },
    hasCongestedOrUnreliableHistory: true,
    ragHits: [],
  });
  assert.equal(yenChoice.selectedAlgorithm, 'yen');
  assert.equal(yenChoice.reasonCode, 'alternative_paths_exploration');
  assert.deepEqual(yenChoice.recommendedRouting.excluded_nodes, [DAVE_PUBKEY]);

  // 4. RGB asset transfer on single healthy path -> multi_objective (rgb_asset_conservation)
  const rgbMultiObj = selectRoutingStrategyDeterministic({
    input: {
      amountMsat: '3000000',
      assetId: 'rgb:synthetic-route-test',
      assetAmount: '5',
      channels: [],
      knownNodes: [],
    },
    overallProfile: 'high_reliability',
    recommendedWeights: { fee: 10, reliability: 150, cltv: 10, hops: 20 },
    excludedNodeIds: [],
    scoredChannels: [
      {
        channelId: 'ch-rgb-1',
        peerNodeId: BOB_PUBKEY,
        classification: 'optimal',
        score: 92,
        reason: 'Ottimo RGB',
      },
    ],
    feasibility: {
      singlePathPossible: true,
      mppPossible: true,
      recommendedMaxPaths: 1,
      usableChannelCount: 2,
      singlePathHealthyChannelCount: 2,
      ephemeralRamWiped: true,
    },
    hasCongestedOrUnreliableHistory: false,
    ragHits: [],
  });
  assert.equal(rgbMultiObj.selectedAlgorithm, 'multi_objective');
  assert.equal(rgbMultiObj.reasonCode, 'rgb_asset_conservation');
});

test('QvacRagStore.loadSyntheticNodeHistory carica solo i dati first-party del nodo scelto (es. alice su history-0100)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'airgb-fixture-loader-'));
  const ragStore = new QvacRagStore(dir);
  try {
    // Load history-0100 strictly for 'alice' with maxRagIngest=0 (offline SQLite check)
    const loadedAlice = await ragStore.loadSyntheticNodeHistory({
      level: 100,
      nodeId: 'alice',
      maxRagIngest: 0,
    });

    assert.equal(loadedAlice.nodeId, 'alice');
    assert.equal(loadedAlice.level, 100);
    assert.equal(loadedAlice.privacyCheck, 'first_party_node_scoped_only');
    assert.ok(loadedAlice.loadedSqliteCount > 0);
    assert.equal(ragStore.countEpisodes(), loadedAlice.loadedSqliteCount);
    assert.equal(loadedAlice.channels.length, 3); // Alice has 3 direct channels in topology.json (bob, carol, dave)
    assert.equal(loadedAlice.knownNodes.length, 10);

    // Verify every stored episode belongs exclusively to Alice's first-party observations
    const episodes = ragStore.listEpisodes(200);
    assert.equal(episodes.length, loadedAlice.loadedSqliteCount);
    for (const ep of episodes) {
      assert.match(ep.id, /-alice-(incoming|outgoing)-/);
      assertFirstPartyEpisode(ep);
    }

    // Switching to 'judy' on history-0020 resets the store cleanly without mixing Alice's episodes
    const loadedJudy = await ragStore.loadSyntheticNodeHistory({
      level: 20,
      nodeId: 'judy',
      maxRagIngest: 0,
    });
    assert.equal(loadedJudy.nodeId, 'judy');
    assert.equal(ragStore.countEpisodes(), loadedJudy.loadedSqliteCount);
    const judyEpisodes = ragStore.listEpisodes(100);
    for (const ep of judyEpisodes) {
      assert.match(ep.id, /-judy-(incoming|outgoing)-/);
    }
  } finally {
    ragStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('selectRoutingAlgorithmWithQvac integra fixture first-party, QVAC RAG + selector e rispetta i vincoli compilati', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'airgb-select-algo-'));
  let chatCalls = 0;

  const mockQvac = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let body = '';
    for await (const chunk of req) body += chunk;

    if (req.method === 'GET' && url.pathname === '/v1/vector_stores') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'vs_algo_01', name: 'airgb-channel-telemetry-alice-100' }] }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/vector_stores/vs_algo_01/search') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          data: [
            {
              file_id: 'file-1',
              filename: 'synthetic-ep-1.txt',
              score: 0.88,
              content: [{ type: 'text', text: '[TELEMETRY synthetic-ep-1] Outcome=succeeded algorithm=min_cost_flow' }],
            },
          ],
        }),
      );
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      chatCalls++;
      const parsedReq = JSON.parse(body) as {
        response_format?: { json_schema?: { name?: string } };
      };
      const schemaName = parsedReq.response_format?.json_schema?.name;

      if (schemaName === 'routing_algorithm_selector') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content: JSON.stringify({
                    schemaVersion: '1.0',
                    selectedAlgorithm: 'min_cost_flow',
                    reasonCode: 'mpp_liquidity_split',
                    recommendedMaxPaths: 2,
                    recommendedWeights: { fee: 35, reliability: 90, cltv: 10, hops: 25 },
                    rationale: 'Split MPP su 2 canali per coprire 20 unità RGB senza esaurire un singolo canale.',
                  }),
                },
              },
            ],
          }),
        );
        return;
      }

      // Default: channel_scoring_classifier response
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({
                  schemaVersion: '1.0',
                  overallProfile: 'liquidity_preserving',
                  recommendedWeights: { fee: 35, reliability: 90, cltv: 10, hops: 25 },
                  channels: [],
                  summary: 'Canali valutati per split MPP.',
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
    const fixture = await ragStore.loadSyntheticNodeHistory({
      level: 100,
      nodeId: 'alice',
      maxRagIngest: 0,
    });

    const compiled = compileConstraints({
      extracted: {
        schemaVersion: '1.0',
        status: 'parsed',
        feeLimit: { value: '1500', unit: 'msat', comparison: 'lte' },
        excludedNodeReferences: [],
        priority: 'reliability',
        privacyRequest: null,
        unhandledRequests: [],
      },
      payment: {
        invoice: 'lnbcrt-mpp-test',
        amount: '20000000',
        assetId: 'rgb:synthetic-route-test',
        network: 'regtest',
      },
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
      knownNodes: fixture.knownNodes,
    });

    // Request 45 RGB units across Alice's 3 channels (Alice's channels have ~30, 20, 20 RGB units, so no single channel covers 45, but 2 channels together cover 50 >= 45)
    const selection = await selectRoutingAlgorithmWithQvac(
      {
        amountMsat: '20000000',
        assetId: 'rgb:synthetic-route-test',
        assetAmount: '45',
        compiledPolicy: compiled.policy,
        channels: fixture.channels,
        knownNodes: fixture.knownNodes,
      },
      ragStore,
    );

    assert.equal(chatCalls, 2);
    assert.equal(selection.selectedAlgorithm, 'min_cost_flow');
    assert.equal(selection.reasonCode, 'mpp_liquidity_split');
    assert.ok((selection.recommendedRouting.max_paths ?? 1) >= 2);
    assert.equal(selection.recommendedRouting.max_fee_msat, 1500);
    assert.equal(selection.feasibility.ephemeralRamWiped, true);
    assert.equal(selection.feasibility.singlePathPossible, false);
    assert.equal(selection.feasibility.mppPossible, true);
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
