import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import phrases from '../tests/phrases.json' with { type: 'json' };
import { interpretWithQvac } from '../apps/local-service/interpret.ts';
import { compileConstraints } from '../packages/policy/compile.ts';

const walletRoot = fileURLToPath(new URL('../', import.meta.url));
const configPath = path.join(walletRoot, 'qvac.config.json');
const qvacUrl = process.env.QVAC_URL ?? 'http://127.0.0.1:11434';
const targetModel = process.env.QVAC_MODEL ?? 'qwen-fast';

const ALICE_PUBKEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const BOB_PUBKEY = '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5';

const CAPABILITIES = {
  backendVersion: 'ObvAstral/rgb-lightning-node@7106edd0fa3d/rust-lightning@2f19847fc65a',
  revision: 'rgb-mpp-1',
  hardFeeCap: true,
  hardNodeExclusion: true,
  hardChannelExclusion: false,
  perPaymentScoringProfile: true,
  avoidExtraProbing: true,
  canInspectFullRoute: true,
  canGuaranteeConstraintsAcrossRetries: true,
};

const KNOWN_NODES = [
  { alias: 'Alice', pubkey: ALICE_PUBKEY },
  { alias: 'Bob', pubkey: BOB_PUBKEY },
];

const PAYMENT = {
  invoice: 'lnbcrt50u1p0testinvoice',
  amount: '5000000',
  assetId: 'BTC',
  network: 'regtest',
};

function matchesExpected(expected, extracted, compiled) {
  switch (expected) {
    case 'fee_lte_10000':
      return compiled.status === 'validated' && compiled.normalized?.maxRoutingFeeMsat === '10000';
    case 'fee_lte_9999':
      return compiled.status === 'validated' && compiled.normalized?.maxRoutingFeeMsat === '9999';
    case 'fee_lte_1500':
      return compiled.status === 'validated' && compiled.normalized?.maxRoutingFeeMsat === '1500';
    case 'fee_lte_1000':
      return compiled.status === 'validated' && compiled.normalized?.maxRoutingFeeMsat === '1000';
    case 'fee_lte_0':
      return compiled.status === 'validated' && compiled.normalized?.maxRoutingFeeMsat === '0';
    case 'exclude_Bob':
      return compiled.status === 'validated' && compiled.normalized?.excludedNodeIds.includes(BOB_PUBKEY);
    case 'exclude_Alice':
      return compiled.status === 'validated' && compiled.normalized?.excludedNodeIds.includes(ALICE_PUBKEY);
    case 'exclude_Bob_Alice':
      return (
        compiled.status === 'validated' &&
        compiled.normalized?.excludedNodeIds.includes(BOB_PUBKEY) &&
        compiled.normalized?.excludedNodeIds.includes(ALICE_PUBKEY)
      );
    case 'no_exclusion':
      return compiled.status === 'validated' && compiled.normalized?.excludedNodeIds.length === 0;
    case 'priority_lowest_fee':
    case 'priority_lowest_fee_no_fee_cap':
      return (
        compiled.status === 'validated' &&
        compiled.normalized?.priority === 'lowest_fee' &&
        compiled.normalized?.maxRoutingFeeMsat === null
      );
    case 'priority_reliability':
      return compiled.status === 'validated' && compiled.normalized?.priority === 'reliability';
    case 'fee_lte_10000_priority_reliability':
      return (
        compiled.status === 'validated' &&
        compiled.normalized?.maxRoutingFeeMsat === '10000' &&
        compiled.normalized?.priority === 'reliability'
      );
    case 'fee_lte_2000_exclude_Bob':
      return (
        compiled.status === 'validated' &&
        compiled.normalized?.maxRoutingFeeMsat === '2000' &&
        compiled.normalized?.excludedNodeIds.includes(BOB_PUBKEY)
      );
    case 'avoid_extra_probing':
      return compiled.status === 'validated' && compiled.normalized?.privacyPreference === 'avoid_extra_probing';
    case 'needs_clarification':
    case 'unsupported_request':
      return compiled.status === 'needs_clarification';
    case 'out_of_scope':
      return extracted.status === 'out_of_scope' && compiled.status === 'needs_clarification';
    default:
      return false;
  }
}

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

try {
  await waitForServer();
  console.log(`\n✓ QVAC server reachable at ${qvacUrl}`);
  process.env.QVAC_URL = qvacUrl;
  process.env.QVAC_MODEL = targetModel;

  console.log(`\n=== Benchmarking ${phrases.length} phrases with QVAC_MODEL=${targetModel} ===`);
  let matched = 0;
  for (const item of phrases) {
    try {
      const { extracted, latencyMs } = await interpretWithQvac(item.text);
      const compiled = compileConstraints({
        extracted,
        payment: PAYMENT,
        capabilities: CAPABILITIES,
        knownNodes: KNOWN_NODES,
      });
      const ok = matchesExpected(item.expected, extracted, compiled);
      if (ok) {
        matched++;
        console.log(`  ✓ [${item.expected}] "${item.text}" (${latencyMs} ms)`);
      } else {
        console.warn(`  ✗ [${item.expected}] "${item.text}" (${latencyMs} ms)`);
        console.warn(`    extracted: ${JSON.stringify(extracted)}`);
        console.warn(`    compiled:  status=${compiled.status} code=${compiled.code} norm=${JSON.stringify(compiled.normalized)}`);
      }
    } catch (err) {
      console.warn(`  ✗ [${item.expected}] "${item.text}" -> ${err.code ?? 'ERR'}: ${err.message}`);
    }
  }

  console.log(`\n=== Summary (${targetModel}): ${matched}/${phrases.length} phrases matched expected outcome ===`);
  if (matched !== phrases.length) {
    process.exitCode = 1;
  }
} finally {
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
