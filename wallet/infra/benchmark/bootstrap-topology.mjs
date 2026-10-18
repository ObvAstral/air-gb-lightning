import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, comparableState, readJson } from './common.mjs';
import { createAirgbAdapter } from './adapters.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const walletRoot = resolve(here, '../..');
const repoRoot = resolve(walletRoot, '..');
const { values: cliArgs } = parseArgs({
  options: {
    topology: { type: 'string', default: join(repoRoot, 'topology.json') },
    expectedHash: { type: 'string', default: '' },
  },
  strict: false,
});

const pause = ms => new Promise(r => setTimeout(r, ms));
const log = (step, data = {}) => console.log(JSON.stringify({ step, ...data }));

async function until(desc, fn, attempts = 120, delayMs = 1000) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fn();
      if (res) return res;
    } catch (err) {
      lastErr = err;
    }
    await pause(delayMs);
  }
  throw new Error(`Timeout waiting for ${desc}${lastErr ? `: ${lastErr.message}` : ''}`);
}

const envRaw = await readFile(join(walletRoot, 'native-data/regtest/wallet.env'), 'utf8');
const env = Object.fromEntries(
  envRaw
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => {
      const idx = l.indexOf('=');
      return [l.slice(0, idx), l.slice(idx + 1)];
    }),
);

const rpcUser = process.env.BITCOIND_RPC_USER ?? env.BITCOIND_RPC_USER ?? 'user';
const rpcPass = process.env.BITCOIND_RPC_PASSWORD ?? env.BITCOIND_RPC_PASSWORD;
const rpcHost = process.env.BITCOIND_RPC_HOST ?? env.BITCOIND_RPC_HOST ?? '127.0.0.1';
const rpcPort = process.env.BITCOIND_RPC_PORT ?? env.BITCOIND_RPC_PORT ?? '18443';

async function btcRpc(method, params = [], wallet = '') {
  const url = `http://${rpcHost}:${rpcPort}${wallet ? `/wallet/${wallet}` : ''}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${rpcUser}:${rpcPass}`).toString('base64')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'bootstrap', method, params }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(`BTC RPC ${method}: ${data.error?.message ?? res.status}`);
  return data.result;
}

async function ensureMinerWallet() {
  const wallets = await btcRpc('listwallets');
  if (!wallets.includes('miner')) {
    try {
      await btcRpc('loadwallet', ['miner']);
    } catch {
      await btcRpc('createwallet', ['miner']);
    }
  }
}

async function mine(blocks = 1) {
  const addr = await btcRpc('getnewaddress', [], 'miner');
  await btcRpc('generatetoaddress', [blocks, addr], 'miner');
}

class NodeClient {
  constructor(id, port) {
    this.id = id;
    this.port = port;
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.token = null;
  }
  async session() {
    if (this.token) return this.token;
    const res = await fetch(`${this.baseUrl}/api/session`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`${this.id} session HTTP ${res.status}`);
    const data = await res.json();
    this.token = data.token;
    return this.token;
  }
  async get(path) {
    const token = await this.session();
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { 'x-session-token': token },
      signal: AbortSignal.timeout(60000),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`${this.id} GET ${path}: ${data.code ?? res.status} ${data.message ?? ''}`);
    return data;
  }
  async post(path, body = {}) {
    const token = await this.session();
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: this.baseUrl,
        'x-session-token': token,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`${this.id} POST ${path}: ${data.code ?? res.status} ${data.message ?? ''}`);
    return data;
  }
}

const topologyPath = resolve(cliArgs.topology || join(repoRoot, 'topology.json'));
const topology = await readJson(topologyPath);
const clients = Object.fromEntries(topology.nodes.map(n => [n.id, new NodeClient(n.id, n.apiPort ?? n.servicePort)]));

await until('bitcoind ready', async () => {
  await btcRpc('getblockchaininfo');
  return true;
});
await ensureMinerWallet();
const initialHeight = await btcRpc('getblockcount');
if (initialHeight < 105) {
  await mine(105 - initialHeight);
}
log('chain_ready', { height: await btcRpc('getblockcount') });

await mkdir(join(walletRoot, 'native-data/topology'), { recursive: true, mode: 0o700 });
const passwordsPath = join(walletRoot, 'native-data/topology/passwords.json');
let passwords = {};
try {
  passwords = JSON.parse(await readFile(passwordsPath, 'utf8'));
} catch {
  passwords = Object.fromEntries(topology.nodes.map(n => [n.id, randomBytes(24).toString('hex')]));
  await writeFile(passwordsPath, JSON.stringify(passwords, null, 2) + '\n', { mode: 0o600 });
}

