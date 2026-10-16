import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RgbWallet } from '../../apps/local-service/wallet.ts';
import { PaymentStore } from '../../apps/local-service/payments.ts';

// A diamond with RGB liquidity of 60 + 40. Neither route can carry 100 alone:
// settlement and the eight final balances prove both routes were used.
const root = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(join(root, 'native-data'), { recursive: true });
const directory = await mkdtemp(join(root, 'native-data/e2e-mpp-'));
const secrets = Object.fromEntries(['alice', 'bob', 'carol', 'dave'].map(name => [name, randomBytes(32).toString('hex')]));
await writeFile(join(directory, 'passwords.json'), JSON.stringify(secrets), { mode: 0o600 });
const nodes = new Map();
let payments;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = (step, data = {}) => process.stdout.write(JSON.stringify({ step, ...data }) + '\n');
async function until(description, check, attempts = 90) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await check()) return;
    await pause(1000);
  }
  throw new Error(`Timeout: ${description}; dati conservati in ${directory}`);
}
async function rpc(method, params = [], wallet = '') {
  const host = process.env.BITCOIND_RPC_HOST ?? '127.0.0.1';
  const port = process.env.BITCOIND_RPC_PORT ?? '18443';
  const response = await fetch(`http://${host}:${port}${wallet ? `/wallet/${wallet}` : ''}`, {
    method: 'POST', headers: { authorization: `Basic ${Buffer.from(`${process.env.BITCOIND_RPC_USER}:${process.env.BITCOIND_RPC_PASSWORD}`).toString('base64')}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'airgb-mpp', method, params }), signal: AbortSignal.timeout(10000),
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(`RPC ${method}: ${data.error?.message ?? response.status}`);
  return data.result;
}
async function mine(blocks) {
  await rpc('generatetoaddress', [blocks, await rpc('getnewaddress', [], 'miner')], 'miner');
}
try {
  log('start', { directory });
  for (const [index, name] of ['alice', 'bob', 'carol', 'dave'].entries()) {
    process.env.AIRGB_LDK_PEER_PORT = String(9765 + index);
    process.env.AIRGB_ANNOUNCE_HOST = '127.0.0.1';
    const wallet = new RgbWallet(join(directory, name));
    nodes.set(name, wallet);
    await wallet.create(secrets[name]);
    await wallet.unlock(secrets[name]);
    await rpc('sendtoaddress', [(await wallet.summary()).address, 0.1], 'miner');
  }
  await mine(6);
  for (const wallet of nodes.values()) {
    await until('finanziamento BTC', async () => { await wallet.sync(); return BigInt((await wallet.summary()).btcSpendableSat) >= 5_000_000n; });
    await wallet.prepareRgbUtxos({ count: 4, sizeSat: '1000000', feeRateSatPerVbyte: '2' });
  }
  await mine(6);
  const alice = nodes.get('alice'), bob = nodes.get('bob'), carol = nodes.get('carol'), dave = nodes.get('dave');
  for (const wallet of nodes.values()) await wallet.refresh();
  const { assetId } = await alice.issueNia({ ticker: 'MPPTEST', name: 'MPP regtest', precision: 0, amounts: [1000] });
  log('asset_issued', { assetId });
  for (const receiver of [bob, carol]) {
    const { invoice } = await receiver.createRgbInvoice({ assetId: null, amount: null, expirySec: 3600 });
    const decoded = await alice.account.decodeRgbInvoice(invoice);
    const transfer = await alice.account.sendRgb({ donation: false, fee_rate: 2, min_confirmations: 1, expiration_timestamp: Math.floor(Date.now() / 1000) + 3600,
      recipient_map: { [assetId]: [{ recipient_id: decoded.recipient_id, assignment: { type: 'Fungible', value: 300 }, transport_endpoints: decoded.transport_endpoints }] },
    });
    await until('ACK trasferimento RGB', async () => {
      await receiver.refresh(); await alice.refresh();
      try { await rpc('getmempoolentry', [transfer.txid]); return true; } catch { return false; }
    });
    await mine(6);
    await until('trasferimento RGB confermato', async () => {
      await receiver.refresh(); await alice.refresh();
      return BigInt((await receiver.assetBalance(assetId)).spendable ?? '0') >= 300n;
    });
  }
  const edges = [[alice, bob, 60], [alice, carol, 40], [bob, dave, 60], [carol, dave, 40]];
  log('asset_distributed', { intermediaries: 2, amountEach: 300 });
  const channels = [];
  for (const [sender, receiver, amount] of edges) {
    await sender.refresh();
    const peer = (await receiver.summary()).peerUri;
    const peerNodeId = (await receiver.summary()).nodeId;
    await sender.connectPeer(peer);
    await sender.openChannel({ peer, capacitySat: '1000000', public: true, assetId, assetAmount: String(amount) });
    let channel;
    await until('funding canale RGB', async () => {
      channel = (await sender.channels()).find(row => row.peerNodeId === peerNodeId && row.assetId === assetId && row.fundingTxid);
      if (!channel) return false;
      try { await rpc('getmempoolentry', [channel.fundingTxid]); return true; } catch { return false; }
    });
    channels.push({ sender, receiver, amount, id: channel.channelId });
    await mine(6);
    await until('canale RGB utilizzabile', async () => (await sender.channels()).some(row => row.channelId === channel.channelId && row.isUsable));
    log('channel_ready', { channelId: channel.channelId, rgbCapacity: amount });
  }
  await until('gossip dei quattro canali', async () => Number((await alice.summary()).nodeInfo.network_channels) >= 4);
  const invoice = await dave.createLightningInvoice({ amountMsat: '10000000', expirySec: 3600, assetId, assetAmount: '100' });
  const decoded = await alice.decodeLightning(invoice.invoice);
  assert.equal(decoded.assetAmount, '100');
  payments = new PaymentStore(alice.dataDir, alice);
  const intent = await payments.prepare({ id: randomUUID(), invoice: invoice.invoice, routing: { algorithm: 'ldk_dijkstra' } });
  process.env.ENABLE_REGTEST_SEND = '1';
  await payments.confirm(intent.id);
  await until('pagamento MPP', async () => {
    const state = await payments.reconcile(intent.id);
    if (state.status === 'failed') throw new Error('Pagamento MPP fallito');
    return state.status === 'succeeded';
  });
  await until('ricezione MPP', async () => (await dave.invoiceStatus(invoice.invoice)).status === 'Succeeded');
  const native = await alice.paymentStatus(intent.paymentHash);
  assert.equal(native.asset_id, assetId);
  assert.equal(native.asset_amount, 100);
  for (const { sender, receiver, amount, id } of channels) {
    await until('saldi RGB dopo MPP', async () => {
      const outgoing = (await sender.channels()).find(row => row.channelId === id);
      const incoming = (await receiver.channels()).find(row => row.channelId === id);
      return outgoing?.assetLocalAmount === '0' && outgoing?.assetRemoteAmount === String(amount)
        && incoming?.assetLocalAmount === String(amount) && incoming?.assetRemoteAmount === '0';
    });
  }
  log('rgb_mpp_passed', { assetId, amount: 100, routes: [60, 40], paymentHash: intent.paymentHash, channels: 4 });
} finally {
  payments?.close();
  const results = await Promise.allSettled([...nodes.values()].map(wallet => wallet.shutdown()));
  for (const result of results) if (result.status === 'rejected') { process.exitCode = 1; console.error(result.reason); }
  log('state_preserved', { directory });
}
