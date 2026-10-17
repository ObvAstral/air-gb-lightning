import assert from 'node:assert/strict';
import { createHash, ECDH } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = join(root, 'wallet/tests/fixtures/routing-history');
const generator = 'wallet/scripts/generate-routing-history.mjs';
const check = process.argv.includes('--check');
assert(process.argv.slice(2).every(arg => arg === '--check'), 'Only --check is supported');
const levels = [20, 100, 500, 2000];
const label = 'airgb-synthetic-routing-history-v1';
const asOf = '2026-10-01T00:00:00.000Z';
const start = Date.parse('2026-01-01T00:00:00.000Z');
const digest = value => createHash('sha256').update(value).digest('hex');
const integer = (key, max) => parseInt(digest(`${label}:${key}`).slice(0, 8), 16) % max;
const source = await readFile(join(root, 'topology.json'), 'utf8');
const topology = JSON.parse(source);
assert.equal(topology.nodes.length, 10);
assert.equal(topology.channels.length, 15);
const nodeIds = topology.nodes.map(node => node.id);
assert.equal(new Set(nodeIds).size, 10);

// Deterministic valid curve points; no wallet or private key is read or created.
function syntheticPubkey(id) {
  for (let counter = 0; ; counter++) {
    const candidate = `02${digest(`${label}:public-point:${id}:${counter}`)}`;
    try {
      return ECDH.convertKey(candidate, 'secp256k1', 'hex', 'hex', 'compressed');
    } catch { /* Try another synthetic x coordinate. */ }
  }
}
const nodes = topology.nodes.map(({ id, alias }) => ({ id, alias, pubkey: syntheticPubkey(id) }));
const nodeById = new Map(nodes.map(node => [node.id, node]));
const assetId = 'rgb:synthetic-route-test';
const ratios = [85, 65, 45, 75, 25, 55, 20, 35, 80, 70, 10, 30, 60, 80, 40];
const channels = topology.channels.map((channel, index) => ({
  id: channel.id,
  channelId: digest(`${label}:channel:${channel.id}`),
  from: channel.from,
  to: channel.to,
  assetId,
  capacitySat: String(channel.capacity_sat ?? topology.channelDefaults.capacity_sat),
  assetCapacity: String(channel.asset_amount),
  forwardFeeBaseMsat: channel.fee_base_msat,
  reverseFeeBaseMsat: channel.fee_base_msat,
  feeProportionalMillionths: 0,
  initialFromRatioPct: ratios[index],
}));
const byPair = new Map();
const byChannelId = new Map();
const states = new Map();
for (const channel of channels) {
  assert(nodeById.has(channel.from) && nodeById.has(channel.to));
  byPair.set(`${channel.from}:${channel.to}`, channel);
  byPair.set(`${channel.to}:${channel.from}`, channel);
  byChannelId.set(channel.channelId, channel);
  const total = BigInt(channel.capacitySat) * 1000n;
  const from = total * BigInt(channel.initialFromRatioPct) / 100n;
  const asset = BigInt(channel.assetCapacity);
  states.set(channel.channelId, { from, to: total - from, assetFrom: asset / 2n, assetTo: asset - asset / 2n });
}
function stateRows(current) {
  return channels.map(channel => {
    const state = current.get(channel.channelId);
    return { channelId: channel.channelId, fromMsat: String(state.from), toMsat: String(state.to),
      fromAssetAmount: String(state.assetFrom), toAssetAmount: String(state.assetTo) };
  });
}
const initialChannelStates = stateRows(states);
function ratioAt(current, channelId, nodeId) {
  const channel = byChannelId.get(channelId);
  const state = current.get(channelId);
  const outbound = nodeId === channel.from ? state.from : state.to;
  return Number(outbound * 100n / (state.from + state.to));
}
function liveChannels(current) {
  return Object.fromEntries(nodes.map(node => [node.id, channels.filter(ch => ch.from === node.id || ch.to === node.id).map(ch => {
    const state = current.get(ch.channelId);
    const from = ch.from === node.id;
    return { channelId: ch.channelId, peerNodeId: nodeById.get(from ? ch.to : ch.from).pubkey, assetId,
      capacitySat: ch.capacitySat, outboundMsat: String(from ? state.from : state.to),
      inboundMsat: String(from ? state.to : state.from), assetLocalAmount: String(from ? state.assetFrom : state.assetTo),
      assetRemoteAmount: String(from ? state.assetTo : state.assetFrom), isUsable: true, public: true };
  })]));
}
const routeCatalog = [
  ['alice', 'bob', 'erin', 'heidi', 'judy'],
  ['bob', 'frank', 'ivan'],
  ['carol', 'erin', 'heidi'],
  ['dave', 'grace', 'ivan', 'judy'],
  ['erin', 'bob', 'frank'],
  ['grace', 'dave', 'alice'],
  ['heidi', 'erin', 'bob'],
  ['ivan', 'frank', 'carol'],
  ['judy', 'ivan', 'grace', 'dave'],
  ['frank', 'dave', 'grace'],
];
const algorithms = ['ldk_dijkstra', 'yen', 'min_cost_flow', 'multi_objective'];
function makePath(route, finalAmount, assetAmount, settled) {
  let carried = finalAmount;
  const hops = Array(route.length - 1);
  for (let i = route.length - 2; i >= 0; i--) {
    const from = route[i], to = route[i + 1];
    const channel = byPair.get(`${from}:${to}`);
    assert(channel, `Missing topology edge ${from}:${to}`);
    const forwardingFeeMsat = i === 0 ? 0 : channel.from === from ? channel.forwardFeeBaseMsat : channel.reverseFeeBaseMsat;
    hops[i] = { channelId: channel.channelId, fromNodeId: from, toNodeId: to,
      amountMsat: String(carried), forwardingFeeMsat };
    carried += BigInt(forwardingFeeMsat);
  }
  return { nodes: route, amountMsat: String(finalAmount), assetAmount: assetAmount === null ? null : String(assetAmount),
    plannedFeeMsat: Number(carried - finalAmount), settled, hops };
}
function apply(current, transaction) {
  if (transaction.outcome !== 'succeeded') return;
  for (const path of transaction.paths) {
    for (const hop of path.hops) {
      const channel = byChannelId.get(hop.channelId);
      const state = current.get(hop.channelId);
      const forward = hop.fromNodeId === channel.from;
      const amount = BigInt(hop.amountMsat), asset = BigInt(path.assetAmount ?? '0');
      const local = forward ? 'from' : 'to', remote = forward ? 'to' : 'from';
      const localAsset = forward ? 'assetFrom' : 'assetTo', remoteAsset = forward ? 'assetTo' : 'assetFrom';
      assert(state[local] >= amount, `Insufficient synthetic BTC liquidity for ${transaction.id}`);
      assert(state[localAsset] >= asset, `Insufficient synthetic RGB liquidity for ${transaction.id}`);
      state[local] -= amount; state[remote] += amount;
      state[localAsset] -= asset; state[remoteAsset] += asset;
      assert.equal(state.from + state.to, BigInt(channel.capacitySat) * 1000n);
      assert.equal(state.assetFrom + state.assetTo, BigInt(channel.assetCapacity));
    }
  }
}
const transactions = [];
const histories = Object.fromEntries(nodeIds.map(id => [id, []]));
function addObservation(tx, path, pathIndex, direction) {
  const outgoing = direction === 'outgoing';
  const hop = outgoing ? path.hops[0] : path.hops.at(-1);
  const observer = outgoing ? tx.senderNodeId : tx.recipientNodeId;
  const peer = nodeById.get(outgoing ? hop.toNodeId : hop.fromNodeId);
  const notes = `${outgoing ? 'Uscita' : 'Entrata'} sintetica ${tx.assetId ? 'RGB' : 'BTC'}; parte ${pathIndex + 1}/${tx.paths.length}; ${tx.failureReason ?? 'regolata'}; nessun pagamento reale.`;
  histories[observer].push({ transactionId: tx.id, pathIndex, direction, episode: {
    id: `synthetic-ep-${String(transactions.length + 1).padStart(6, '0')}-${observer}-${direction}-${pathIndex}`,
    timestamp: tx.timestamp,
    eventType: tx.outcome === 'succeeded' ? 'payment_succeeded' : 'payment_failed',
    peerNodeId: peer.pubkey, peerAlias: peer.alias, channelId: hop.channelId,
    amountMsat: path.amountMsat, assetId: tx.assetId, assetAmount: path.assetAmount,
    routingAlgorithm: tx.routing.algorithm, outcome: tx.outcome, failureReason: tx.failureReason,
    outboundRatioPct: ratioAt(states, hop.channelId, observer),
    feeMsat: outgoing && tx.outcome === 'succeeded' ? path.plannedFeeMsat : 0,
    notes,
  } });
}
function createTransaction(index) {
  const pair = Math.floor(index / 2), reverse = index % 2 === 1;
  const mpp = pair % 20 === 0;
  const rgb = pair % 3 !== 1;
  let routes = mpp ? [routeCatalog[0], ['alice', 'carol', 'frank', 'ivan', 'judy']] : [routeCatalog[pair % routeCatalog.length]];
  if (reverse) routes = routes.map(route => [...route].reverse());
  const fails = pair >= 10 && [2, 7].includes(pair % 10);
  let failureReason = fails ? ['TemporaryChannelFailure', 'HTLCTimeout', 'InsufficientLiquidity', 'FeeBudgetExceeded'][(Math.floor(pair / 10) + (pair % 10 === 7 ? 1 : 0)) % 4] : null;
  const amount = failureReason === 'InsufficientLiquidity' ? 2000000000n : BigInt(10 + integer(`amount:${pair}`, 11)) * 1000000n;
  const assetAmount = rgb ? (mpp ? 20n : BigInt(1 + integer(`asset:${pair}`, 6))) : null;
  const paths = routes.map((route, i) => makePath(route, mpp ? amount * (i === 0 ? 6n : 4n) / 10n : amount,
    assetAmount === null ? null : mpp ? assetAmount * (i === 0 ? 6n : 4n) / 10n : assetAmount, !fails));
  const plannedFeeMsat = paths.reduce((sum, path) => sum + path.plannedFeeMsat, 0);
  if (failureReason === 'FeeBudgetExceeded' && plannedFeeMsat === 0) failureReason = 'TemporaryChannelFailure';
  const algorithm = algorithms[pair % algorithms.length];
  const routing = { algorithm,
    ...(algorithm === 'multi_objective' ? { weights: { fee: 100, reliability: 60, cltv: 10, hops: 10 } } : {}),
    max_fee_msat: failureReason === 'FeeBudgetExceeded' ? plannedFeeMsat - 1 : plannedFeeMsat + 1000,
    max_paths: paths.length };
  const tx = { id: `synthetic-tx-${String(index + 1).padStart(6, '0')}`, timestamp: start + index * 30 * 60 * 1000,
    senderNodeId: routes[0][0], recipientNodeId: routes[0].at(-1), amountMsat: String(amount),
    assetId: rgb ? assetId : null, assetAmount: assetAmount === null ? null : String(assetAmount), routing,
    outcome: fails ? 'failed' : 'succeeded', failureReason,
    failureChannelId: fails && failureReason !== 'FeeBudgetExceeded' ? paths[0].hops[integer(`fault:${pair}`, paths[0].hops.length)].channelId : null,
    totalFeeMsat: fails ? 0 : plannedFeeMsat,
    durationMs: failureReason === 'HTLCTimeout' ? 30000 : (fails ? 100 : 20) + integer(`duration:${index}`, 80), paths };
  for (const [pathIndex, path] of paths.entries()) {
    addObservation(tx, path, pathIndex, 'outgoing');
    // A failed attempt is not invented as a received payment at the destination.
    if (!fails) addObservation(tx, path, pathIndex, 'incoming');
  }
  apply(states, tx);
  transactions.push(tx);
}
function summarize(rows, nodeHistories) {
  const count = predicate => rows.filter(predicate).length;
  const entries = Object.values(nodeHistories).flat();
  return { transactionCount: rows.length, succeeded: count(tx => tx.outcome === 'succeeded'),
    failed: count(tx => tx.outcome === 'failed'), btc: count(tx => tx.assetId === null), rgb: count(tx => tx.assetId !== null),
    mpp: count(tx => tx.paths.length > 1), outgoingEpisodes: entries.filter(e => e.direction === 'outgoing').length,
    incomingEpisodes: entries.filter(e => e.direction === 'incoming').length,
    totalPaidFeeMsat: rows.reduce((sum, tx) => sum + tx.totalFeeMsat, 0),
    byNode: Object.fromEntries(nodes.map(node => [node.id, {
      outgoingTransactions: count(tx => tx.senderNodeId === node.id),
      incomingTransactions: count(tx => tx.recipientNodeId === node.id && tx.outcome === 'succeeded'),
      forwardedTransactions: count(tx => tx.outcome === 'succeeded' && tx.paths.some(path => path.nodes.slice(1, -1).includes(node.id))),
    }])) };
}
const episodeKeys = ['id', 'timestamp', 'eventType', 'peerNodeId', 'peerAlias', 'channelId', 'amountMsat', 'assetId', 'assetAmount', 'routingAlgorithm', 'outcome', 'failureReason', 'outboundRatioPct', 'feeMsat', 'notes'].sort();
const forbiddenKeys = new Set(['password', 'passphrase', 'mnemonic', 'seed', 'privatekey', 'secretkey', 'preimage', 'invoice', 'paymenthash', 'txid', 'email', 'phone', 'address', 'ip', 'hostname', 'token', 'authorization']);
function privacyCheck(value) {
  if (Array.isArray(value)) { value.forEach(privacyCheck); return; }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      assert(!forbiddenKeys.has(key.toLowerCase()), `Forbidden fixture field: ${key}`);
      privacyCheck(child);
    }
  } else if (typeof value === 'string') {
    assert(!/-----BEGIN |\blnbcrt[0-9a-z]+\b|\bbcrt1[0-9a-z]+\b|https?:\/\/|\b\d{1,3}(?:\.\d{1,3}){3}\b|[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(value), 'Unexpected credential, address or endpoint');
  }
}
function validate(dataset) {
  privacyCheck(dataset);
  assert.equal(dataset.transactions.length, dataset.summary.transactionCount);
  assert.deepEqual(summarize(dataset.transactions, dataset.nodeHistories), dataset.summary);
  const replay = new Map(initialChannelStates.map(state => [state.channelId, {
    from: BigInt(state.fromMsat), to: BigInt(state.toMsat), assetFrom: BigInt(state.fromAssetAmount), assetTo: BigInt(state.toAssetAmount),
  }]));
  const txIds = new Set();
  let expectedEpisodeCount = 0;
  for (const tx of dataset.transactions) {
    assert(!txIds.has(tx.id)); txIds.add(tx.id);
    assert(tx.id.startsWith('synthetic-tx-') && tx.timestamp < Date.parse(asOf));
    assert.equal(tx.paths.reduce((sum, path) => sum + BigInt(path.amountMsat), 0n), BigInt(tx.amountMsat));
    assert.equal(tx.paths.reduce((sum, path) => sum + BigInt(path.assetAmount ?? '0'), 0n), BigInt(tx.assetAmount ?? '0'));
    assert.equal(tx.paths.length, tx.routing.max_paths);
    for (const path of tx.paths) {
      assert.equal(path.nodes[0], tx.senderNodeId); assert.equal(path.nodes.at(-1), tx.recipientNodeId);
      assert.equal(new Set(path.nodes).size, path.nodes.length);
      assert(BigInt(path.amountMsat) >= 3000000n);
      let incoming = BigInt(path.amountMsat);
      let fee = 0;
      for (let i = path.hops.length - 1; i >= 0; i--) {
        const hop = path.hops[i];
        assert.equal(hop.fromNodeId, path.nodes[i]); assert.equal(hop.toNodeId, path.nodes[i + 1]);
        assert.equal(hop.channelId, byPair.get(`${path.nodes[i]}:${path.nodes[i + 1]}`).channelId);
        assert.equal(BigInt(hop.amountMsat), incoming);
        incoming += BigInt(hop.forwardingFeeMsat); fee += hop.forwardingFeeMsat;
      }
      assert.equal(fee, path.plannedFeeMsat);
      assert.equal(path.settled, tx.outcome === 'succeeded');
    }
    if (tx.outcome === 'succeeded') {
      assert.equal(tx.totalFeeMsat, tx.paths.reduce((sum, path) => sum + path.plannedFeeMsat, 0));
      assert(tx.totalFeeMsat <= tx.routing.max_fee_msat);
    } else {
      assert(tx.failureReason && tx.totalFeeMsat === 0);
      if (tx.failureReason === 'FeeBudgetExceeded') assert(tx.paths.reduce((sum, path) => sum + path.plannedFeeMsat, 0) > tx.routing.max_fee_msat);
      if (tx.failureReason === 'InsufficientLiquidity') assert(tx.paths.some(path => path.hops.some(hop => {
        const channel = byChannelId.get(hop.channelId), state = replay.get(hop.channelId);
        return BigInt(hop.amountMsat) > (hop.fromNodeId === channel.from ? state.from : state.to);
      })));
    }
    expectedEpisodeCount += tx.paths.length * (tx.outcome === 'succeeded' ? 2 : 1);
    apply(replay, tx);
  }
  assert.deepEqual(stateRows(replay), dataset.finalChannelStates);
  assert.equal(Object.values(dataset.nodeHistories).flat().length, expectedEpisodeCount);
  for (const [nodeId, entries] of Object.entries(dataset.nodeHistories)) {
    assert(entries.some(entry => entry.direction === 'incoming') && entries.some(entry => entry.direction === 'outgoing'));
    for (const entry of entries) {
      const tx = dataset.transactions[Number(entry.transactionId.slice(-6)) - 1], ep = entry.episode;
      assert(tx && tx.id === entry.transactionId);
      assert.deepEqual(Object.keys(ep).sort(), episodeKeys);
      const outgoing = entry.direction === 'outgoing', path = tx.paths[entry.pathIndex];
      const hop = outgoing ? path.hops[0] : path.hops.at(-1);
      assert.equal(outgoing ? tx.senderNodeId : tx.recipientNodeId, nodeId);
      assert.equal(ep.peerNodeId, nodeById.get(outgoing ? hop.toNodeId : hop.fromNodeId).pubkey);
      assert.equal(ep.peerAlias, nodeById.get(outgoing ? hop.toNodeId : hop.fromNodeId).alias);
      assert.equal(ep.channelId, hop.channelId); assert.equal(ep.timestamp, tx.timestamp);
      assert.equal(ep.amountMsat, path.amountMsat); assert.equal(ep.assetAmount, path.assetAmount);
      assert.equal(ep.assetId, tx.assetId); assert.equal(ep.outcome, tx.outcome);
      assert.equal(ep.routingAlgorithm, tx.routing.algorithm);
      assert(Number.isInteger(ep.outboundRatioPct) && ep.outboundRatioPct >= 0 && ep.outboundRatioPct <= 100);
      assert(!ep.notes.includes('\n'));
      if (!outgoing) assert.equal(ep.outcome, 'succeeded');
    }
  }
}
async function artifact(filename, value) {
  const text = JSON.stringify(value, null, 2) + '\n';
  const path = join(output, filename);
  if (check) assert.equal(await readFile(path, 'utf8'), text, `Generated artifact differs: ${filename}`);
  else await writeFile(path, text);
  return { filename, sha256: digest(text), bytes: Buffer.byteLength(text) };
}
if (!check) await mkdir(output, { recursive: true });
const manifest = { schemaVersion: 1, synthetic: true, generator, sourceTopologySha256: digest(source),
  cumulative: true, privacyReview: 'passed_synthetic_provenance_and_field_checks', datasets: [] };