for (const n of topology.nodes) {
  const c = clients[n.id];
  await until(`${n.id} health`, async () => {
    const res = await fetch(`${c.baseUrl}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return false;
    const h = await res.json();
    return h.api === 'ready';
  });
  const state = await c.get('/api/wallet/state');
  if (!state.keystoreExists) {
    await c.post('/api/wallet/create', { password: passwords[n.id] });
  }
  if (state.node !== 'ready') {
    await c.post('/api/wallet/unlock', { password: passwords[n.id] });
  }
  log('node_unlocked', { node: n.id, port: n.apiPort ?? n.servicePort });
}

const summaries = {};
for (const n of topology.nodes) {
  const s = await clients[n.id].get('/api/wallet/summary');
  summaries[n.id] = s;
  if (BigInt(s.btcSpendableSat) < 10_000_000n) {
    await btcRpc('sendtoaddress', [s.address, 0.2], 'miner');
  }
}
await mine(6);

for (const n of topology.nodes) {
  const c = clients[n.id];
  await until(`${n.id} BTC funded`, async () => {
    await c.post('/api/wallet/sync');
    const s = await c.get('/api/wallet/summary');
    summaries[n.id] = s;
    return BigInt(s.btcSpendableSat) >= 10_000_000n;
  });
  await c.post('/api/wallet/rgb/utxos', { count: 4, sizeSat: '1000000', feeRateSatPerVbyte: '2' });
}
await mine(6);
for (const n of topology.nodes) {
  await clients[n.id].post('/api/wallet/sync');
}
log('utxos_prepared', { nodes: topology.nodes.length });

const assetSpec = Array.isArray(topology.assets) ? topology.assets.find(a => a.id === 'TEST') : topology.assets.TEST;
const issuer = clients[assetSpec.issuer];
const existingAssets = await issuer.get('/api/wallet/assets');
let assetId = existingAssets.find(a => a.ticker === assetSpec.ticker)?.assetId;
if (!assetId) {
  const issued = await issuer.post('/api/wallet/rgb/issue', {
    ticker: assetSpec.ticker,
    name: assetSpec.name,
    precision: assetSpec.precision,
    amounts: [Number(assetSpec.supply)],
  });
  assetId = issued.assetId;
  log('asset_issued', { assetId, supply: issued.issuedSupply });
} else {
  log('asset_reused', { assetId });
}

const recipients = [];
const recipientIds = [];
for (const [nodeId, amount] of Object.entries(assetSpec.initialAllocations)) {
  if (nodeId === assetSpec.issuer || BigInt(amount) === 0n) continue;
  const bal = await clients[nodeId].get(`/api/wallet/asset-balance?assetId=${encodeURIComponent(assetId)}`).catch(() => ({ spendable: '0' }));
  if (BigInt(bal.spendable ?? '0') >= BigInt(amount)) continue;
  const r = await clients[nodeId].post('/api/wallet/receive/rgb', {
    assetId: null,
    amount: null,
    expirySec: 3600,
  });
  recipients.push({ invoice: r.invoice, amount: String(amount) });
  recipientIds.push([nodeId, String(amount)]);
}

if (recipients.length > 0) {
  const sendRes = await issuer.post('/api/wallet/rgb/send', {
    assetId,
    recipients,
    donation: true,
    feeRateSatPerVbyte: '2',
  });
  log('asset_distribution_sent', { txid: sendRes.txid, recipients: recipientIds.length });

  await until('distribution tx in mempool', async () => {
    if (!sendRes.txid) return true;
    await btcRpc('getmempoolentry', [sendRes.txid]);
    return true;
  });
  await mine(6);

  for (const [nodeId, expectedAmount] of [[assetSpec.issuer, assetSpec.initialAllocations[assetSpec.issuer]], ...recipientIds]) {
    await until(`${nodeId} RGB balance == ${expectedAmount}`, async () => {
      await clients[nodeId].post('/api/wallet/sync');
      const b = await clients[nodeId].get(`/api/wallet/asset-balance?assetId=${encodeURIComponent(assetId)}`);
      return b.spendable === String(expectedAmount);
    });
  }
}
log('asset_distribution_confirmed', { assetId });

const defaults = topology.channelDefaults ?? {};
for (const rawCh of topology.channels) {
  const ch = { ...defaults, ...rawCh };
  const sender = clients[ch.from];
  const receiver = clients[ch.to];
  const receiverSummary = summaries[ch.to];

  const existing = (await sender.get('/api/wallet/channels')).find(
    row => row.peerNodeId === receiverSummary.nodeId && row.assetId === assetId && row.isUsable,
  );
  if (existing) {
    log('channel_already_ready', { id: ch.id, channelId: existing.channelId });
    continue;
  }

  const utxoRes = await sender.post('/api/wallet/rgb/utxos', {
    count: 4,
    sizeSat: '1000000',
    feeRateSatPerVbyte: '2',
  });
  if (utxoRes.confirmationRequired) {
    await mine(2);
    await sender.post('/api/wallet/sync');
    await receiver.post('/api/wallet/sync');
  }

  await sender.post('/api/wallet/peers/connect', { peer: receiverSummary.peerUri });
  const existingIds = new Set((await sender.get('/api/wallet/channels')).map(c => c.channelId));

  const cfg = { ...(topology.channelDefaults ?? {}), ...ch };
  await sender.post('/api/wallet/channels/open', {
    peer: receiverSummary.peerUri,
    capacitySat: String(cfg.capacity_sat ?? 1000000),
    public: cfg.public ?? true,
    withAnchors: cfg.with_anchors ?? true,
    pushMsat: cfg.push_msat ?? 0,
    pushAssetAmount: cfg.push_asset_amount ?? 0,
    feeBaseMsat: cfg.fee_base_msat ?? 0,
    feeProportionalMillionths: cfg.fee_proportional_millionths ?? 0,
    assetId,
    assetAmount: String(cfg.asset_amount),
  });

  let openedChannel = null;
  await until(`funding tx in mempool for ${ch.id}`, async () => {
    await sender.post('/api/wallet/sync');
    const list = await sender.get('/api/wallet/channels');
    openedChannel = list.find(
      row =>
        !existingIds.has(row.channelId) &&
        row.peerNodeId === receiverSummary.nodeId &&
        row.assetId === assetId &&
        row.fundingTxid,
    );
    if (!openedChannel) return false;
    await btcRpc('getmempoolentry', [openedChannel.fundingTxid]);
    return true;
  });

  await mine(6);

  await until(`channel ${ch.id} usable on ${ch.from} and ${ch.to}`, async () => {
    await sender.post('/api/wallet/sync');
    await receiver.post('/api/wallet/sync');
    const sChans = await sender.get('/api/wallet/channels');
    const rChans = await receiver.get('/api/wallet/channels');
    const sOk = sChans.some(
      row => row.channelId === openedChannel.channelId && row.isUsable && row.assetLocalAmount === String(ch.asset_amount),
    );
    const rOk = rChans.some(
      row => row.channelId === openedChannel.channelId && row.isUsable && row.assetRemoteAmount === String(ch.asset_amount),
    );
    return sOk && rOk;
  });

  log('channel_ready', {
    id: ch.id,
    from: ch.from,
    to: ch.to,
    channelId: openedChannel.channelId,
    assetAmount: ch.asset_amount,
    feeBaseMsat: ch.fee_base_msat,
  });
}

for (const n of topology.nodes) {
  await clients[n.id].post('/api/wallet/sync');
}

const routingNodes = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi', 'ivan', 'judy'];
for (const nodeId of routingNodes) {
  await until(`gossip convergence on ${nodeId} (>= 15 channels)`, async () => {
    await clients[nodeId].post('/api/wallet/sync');
    const s = await clients[nodeId].get('/api/wallet/summary');
    return Number(s.nodeInfo?.network_channels ?? 0) >= 15;
  });
}

const configPath = join(walletRoot, 'native-data/benchmark-ai.json');
const benchmarkConfig = {
  label: 'machine-a',
  assets: {
    TEST: assetId,
  },
  paymentTimeoutMs: 180000,
  observationTimeoutMs: 15000,
  requestTimeoutMs: 120000,
  nodes: {},
  logDirectories: {},
};
await writeFile(configPath, JSON.stringify(benchmarkConfig, null, 2) + '\n', { mode: 0o600 });

const adapter = createAirgbAdapter({ topology, config: benchmarkConfig });
const initial = await adapter.snapshot();
const initialStateHash = hash(comparableState(initial, benchmarkConfig.assets));
const defaultExpectedHash =
  topologyPath === resolve(join(repoRoot, 'topology.json'))
    ? '74f9e4d65bf689763f0947c31b02abd13d76db94caed3225f633d485a06c6e91'
    : '';
const expectedInitialStateHash = cliArgs.expectedHash || defaultExpectedHash;

log('bootstrap_complete', {
  topologyPath,
  configPath,
  assetId,
  initialStateHash,
  expectedInitialStateHash: expectedInitialStateHash || null,
  matchesBaselineInitialState: expectedInitialStateHash ? initialStateHash === expectedInitialStateHash : null,
});

if (expectedInitialStateHash && initialStateHash !== expectedInitialStateHash) {
  console.error('initialStateHash mismatch!', JSON.stringify(comparableState(initial, benchmarkConfig.assets), null, 2));
  process.exitCode = 1;
}
