import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { QvacRagStore, scoreChannelsWithQvac } from '../../apps/local-service/channel-scoring.ts';

const walletRoot = fileURLToPath(new URL('../../', import.meta.url));
const configPath = path.join(walletRoot, 'qvac.config.json');
const qvacUrl = process.env.QVAC_URL ?? 'http://127.0.0.1:11434';
const targetModel = process.env.QVAC_MODEL ?? 'qwen-fast';

const ALICE_PUBKEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const BOB_PUBKEY = '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5';
const CAROL_PUBKEY = '02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9';
const DAVE_PUBKEY = '02e493dbf1c10d80f3581e4904930b1404cc6c13900ee0758474fa94abe8c4cd13';

async function isServerUp() {
  try {
    const res = await fetch(`${qvacUrl}/v1/models`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForServer(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isServerUp()) return;
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error(`Timed out waiting for QVAC server at ${qvacUrl}`);
}

let child = null;
const alreadyRunning = await isServerUp();

if (!alreadyRunning) {
  console.log(`Starting qvac serve --openai -c ${configPath} ...`);
  child = spawn('qvac', ['serve', '--openai', '--port', '11434', '-c', configPath], {
    cwd: walletRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => process.stdout.write(`[qvac] ${chunk}`));
  child.stderr.on('data', chunk => process.stderr.write(`[qvac] ${chunk}`));
}

const tempDir = await mkdtemp(path.join(tmpdir(), 'airgb-qvac-scoring-smoke-'));
const ragStore = new QvacRagStore(tempDir);

try {
  await waitForServer();
  process.env.QVAC_URL = qvacUrl;
  process.env.QVAC_MODEL = targetModel;

  const knownNodes = [
    { alias: 'Alice', pubkey: ALICE_PUBKEY },
    { alias: 'Bob', pubkey: BOB_PUBKEY },
    { alias: 'Carol-Relay', pubkey: CAROL_PUBKEY },
  ];

  const channels = [
    {
      channelId: 'ch-bob-primary-01',
      peerNodeId: BOB_PUBKEY,
      assetId: 'rgb:2eVw8uw-9bf88LQ-T357192-G12422M-749193s-n39485',
      capacitySat: '100000',
      outboundMsat: '78000000',
      inboundMsat: '22000000',
      assetLocalAmount: '120',
      assetRemoteAmount: '30',
      isUsable: true,
    },
    {
      channelId: 'ch-congested-edge-02',
      peerNodeId: CAROL_PUBKEY,
      assetId: 'rgb:2eVw8uw-9bf88LQ-T357192-G12422M-749193s-n39485',
      capacitySat: '100000',
      outboundMsat: '11000000',
      inboundMsat: '89000000',
      assetLocalAmount: '60',
      assetRemoteAmount: '90',
      isUsable: true,
    },
    {
      channelId: 'ch-offline-03',
      peerNodeId: DAVE_PUBKEY,
      assetId: 'rgb:2eVw8uw-9bf88LQ-T357192-G12422M-749193s-n39485',
      capacitySat: '50000',
      outboundMsat: '500000',
      inboundMsat: '49500000',
      assetLocalAmount: '2',
      assetRemoteAmount: '48',
      isUsable: false,
    },
  ];

  console.log('\n1. Seeding demo telemetry into QVAC /v1/vector_stores (TurboVec + EMBEDDINGGEMMA_300M_Q4_0)...');
  const seeded = await ragStore.seedDemoEpisodes({ channels, knownNodes });
  assert.equal(seeded.seededCount, 5);
  assert.ok(seeded.vectorStoreId, 'Expected a valid vectorStoreId from qvac serve');
  console.log(`   ✓ Vector store ready: ${seeded.vectorStoreId} (${seeded.seededCount} episodes ingested)`);

  console.log('\n2. Running QVAC RAG Search + Channel Scoring Classifier...');
  const result = await scoreChannelsWithQvac(
    {
      amountMsat: '3000000',
      assetId: 'rgb:2eVw8uw-9bf88LQ-T357192-G12422M-749193s-n39485',
      assetAmount: '15',
      payeePubkey: BOB_PUBKEY,
      userPreference: 'Voglio un pagamento affidabile evitando canali congestionati',
      channels,
      knownNodes,
    },
    ragStore,
  );

  console.log(`   ✓ Profile: ${result.overallProfile} (${result.latencyMs} ms)`);
  console.log(`   ✓ Weights: ${JSON.stringify(result.recommendedWeights)}`);
  console.log(`   ✓ RAG hits retrieved: ${result.ragHits.length}`);
  for (const hit of result.ragHits) {
    console.log(`     - [score=${hit.score}] ${hit.filename}: ${hit.text.slice(0, 100)}...`);
  }
  console.log('   ✓ Channel classifications:');
  for (const ch of result.channels) {
    console.log(`     - ${ch.channelId} (${ch.peerAlias ?? ch.peerNodeId.slice(0, 12)}): [${ch.classification} · ${ch.score}/100] ${ch.reason}`);
  }

  assert.equal(result.schemaVersion, '1.0');
  assert.equal(result.ragBackend, 'qvac-turbovec');
  assert.ok(result.ragHits.length > 0, 'Expected at least 1 RAG telemetry hit from vector store search');
  assert.equal(result.channels.length, 3);
  const bobCh = result.channels.find(c => c.channelId === 'ch-bob-primary-01');
  const offlineCh = result.channels.find(c => c.channelId === 'ch-offline-03');
  assert.ok(bobCh && (bobCh.classification === 'optimal' || bobCh.classification === 'good'));
  assert.equal(offlineCh?.classification, 'avoid');
  assert.equal(result.excludedNodeIds.includes(BOB_PUBKEY), false);
  assert.equal(result.excludedNodeIds.includes(DAVE_PUBKEY), true);

  console.log('\n=== QVAC RAG + Channel Scoring Smoke Test PASSED ===');
} finally {
  ragStore.close();
  await rm(tempDir, { recursive: true, force: true });
  if (child) {
    child.kill('SIGTERM');
    await new Promise(resolve => {
      child.once('exit', resolve);
      setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 5000);
    });
  }
}