let previous = null;
for (let index = 0; index < levels.at(-1); index++) {
  createTransaction(index);
  const count = index + 1;
  if (!levels.includes(count)) continue;
  const dataset = structuredClone({ schemaVersion: 1, synthetic: true, datasetId: `synthetic-routing-history-${String(count).padStart(4, '0')}`,
    provenance: { generator, generationLabel: label, sourceTopology: 'topology.json', sourceTopologySha256: digest(source),
      implementationReference: 'docs/qvac/features-1-and-2-implementation.md', asOf },
    semantics: {
      scope: 'Offline synthetic historical observations; no live wallet or transaction log was read.',
      balances: 'Historical state is independent from topology.json startup balances. RGB starts equally split, BTC uses declared directional ratios; successful transfers are replayed with exact fee accounting.',
      reverseFees: 'Synthetic historical assumption: reverse base fee equals the declared forward base fee; both proportional fees are zero.',
      directions: 'nodeHistories holds endpoint incoming/outgoing observations. Forwarding nodes and actual per-hop amounts are in transaction paths.',
      episodes: 'Each entry.episode exactly matches TelemetryEpisode. MPP produces one observation per part. Failed attempts produce outgoing observations only.',
      identifiers: 'Aliases are fictional topology labels. Pubkeys are constructed valid curve points with no private key created; channel and asset identifiers are synthetic. Rebind identifiers for live-node tests.',
    },
    privacyReview: { source: 'synthetic_only', usesRealWalletData: false, usesRealNodeIdentities: false,
      checks: ['topology_structural_allowlist', 'no_secrets_or_identifying_contact_fields', 'no_network_addresses_or_live_invoices', 'all_history_values_generated_deterministically'] },
    topology: { name: topology.name, network: 'regtest', nodes, channels },
    knownNodes: nodes.map(({ alias, pubkey }) => ({ alias, pubkey })),
    initialChannelStates, finalChannelStates: stateRows(states), currentChannelsByNode: liveChannels(states),
    summary: summarize(transactions, histories), transactions, nodeHistories: histories });
  validate(dataset);
  if (previous) {
    assert.deepEqual(dataset.transactions.slice(0, previous.transactions.length), previous.transactions);
    for (const id of nodeIds) assert.deepEqual(dataset.nodeHistories[id].slice(0, previous.nodeHistories[id].length), previous.nodeHistories[id]);
  }
  const filename = `history-${String(count).padStart(4, '0')}.json`;
  const info = await artifact(filename, dataset);
  manifest.datasets.push({ ...info, transactionCount: count, succeeded: dataset.summary.succeeded,
    failed: dataset.summary.failed, incomingEpisodes: dataset.summary.incomingEpisodes, outgoingEpisodes: dataset.summary.outgoingEpisodes });
  console.log(`${check ? 'Verified' : 'Created'} ${filename}: ${count} transactions, ${dataset.summary.succeeded} succeeded, ${dataset.summary.failed} failed`);
  previous = dataset;
}
await artifact('manifest.json', manifest);
console.log('Validated topology references, cumulative prefixes, two-way histories, TelemetryEpisode fields, channel balance replay, fees and synthetic-data privacy checks.');
