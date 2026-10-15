import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WdkWallet } from '../../apps/local-service/wallet.ts';
import { PaymentStore } from '../../apps/local-service/payments.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = resolve(process.env.AIRGB_E2E_DATA_DIR ?? join(root, 'native-data/e2e'));
await mkdir(directory, { recursive: true, mode: 0o700 });
const secretFile = join(directory, 'test-passwords.json');
let secrets;
try { secrets = JSON.parse(await readFile(secretFile, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  secrets = { a: randomBytes(32).toString('hex'), b: randomBytes(32).toString('hex') };
  await writeFile(secretFile, JSON.stringify(secrets), { mode: 0o600, flag: 'wx' });
}
const rpc = async (method, params = [], wallet = '') => {
  const auth = Buffer.from(`${process.env.BITCOIND_RPC_USER}:${process.env.BITCOIND_RPC_PASSWORD}`).toString('base64');
  const response = await fetch(`http://127.0.0.1:${process.env.BITCOIND_RPC_PORT ?? 18443}${wallet ? `/wallet/${wallet}` : ''}`, {
    method: 'POST', headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'airgb-e2e', method, params }),
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(`Bitcoin RPC ${method}: ${data.error?.message ?? response.status}`);
  return data.result;
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const openWallet = async (name, port) => {
  process.env.AIRGB_LDK_PEER_PORT = String(port);
  const wallet = new WdkWallet(join(directory, name));
  if (!(await wallet.vault.exists())) await wallet.create(secrets[name]);
  await wallet.unlock(secrets[name]);
  return wallet;
};
let a, b, payments;
const report = { network: 'regtest', btc: 'not_started', rgb: 'not_started', blocked: 'not_started' };
try {
  a = await openWallet('a', Number(process.env.AIRGB_E2E_PORT_A ?? 9745));
  b = await openWallet('b', Number(process.env.AIRGB_E2E_PORT_B ?? 9746));
  const aInfo = await a.summary();
  const bInfo = await b.summary();
  process.stdout.write(JSON.stringify({ step: 'nodes_ready', aPeer: aInfo.peerUri, bPeer: bInfo.peerUri, rssMiB: Math.round(process.memoryUsage().rss / 1048576) }) + '\n');
  await a.connectPeer(bInfo.peerUri);
  process.stdout.write(JSON.stringify({ step: 'peer_connected', peerCount: (await a.peers()).length }) + '\n');
  payments = new PaymentStore(join(directory, 'a'), a);
  const existing = payments.list();
  const reconciled = await Promise.all(existing.map(item => payments.reconcile(item.id)));
  const nonterminal = reconciled.filter(item => !['succeeded', 'failed'].includes(item.status));
  if (nonterminal.length) {
    report.btc = 'pending_existing';
    const observations = [];
    for (const item of nonterminal) {
      const native = await a.paymentStatus(item.paymentHash);
      observations.push({ id: item.id, senderStatus: native.status, failureCode: native.failure_code ?? null, receiverStatus: await b.invoiceStatus(item.invoice) });
    }
    process.stdout.write(JSON.stringify({ step: 'btc_existing_pending', observations }) + '\n');
    throw new Error('Pagamenti precedenti non terminali: verificare il nodo, senza inviare una nuova invoice');
  }

  const fund = async (address, targetSat) => {
    await a.sync(); await b.sync();
    const balance = address === aInfo.address ? BigInt((await a.summary()).btcSpendableSat) : BigInt((await b.summary()).btcSpendableSat);
    if (balance >= BigInt(targetSat)) return;
    await rpc('sendtoaddress', [address, 0.02], 'miner');
    const mineTo = await rpc('getnewaddress', [], 'miner');
    await rpc('generatetoaddress', [1, mineTo]);
    for (let i = 0; i < 20; i++) {
      await pause(1000);
      await a.sync(); await b.sync();
      const current = address === aInfo.address ? BigInt((await a.summary()).btcSpendableSat) : BigInt((await b.summary()).btcSpendableSat);
      if (current >= BigInt(targetSat)) return;
    }
    throw new Error('Finanziamento non visibile al nodo');
  };
  await fund(aInfo.address, 300000);
  await fund(bInfo.address, 100000);
  process.stdout.write(JSON.stringify({ step: 'funded', aSat: (await a.summary()).btcSpendableSat, bSat: (await b.summary()).btcSpendableSat }) + '\n');

  if (!(await a.channels()).some(channel => channel.public === true)) {
    const opened = await a.openChannel({ peer: bInfo.peerUri, capacitySat: '200000', public: true });
    process.stdout.write(JSON.stringify({ step: 'channel_open_requested', response: opened }) + '\n');
  }
  let fundingTxid = null;
  for (let i = 0; i < 20; i++) {
    const channels = await a.account.listChannels();
    fundingTxid = channels.find(channel => channel.public === true)?.funding_txid ?? null;
    if (fundingTxid) break;
    await pause(1000);
  }
  if (!fundingTxid) throw new Error('Funding txid del canale pubblico non disponibile');
  for (let i = 0; i < 20; i++) {
    try { await rpc('getmempoolentry', [fundingTxid]); break; }
    catch { await pause(1000); }
  }
  const mineTo = await rpc('getnewaddress', [], 'miner');
  await rpc('generatetoaddress', [6, mineTo]);
  let usable = false;
  for (let i = 0; i < 40; i++) {
    await pause(1500);
    await a.sync(); await b.sync();
    const channels = await a.channels();
    if (channels.some(channel => channel.public === true && channel.isUsable === true)) { usable = true; break; }
  }
  process.stdout.write(JSON.stringify({ step: 'channel_state', a: await a.channels(), b: await b.channels() }) + '\n');
  if (!usable) {
    process.stdout.write(JSON.stringify({ step: 'channel_diagnostic', a: await a.account.listChannels(), b: await b.account.listChannels(), blockCount: await rpc('getblockcount') }) + '\n');
    throw new Error('Canale non utilizzabile entro 60 secondi');
  }

  const blockedInvoice = await b.createLightningInvoice({ amountMsat: '5000000', expirySec: 3600 });
  try { await payments.prepare({ id: randomUUID(), invoice: blockedInvoice.invoice, constraints: { feeLimitMsat: '0' } }); }
  catch (error) { if (error.code === 'CONSTRAINT_UNSUPPORTED') report.blocked = 'passed'; else throw error; }
  if (report.blocked !== 'passed') throw new Error('Vincolo non supportato non bloccato');
  process.stdout.write(JSON.stringify({ step: 'constraint_gate', status: report.blocked }) + '\n');

  const invoice = await b.createLightningInvoice({ amountMsat: '5000000', expirySec: 3600 });
  const id = randomUUID();
  const prepared = await payments.prepare({ id, invoice: invoice.invoice, constraints: {} });
  process.env.ENABLE_REGTEST_SEND = '1';
  let sent = await payments.confirm(prepared.id);
  for (let i = 0; i < 30 && !['succeeded', 'failed'].includes(sent.status); i++) {
    await pause(1000);
    sent = await payments.reconcile(prepared.id);
  }
  report.btc = sent.status;
  const native = await a.paymentStatus(prepared.paymentHash);
  let receiver = await b.invoiceStatus(invoice.invoice);
  for (let i = 0; sent.status === 'succeeded' && receiver.status === 'Pending' && i < 10; i++) {
    await pause(500);
    receiver = await b.invoiceStatus(invoice.invoice);
  }
  process.stdout.write(JSON.stringify({ step: 'btc_payment', intentId: id, status: sent.status, receiverStatus: receiver, failureCode: native.failure_code ?? null, feePaidMsat: native.fee_paid_msat ?? null }) + '\n');
  if (sent.status !== 'succeeded' || receiver.status !== 'Succeeded') throw new Error(`Pagamento BTC non terminale positivo sui due nodi: ${sent.status}/${receiver.status}`);

} finally {
  process.stdout.write(JSON.stringify({ step: 'report', ...report }) + '\n');
  process.stdout.write(JSON.stringify({ step: 'process_memory', nodes: 2, rssMiB: Math.round(process.memoryUsage().rss / 1048576), peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024) }) + '\n');
  payments?.close();
  await Promise.allSettled([a?.shutdown(), b?.shutdown()]);
}
