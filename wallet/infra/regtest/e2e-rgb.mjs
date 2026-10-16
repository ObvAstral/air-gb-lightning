import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { generateMnemonic } from 'bip39';
import WalletManagerRgb from '@utexo/wdk-wallet-rgb';
import { RgbWallet } from '../../apps/local-service/wallet.ts';
import { PaymentStore } from '../../apps/local-service/payments.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = resolve(process.env.AIRGB_E2E_RGB_DATA_DIR ?? join(root, 'native-data/e2e-rgb'));
await mkdir(directory, { recursive: true, mode: 0o700 });
const secretFile = join(directory, 'test-passwords.json');
let secrets;
try { secrets = JSON.parse(await readFile(secretFile, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  secrets = { a: randomBytes(32).toString('hex'), b: randomBytes(32).toString('hex') };
  await writeFile(secretFile, JSON.stringify(secrets), { mode: 0o600, flag: 'wx' });
}
const issuerMnemonic = generateMnemonic(128);
const tickerAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const ticker = `T${Array.from(randomBytes(4), byte => tickerAlphabet[byte % tickerAlphabet.length]).join('')}`;
const rpc = async (method, params = [], wallet = '') => {
  const auth = Buffer.from(`${process.env.BITCOIND_RPC_USER}:${process.env.BITCOIND_RPC_PASSWORD}`).toString('base64');
  const response = await fetch(`http://127.0.0.1:${process.env.BITCOIND_RPC_PORT ?? 18443}${wallet ? `/wallet/${wallet}` : ''}`, {
    method: 'POST', headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'airgb-e2e-rgb', method, params }),
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(`Bitcoin RPC ${method}: ${data.error?.message ?? response.status}`);
  return data.result;
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const mine = async blocks => {
  const mineTo = await rpc('getnewaddress', [], 'miner');
  await rpc('generatetoaddress', [blocks, mineTo], 'miner');
};
const assetIdOf = issued => {
  const record = issued && typeof issued === 'object' ? issued : {};
  const nested = record.asset && typeof record.asset === 'object' ? record.asset : {};
  return record.assetId ?? record.asset_id ?? nested.asset_id ?? nested.assetId ?? null;
};
const openWallet = async (name, port) => {
  process.env.AIRGB_LDK_PEER_PORT = String(port);
  process.env.AIRGB_ANNOUNCE_HOST = '127.0.0.1';
  const wallet = new RgbWallet(join(directory, name));
  if (!(await wallet.vault.exists())) await wallet.create(secrets[name]);
  await wallet.unlock(secrets[name]);
  return wallet;
};
let a, b, payments, issuerManager;
const report = { network: 'regtest', rgb: 'not_started', assetId: null };
try {
  a = await openWallet('a', Number(process.env.AIRGB_E2E_RGB_PORT_A ?? 9755));
  b = await openWallet('b', Number(process.env.AIRGB_E2E_RGB_PORT_B ?? 9756));
  const aInfo = await a.summary();
  const bInfo = await b.summary();
  process.stdout.write(JSON.stringify({ step: 'nodes_ready', aPeer: aInfo.peerUri, bPeer: bInfo.peerUri }) + '\n');
  await a.connectPeer(bInfo.peerUri);

  const fund = async (address, targetSat) => {
    await a.sync(); await b.sync();
    const currentOf = async () => BigInt((await (address === aInfo.address ? a : b).summary()).btcSpendableSat);
    if (await currentOf() >= BigInt(targetSat)) return;
    await rpc('sendtoaddress', [address, 0.02], 'miner');
    await mine(1);
    for (let attempt = 0; attempt < 20; attempt++) {
      await pause(1000);
      await a.sync(); await b.sync();
      if (await currentOf() >= BigInt(targetSat)) return;
    }
    throw new Error('Finanziamento non visibile al nodo');
  };
  await fund(aInfo.address, 1500000);
  await fund(bInfo.address, 200000);
  process.stdout.write(JSON.stringify({ step: 'funded', aSat: (await a.summary()).btcSpendableSat }) + '\n');

  await a.prepareRgbUtxos({ count: 4, sizeSat: '200000', feeRateSatPerVbyte: '2' });
  await mine(1);
  await a.sync();

  const indexerUrl = process.env.INDEXER_URL;
  const transportEndpoint = process.env.RGB_PROXY_ENDPOINT;
  if (!indexerUrl || !transportEndpoint) throw new Error('INDEXER_URL e RGB_PROXY_ENDPOINT richiesti');
  const issuerDir = join(directory, `issuer-${randomBytes(4).toString('hex')}`);
  issuerManager = new WalletManagerRgb(issuerMnemonic, {
    network: 'regtest',
    dataDir: issuerDir,
    indexerUrl,
    transportEndpoint,
  });
  const issuer = await issuerManager.getAccount(0);
  const registered = await issuer.registerWallet();
  const issuerAddress = registered.address ?? issuer.getAddress();
  if (await issuer.getBalance() < 200000n) {
    await rpc('sendtoaddress', [issuerAddress, 0.02], 'miner');
    await mine(1);
    let fundedIssuer = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      await pause(1000);
      issuer.syncWallet();
      if (await issuer.getBalance() >= 200000n) { fundedIssuer = true; break; }
    }
    if (!fundedIssuer) throw new Error('Finanziamento emittente non visibile');
  }
  try {
    await issuer.createUtxos({ upTo: true, num: 4, size: 10000, feeRate: 2 });
  } catch (error) {
    if (!String(error.message ?? error).includes('Allocations already available')) throw error;
  }
  await mine(1);
  issuer.syncWallet();
  const issuedRaw = await issuer.issueAssetNia({ ticker, name: 'Regtest NIA', amounts: [1000], precision: 0 });
  const assetId = assetIdOf(issuedRaw);
  if (typeof assetId !== 'string' || !assetId.startsWith('rgb:')) throw new Error(`Emissione NIA senza contract id: ${JSON.stringify(issuedRaw)}`);
  report.assetId = assetId;
  await mine(1);
  issuer.syncWallet();
  const sendRgb = async (invoice, amount) => {
    const psbt = issuer.sendBegin({ invoice, assetId, amount, feeRate: 2, minConfirmations: 1 });
    const signedPsbt = await issuer.signPsbt(psbt);
    const result = issuer.sendEnd({ signedPsbt });
    const txid = result?.txid;
    if (typeof txid !== 'string') throw new Error(`Invio RGB senza txid: ${JSON.stringify(result)}`);
    let inMempool = true;
    try { await rpc('getmempoolentry', [txid]); }
    catch { inMempool = false; }
    if (!inMempool) {
      const finalized = await rpc('finalizepsbt', [signedPsbt]);
      if (!finalized.complete) throw new Error(`PSBT non finalizzata per ${txid}`);
      await rpc('sendrawtransaction', [finalized.hex]);
    }
    return txid;
  };
  const aliceReceive = await a.createRgbInvoice({ assetId: null, amount: null, expirySec: 3600 });
  const delivered = await sendRgb(aliceReceive.invoice, 800);
  process.stdout.write(JSON.stringify({ step: 'onchain_transfer', assetId, txid: delivered }) + '\n');
  for (let attempt = 0; attempt < 12; attempt++) {
    let inMempool = true;
    try { await rpc('getmempoolentry', [delivered]); }
    catch { inMempool = false; }
    if (!inMempool) break;
    await mine(1);
    await pause(1000);
    if (attempt === 11) throw new Error(`Trasferimento ${delivered} ancora in mempool`);
  }
  let spendable = null;
  for (let attempt = 0; attempt < 45; attempt++) {
    await pause(2000);
    await a.refresh();
    try {
      const balance = await a.assetBalance(assetId);
      spendable = balance.spendable;
      if (spendable && BigInt(spendable) > 0n) break;
    } catch { /* The contract is not in Alice's stash yet. */ }
  }
  if (!spendable || BigInt(spendable) <= 0n) throw new Error('Alice non ha ricevuto il NIA');
  process.stdout.write(JSON.stringify({ step: 'issued', assetId, spendable }) + '\n');

  payments = new PaymentStore(join(directory, 'a'), a);
  const opened = await a.openChannel({ peer: bInfo.peerUri, capacitySat: '200000', public: true, assetId, assetAmount: '100' });
  process.stdout.write(JSON.stringify({ step: 'channel_open_requested', response: opened }) + '\n');
  let fundingTxid = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    const channels = await a.account.listChannels();
    fundingTxid = channels.find(channel => channel.asset_id === assetId)?.funding_txid ?? null;
    if (fundingTxid) break;
    await pause(1000);
  }
  if (!fundingTxid) throw new Error('Funding txid del canale RGB non disponibile');
  for (let attempt = 0; attempt < 20; attempt++) {
    try { await rpc('getmempoolentry', [fundingTxid]); break; }
    catch { await pause(1000); }
  }
  await mine(6);
  let usable = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    await pause(1500);
    await a.sync(); await b.sync();
    const channels = await a.channels();
    if (channels.some(channel => channel.assetId === assetId && channel.isUsable === true)) { usable = true; break; }
  }
  if (!usable) {
    process.stdout.write(JSON.stringify({ step: 'channel_diagnostic', a: await a.account.listChannels(), b: await b.account.listChannels() }) + '\n');
    throw new Error('Canale RGB non utilizzabile entro 60 secondi');
  }

  const createBobInvoice = () => b.createLightningInvoice({ amountMsat: '3000000', expirySec: 3600, assetId, assetAmount: '10' });
  let invoice;
  try { invoice = await createBobInvoice(); }
  catch (error) {
    process.stdout.write(JSON.stringify({ step: 'bob_contract_missing', message: error.message }) + '\n');
    const bobReceive = await b.createRgbInvoice({ assetId: null, amount: null, expirySec: 3600 });
    const bobTx = await sendRgb(bobReceive.invoice, 10);
    await mine(1);
    for (let attempt = 0; attempt < 20 && !invoice; attempt++) {
      await pause(1000);
      await b.refresh();
      try { invoice = await createBobInvoice(); }
      catch { /* Bob still does not know the contract. */ }
    }
  }
  if (!invoice) throw new Error('Bob non riesce a creare l\'invoice RGB Lightning');
  const prepared = await payments.prepare({ id: randomUUID(), invoice: invoice.invoice, constraints: {}, routing: { algorithm: 'ldk_dijkstra' } });
  process.env.ENABLE_REGTEST_SEND = '1';
  let sent = await payments.confirm(prepared.id);
  for (let attempt = 0; attempt < 30 && !['succeeded', 'failed'].includes(sent.status); attempt++) {
    await pause(1000);
    sent = await payments.reconcile(prepared.id);
  }
  const native = await a.paymentStatus(prepared.paymentHash);
  let receiver = await b.invoiceStatus(invoice.invoice);
  for (let attempt = 0; sent.status === 'succeeded' && receiver.status === 'Pending' && attempt < 10; attempt++) {
    await pause(500);
    receiver = await b.invoiceStatus(invoice.invoice);
  }
  let channel;
  for (let attempt = 0; attempt < 30; attempt++) {
    channel = (await a.channels()).find(item => item.assetId === assetId);
    if (channel?.assetLocalAmount === '90' || sent.status !== 'succeeded') break;
    await pause(1000);
  }
  report.rgb = sent.status;
  process.stdout.write(JSON.stringify({ step: 'rgb_payment', status: sent.status, receiverStatus: receiver, failureCode: native.failure_code ?? null, assetLocalAmount: channel?.assetLocalAmount ?? null }) + '\n');
  if (sent.status !== 'succeeded' || receiver.status !== 'Succeeded') throw new Error(`Pagamento RGB non riuscito: ${sent.status}/${receiver.status}`);
  if (native.asset_id !== assetId) throw new Error('Il pagamento nativo non riporta l\'asset emesso');
  if (channel?.assetLocalAmount !== '90') throw new Error(`Saldo RGB locale dopo il pagamento inatteso: ${channel?.assetLocalAmount ?? 'assente'}, atteso 90`);
} finally {
  process.stdout.write(JSON.stringify({ step: 'report', ...report }) + '\n');
  payments?.close();
  try { issuerManager?.dispose(); } catch { /* Cleanup must not hide the payment result. */ }
  await Promise.allSettled([a?.shutdown(), b?.shutdown()]);
}
