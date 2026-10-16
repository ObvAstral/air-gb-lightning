import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { VaultStore } from '../../apps/local-service/vault.ts';
import { ROUTING_ALGORITHMS } from '../../packages/contracts/types.ts';

const walletRoot = fileURLToPath(new URL('../../', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const issuerDir = join(walletRoot, 'native-data/regtest/issuer');
const nodeVersion = '24.19.0';
const origin = 'http://127.0.0.1:5173';
const nodes = { alice: 'http://127.0.0.1:8787', bob: 'http://127.0.0.1:8788' };
const tickerPattern = /^[A-Z][A-Z0-9]{1,7}$/;
const passwords = new Map();
const sessions = new Map();

class CliError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const other = name => name === 'alice' ? 'bob' : 'alice';
const passwordEnv = name => name === 'alice' ? 'AIRGB_ALICE_PASSWORD' : name === 'bob' ? 'AIRGB_BOB_PASSWORD' : 'AIRGB_ISSUER_PASSWORD';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const line = (label, value) => console.log(`${label.padEnd(12)}${value ?? ''}`);

function help() {
  console.log(`Uso (da wallet/): npm run cli -- <comando>

  status [alice|bob|issuer|all]
  create <alice|bob>
  unlock <alice|bob>
  sync <alice|bob|issuer>
  fund <alice|bob|issuer> <btc>
  mine [blocchi]
  utxos <alice|bob|issuer> [--count N --size sat --fee sat/vB]
  issue <alice|bob> --ticker TICK --name Nome --amount <unità> [--precision 0]
  connect <alice|bob> [--peer pubkey@host:porta]
  channel <alice|bob> --capacity <sat> --asset <rgb:...> --amount <unità> [--peer ...]
  invoice <alice|bob> --asset <rgb:...> --amount <unità> [--msat 3000000] [--expiry 3600]
  pay <alice|bob> --invoice <lnbcrt...> --algorithm <ldk_dijkstra|yen|min_cost_flow|multi_objective>
    multi_objective richiede --weights '{"fee":1,"reliability":2,"cltv":1,"hops":10}'
  issuer create
  issuer status|sync|fund|utxos
  issuer fund <btc>
  issuer issue --ticker TICK --name Nome --amount <unità> [--precision 0]
  send --from issuer --to <alice|bob> --asset <rgb:...> --amount <unità>
  send --from issuer --invoice <rgb:...> --asset <rgb:...> --amount <unità> [--to alice|bob]

Password da AIRGB_ALICE_PASSWORD, AIRGB_BOB_PASSWORD, AIRGB_ISSUER_PASSWORD, oppure dal prompt.
L'emittente on-chain richiede Node ${nodeVersion}.`);
}

function wholeInt(value, name, pattern, hint) {
  if (!pattern.test(value ?? '')) throw new CliError('INVALID_AMOUNT', hint);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new CliError('INVALID_AMOUNT', `${name} troppo grande`);
  return parsed;
}
function positiveInt(value, name) { return wholeInt(value, name, /^[1-9][0-9]*$/, `${name} deve essere un intero positivo`); }
function nonNegativeInt(value, name) { return wholeInt(value, name, /^(?:0|[1-9][0-9]*)$/, `${name} deve essere un intero da 0 in su`); }

function btcAmount(value) {
  if (!/^(?:0\.\d{1,8}|[1-9]\d*(?:\.\d{1,8})?)$/.test(value ?? '')) throw new CliError('INVALID_AMOUNT', 'Importo BTC non valido');
  return value;
}

function nodeName(value) {
  if (value !== 'alice' && value !== 'bob') throw new CliError('USAGE', 'Nodo: alice o bob');
  return value;
}

function assetIdOf(issued) {
  const record = object(issued);
  const nested = object(record.asset);
  return record.assetId ?? record.asset_id ?? nested.asset_id ?? nested.assetId ?? null;
}

function assetRows(source) {
  if (Array.isArray(source)) return source.map(object);
  const grouped = object(source);
  const kinds = ['nia', 'uda', 'cfa', 'ifa'];
  if (!kinds.some(key => Array.isArray(grouped[key]))) return [];
  return kinds.flatMap(kind => (grouped[kind] ?? []).map(value => ({ ...object(value), kind })));
}

async function loadEnv() {
  let text;
  try { text = await readFile(join(walletRoot, 'native-data/regtest/wallet.env'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const raw of text.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(raw);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

async function readPassword(envName, label) {
  if (process.env[envName]) return process.env[envName];
  if (passwords.has(envName)) return passwords.get(envName);
  if (!stdin.isTTY) throw new CliError('PASSWORD_REQUIRED', `${envName} richiesto`);
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const value = (await prompt.question(`${label}: `)).trim();
    if (!value) throw new CliError('INVALID_PASSWORD', 'Password vuota');
    passwords.set(envName, value);
    return value;
  } finally { prompt.close(); }
}

async function bitcoinRpc(method, params = [], wallet = '') {
  const user = process.env.BITCOIND_RPC_USER;
  const password = process.env.BITCOIND_RPC_PASSWORD;
  if (!user || !password) throw new CliError('REGTEST_CONFIG_MISSING', 'Configurazione RPC Bitcoin mancante');
  const host = process.env.BITCOIND_RPC_HOST ?? '127.0.0.1';
  const port = process.env.BITCOIND_RPC_PORT ?? '18443';
  let response;
  try {
    response = await fetch(`http://${host}:${port}${wallet ? `/wallet/${wallet}` : ''}`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '1.0', id: 'airgb-cli', method, params }),
    });
  } catch { throw new CliError('BITCOIN_RPC', 'Nodo Bitcoin non raggiungibile'); }
  const data = await response.json();
  if (!response.ok || data.error) {
    const error = new CliError('BITCOIN_RPC', data.error?.message ?? `HTTP ${response.status}`);
    error.rpcCode = data.error?.code;
    throw error;
  }
  return data.result;
}

async function rpcMine(blocks) {
  const address = await bitcoinRpc('getnewaddress', [], 'miner');
  await bitcoinRpc('generatetoaddress', [blocks, address], 'miner');
  return bitcoinRpc('getblockcount', []);
}

async function inMempool(txid) {
  try { await bitcoinRpc('getmempoolentry', [txid]); return true; }
  catch (error) { if (error.rpcCode === -5) return false; throw error; }
}

function fundOnChain(address, amount) {
  const result = spawnSync('bash', [join(repoRoot, 'scripts/regtest.sh'), 'fund', address, amount], { stdio: 'inherit', cwd: repoRoot });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new CliError('FUND_FAILED', 'fund regtest non riuscito');
}

async function nodeSession(name) {
  if (sessions.has(name)) return sessions.get(name);
  const base = nodes[name];
  const request = async (path, body, token) => {
    let response;
    try {
      response = await fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', origin, ...(token ? { 'x-session-token': token } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch { throw new CliError('NODE_OFFLINE', `${name} non raggiungibile su ${base}`); }
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new CliError(value.code ?? 'HTTP', value.message ?? value.code ?? `HTTP ${response.status}`);
    return value;
  };
  const session = await request('/api/session');
  if (typeof session.token !== 'string') throw new CliError('SESSION', `Sessione di ${name} non valida`);
  const api = (path, body) => request(path, body, session.token);
  sessions.set(name, api);
  return api;
}

function printAssets(rows, labels) {
  if (!rows.length) { line('asset', 'nessuno'); return; }
  line('asset', String(rows.length));
  for (const asset of rows) {
    console.log(`  ${asset.ticker ?? ''}  ${asset.name ?? ''}`.trimEnd());
    line('  id', asset.assetId);
    for (const [label, key] of labels) line(`  ${label}`, asset[key]);
  }
}

function printChannels(channels) {
  if (!channels.length) { line('canali', 'nessuno'); return; }
  line('canali', String(channels.length));
  for (const channel of channels) {
    line('  id', channel.channelId);
    line('  asset', channel.assetId);
    line('  local', channel.assetLocalAmount);
    line('  remote', channel.assetRemoteAmount);
    line('  usable', channel.isUsable === true ? 'sì' : channel.isUsable === false ? 'no' : '');
    line('  capacità', channel.capacitySat == null ? '' : `${channel.capacitySat} sat`);
  }
}

async function printNode(name) {
  const api = await nodeSession(name);
  const state = await api('/api/wallet/state');
  const chain = await api('/api/chain/status');
  console.log(`\n${name}`);
  line('stato', state.node);
  line('keystore', state.keystoreExists ? 'presente' : 'assente');
  line('invio', state.sendEnabled ? 'abilitato' : 'disabilitato');
  line('altezza', String(chain.height));
  if (state.node !== 'ready') return { state, channels: [] };
  const summary = await api('/api/wallet/summary');
  const assets = await api('/api/wallet/assets');
  const channels = await api('/api/wallet/channels');
  if (!Array.isArray(assets) || !Array.isArray(channels)) throw new CliError('RLN_SHAPE', 'Risposta asset o canali non riconosciuta');
  line('node', summary.nodeId);
  line('peer', summary.peerUri);
  line('indirizzo', summary.address);
  line('btc', `${summary.btcSpendableSat} sat`);
  const detailed = [];
  for (const asset of assets) {
    let balance = null;
    if (asset.assetId) {
      try { balance = await api(`/api/wallet/asset-balance?assetId=${encodeURIComponent(asset.assetId)}`); }
      catch { balance = null; }
    }
    detailed.push({ ...asset, settled: balance?.settled ?? null, spendable: balance?.spendable ?? null });
  }
  printAssets(detailed, [['settled', 'settled'], ['spendable', 'spendable']]);
  printChannels(channels);
  return { state, summary, channels };
}

async function mineOnNode(name, blocks) {
  const api = await nodeSession(name);
  let mined = 0;
  let height = 0;
  while (mined < blocks) {
    const chunk = Math.min(6, blocks - mined);
    const result = await api('/api/chain/mine', { blocks: chunk });
    mined += result.mined;
    height = result.height;
  }
  return { mined, height };
}

async function peerUri(name) {
  const api = await nodeSession(name);
  const state = await api('/api/wallet/state');
  if (state.node !== 'ready') throw new CliError('WALLET_LOCKED', `${name} è bloccato`);
  const summary = await api('/api/wallet/summary');
  if (!summary.peerUri) throw new CliError('PEER_URI_MISSING', `${name} non ha un peer URI`);
  return summary.peerUri;
}

async function createNode(name) {
  const password = await readPassword(passwordEnv(name), `Nuova password di ${name} (12-256)`);
  if (password.length < 12 || password.length > 256) throw new CliError('INVALID_PASSWORD', 'La password deve avere 12–256 caratteri');
  const api = await nodeSession(name);
  const created = await api('/api/wallet/create', { password });
  console.log(`Salva la frase di recupero di ${name} ora. Non verrà ristampata.`);
  console.log(created.recoveryPhrase);
  await printNode(name);
}

async function unlockNode(name) {
  const password = await readPassword(passwordEnv(name), `Password di ${name}`);
  const api = await nodeSession(name);
  await api('/api/wallet/unlock', { password });
  console.log(`${name} sbloccato`);
  await printNode(name);
}

async function syncNode(name) {
  const api = await nodeSession(name);
  await api('/api/wallet/sync', {});
  console.log(`${name} sincronizzato`);
  await printNode(name);
}

async function pollBtc(readBalance, before) {
  const start = BigInt(before);
  for (let attempt = 0; attempt < 20; attempt++) {
    await pause(1000);
    const next = BigInt(await readBalance());
    if (next > start) return next;
  }
  throw new CliError('FUND_UNSEEN', 'Finanziamento non visibile');
}

async function fundNode(name, amount) {
  const api = await nodeSession(name);
  const summary = await api('/api/wallet/summary');
  const before = BigInt(summary.btcSpendableSat);
  fundOnChain(summary.address, amount);
  const next = await pollBtc(async () => {
    await api('/api/wallet/sync', {});
    return BigInt((await api('/api/wallet/summary')).btcSpendableSat);
  }, before);
  console.log(`fund ${name}  ${summary.address}  ${amount} BTC  saldo ${next} sat`);
  await printNode(name);
}

async function utxosNode(name, count, size, fee) {
  const api = await nodeSession(name);
  const prepared = await api('/api/wallet/rgb/utxos', { count, sizeSat: String(size), feeRateSatPerVbyte: String(fee) });
  console.log(prepared.status === 'ready' ? `${name}: UTXO RGB già presenti` : `${name}: UTXO richiesti. Mina almeno un blocco.`);
  await printNode(name);
}

async function connectNode(name, peer) {
  const target = peer ?? await peerUri(other(name));
  const api = await nodeSession(name);
  await api('/api/wallet/peers/connect', { peer: target });
  console.log(`${name} collegato a ${target}`);
  await printNode(name);
}

async function issueNode(name, ticker, assetName, amount, precision) {
  const api = await nodeSession(name);
  const issued = await api('/api/wallet/rgb/issue', { ticker, name: assetName, precision, amounts: [amount] });
  line('asset', issued.assetId);
  line('ticker', issued.ticker);
  line('supply', issued.issuedSupply);
  await printNode(name);
}

async function channelNode(name, capacity, asset, amount, peer) {
  const target = peer ?? await peerUri(other(name));
  const api = await nodeSession(name);
  await api('/api/wallet/channels/open', { peer: target, capacitySat: capacity, public: true, assetId: asset, assetAmount: amount });
  console.log(`apertura richiesta  peer ${target}  capacità ${capacity} sat  asset ${asset}  importo ${amount}`);
  let fundingTxid = null;
  for (let attempt = 0; attempt < 20 && !fundingTxid; attempt++) {
    const channels = await api('/api/wallet/channels');
    fundingTxid = channels.find(channel => channel.assetId === asset)?.fundingTxid ?? null;
    if (!fundingTxid) await pause(1000);
  }
  if (!fundingTxid) throw new CliError('CHANNEL_FUNDING', 'Funding txid del canale RGB non disponibile. Ricostruisci i nodi se il servizio non espone fundingTxid.');
  for (let attempt = 0; attempt < 20 && !await inMempool(fundingTxid); attempt++) await pause(1000);
  const mined = await mineOnNode(name, 6);
  console.log(`funding ${fundingTxid}  minati ${mined.mined}  altezza ${mined.height}`);
  let usable = false;
  for (let attempt = 0; attempt < 40 && !usable; attempt++) {
    await pause(1500);
    await api('/api/wallet/sync', {});
    try { await (await nodeSession(other(name)))('/api/wallet/sync', {}); } catch { /* Il peer può essere ancora bloccato. */ }
    const channels = await api('/api/wallet/channels');
    usable = channels.some(channel => channel.assetId === asset && channel.isUsable === true);
  }
  await printNode(name);
  try { await printNode(other(name)); } catch (error) { console.error(`errore  ${error.code ?? 'CLI'}  ${error.message}`); }
  if (!usable) throw new CliError('CHANNEL_UNUSABLE', 'Canale RGB non utilizzabile entro 60 secondi');
}

async function invoiceNode(name, asset, amount, msat, expiry) {
  if (msat < 3_000_000) throw new CliError('RGB_HTLC_MINIMUM', 'RGB Lightning richiede almeno 3000000 msat');
  if (expiry < 60 || expiry > 86400) throw new CliError('INVALID_EXPIRY', 'Scadenza tra 60 e 86400 secondi');
  const api = await nodeSession(name);
  const created = await api('/api/wallet/receive/lightning', { amountMsat: String(msat), expirySec: expiry, assetId: asset, assetAmount: String(amount) });
  console.log('\ninvoice');
  line('invoice', created.invoice);
  line('tipo', created.kind);
  line('asset', asset);
  line('importo', String(amount));
  line('msat', String(msat));
  line('scadenza', `${expiry} s`);
  await printNode(name);
}

async function receiverName(payer, payee) {
  if (payee) {
    for (const name of ['alice', 'bob']) {
      try {
        const api = await nodeSession(name);
        const state = await api('/api/wallet/state');
        if (state.node !== 'ready') continue;
        const summary = await api('/api/wallet/summary');
        if (summary.nodeId?.toLowerCase() === payee.toLowerCase()) return name;
      } catch { /* Prova l'altro nodo. */ }
    }
  }
  return other(payer);
}

async function payNode(name, invoice, routing) {
  if (!/^lnbcrt/i.test(invoice)) throw new CliError('INVALID_INVOICE', 'Serve una invoice Lightning regtest');
  const api = await nodeSession(name);
  const decoded = await api('/api/payments/decode', { invoice });
  console.log('\ndecodifica');
  line('invoice', decoded.invoice);
  line('hash', decoded.paymentHash);
  line('msat', decoded.amountMsat);
  line('asset', decoded.assetId);
  line('importo', decoded.assetAmount);
  line('scadenza', Number.isSafeInteger(decoded.expiresAt) ? new Date(decoded.expiresAt).toISOString() : '');
  line('algoritmo', routing.algorithm);
  const id = randomUUID();
  await api('/api/payments/prepare', { id, invoice: decoded.invoice, constraints: {}, routing });
  let sent = await api('/api/payments/confirm', { id });
  for (let attempt = 0; attempt < 30 && !['succeeded', 'failed'].includes(sent.status); attempt++) {
    await pause(1000);
    sent = await api(`/api/payments/${id}`);
  }
  console.log('\npagamento');
  line('id', sent.id);
  line('hash', sent.paymentHash);
  line('stato', sent.status);
  line('msat', sent.amountMsat);
  line('asset', sent.assetId);
  line('importo', sent.assetAmount);
  const receiver = await receiverName(name, decoded.payeePubkey);
  try {
    const remote = await nodeSession(receiver);
    let status = await remote('/api/wallet/receive/lightning/status', { invoice: decoded.invoice });
    const readStatus = () => object(status.data).status ?? status.status ?? '';
    for (let attempt = 0; sent.status === 'succeeded' && readStatus() === 'Pending' && attempt < 10; attempt++) {
      await pause(500);
      status = await remote('/api/wallet/receive/lightning/status', { invoice: decoded.invoice });
    }
    const row = object(status.data);
    console.log(`\nricevente ${receiver}`);
    line('stato', readStatus());
    line('asset', row.asset_id ?? row.assetId);
    line('importo', row.asset_amount ?? row.assetAmount);
    line('msat', row.amt_msat ?? row.amtMsat);
  } catch (error) { console.error(`errore  ${error.code ?? 'CLI'}  ricevente  ${error.message}`); }
  await printNode(name);
  try { await printNode(receiver); } catch (error) { console.error(`errore  ${error.code ?? 'CLI'}  ${error.message}`); }
  if (sent.status !== 'succeeded') throw new CliError('PAYMENT_FAILED', `Pagamento ${sent.status}`);
}

async function withIssuer(task) {
  const vault = new VaultStore(issuerDir);
  if (!(await vault.exists())) throw new CliError('ISSUER_MISSING', 'Emittente assente: npm run cli -- issuer create');
  const mnemonic = await vault.unlockMnemonic(await readPassword('AIRGB_ISSUER_PASSWORD', 'Password emittente'));
  const indexerUrl = process.env.INDEXER_URL;
  const transportEndpoint = process.env.RGB_PROXY_ENDPOINT;
  if (!indexerUrl || !transportEndpoint) throw new CliError('REGTEST_CONFIG_MISSING', 'INDEXER_URL e RGB_PROXY_ENDPOINT richiesti');
  let WalletManagerRgb;
  try { ({ default: WalletManagerRgb } = await import('@utexo/wdk-wallet-rgb')); }
  catch (error) { throw new CliError('RGB_NATIVE', `Modulo RGB on-chain non caricabile: ${error instanceof Error ? error.message : 'errore sconosciuto'}`); }
  await mkdir(join(issuerDir, 'rgb'), { recursive: true, mode: 0o700 });
  const manager = new WalletManagerRgb(mnemonic, { network: 'regtest', dataDir: join(issuerDir, 'rgb'), indexerUrl, transportEndpoint });
  try {
    const account = await manager.getAccount(0);
    return await task(account);
  } finally {
    try { manager.dispose(); } catch { /* La chiusura non deve coprire l'esito. */ }
  }
}

async function printIssuer(account) {
  const registered = await account.registerWallet();
  await account.syncWallet();
  await account.refreshWallet();
  const address = registered.address ?? account.getAddress();
  const btc = await account.getBalance();
  const height = await bitcoinRpc('getblockcount', []);
  const unspents = account.listUnspents();
  console.log('\nemittente');
  line('indirizzo', address);
  line('btc', `${btc.toString()} sat`);
  line('utxo', String(Array.isArray(unspents) ? unspents.length : 0));
  line('altezza', String(height));
  const rows = [];
  for (const asset of assetRows(account.listAssets())) {
    const assetId = asset.asset_id ?? asset.assetId ?? asset.id ?? null;
    let balance = null;
    if (typeof assetId === 'string') {
      try { balance = (await account.getTokenBalance(assetId)).toString(); }
      catch { balance = null; }
    }
    rows.push({ ticker: asset.ticker ?? null, name: asset.name ?? null, assetId, settled: balance, spendable: balance });
  }
  printAssets(rows, [['saldo', 'settled']]);
  return { address, btc };
}

async function issuerCreate() {
  const vault = new VaultStore(issuerDir);
  if (await vault.exists()) throw new CliError('VAULT_EXISTS', 'Emittente già creato');
  const password = await readPassword('AIRGB_ISSUER_PASSWORD', 'Nuova password emittente (12-256)');
  const phrase = await vault.create(password);
  console.log('Salva la frase di recupero dell\'emittente ora. Non verrà ristampata.');
  console.log(phrase);
  await withIssuer(printIssuer);
}

async function fundIssuer(amount) {
  await withIssuer(async account => {
    const registered = await account.registerWallet();
    await account.syncWallet();
    const address = registered.address ?? account.getAddress();
    const before = await account.getBalance();
    fundOnChain(address, amount);
    const next = await pollBtc(async () => { await account.syncWallet(); return account.getBalance(); }, before);
    console.log(`fund emittente  ${address}  ${amount} BTC  saldo ${next} sat`);
    await printIssuer(account);
  });
}

async function utxosIssuer(count, size, fee) {
  await withIssuer(async account => {
    await account.registerWallet();
    await account.syncWallet();
    try { await account.createUtxos({ upTo: true, num: count, size, feeRate: fee }); console.log(`emittente: UTXO richiesti  ${count} x ${size} sat  fee ${fee}`); }
    catch (error) {
      if (!String(error instanceof Error ? error.message : error).includes('Allocations already available')) throw error;
      console.log('emittente: UTXO RGB già presenti');
    }
    const height = await rpcMine(1);
    console.log(`minato 1  altezza ${height}`);
    await printIssuer(account);
  });
}

async function issueIssuer(ticker, name, amount, precision) {
  if (!tickerPattern.test(ticker)) throw new CliError('INVALID_ASSET', 'Ticker NIA: 2–8 caratteri, inizia con una lettera maiuscola');
  if (name.length < 1 || name.length > 64 || /[\r\n]/.test(name)) throw new CliError('INVALID_ASSET', 'Nome NIA: 1–64 caratteri, una sola riga');
  if (!Number.isSafeInteger(precision) || precision < 0 || precision > 6) throw new CliError('INVALID_ASSET', 'Precisione NIA: intero da 0 a 6');
  await withIssuer(async account => {
    await account.registerWallet();
    await account.syncWallet();
    const issued = await account.issueAssetNia({ ticker, name, amounts: [amount], precision });
    const assetId = assetIdOf(issued);
    if (typeof assetId !== 'string' || !assetId.startsWith('rgb:')) throw new CliError('ISSUE_SHAPE', `Emissione NIA senza contract id: ${JSON.stringify(issued)}`);
    const nested = object(object(issued).asset);
    const supply = nested.issued_supply ?? object(issued).issued_supply ?? amount;
    const height = await rpcMine(1);
    console.log('\nemissione');
    line('ticker', ticker);
    line('nome', name);
    line('id', assetId);
    line('precisione', String(precision));
    line('supply', String(supply));
    line('altezza', String(height));
    await printIssuer(account);
  });
}

async function sendRgb(account, invoice, asset, amount) {
  // transfer() non ritrasmette la PSBT se il txid non entra in mempool.
  const psbt = await account.sendBegin({ invoice, assetId: asset, amount, feeRate: 2, minConfirmations: 1 });
  const signedPsbt = await account.signPsbt(psbt);
  const result = await account.sendEnd({ signedPsbt });
  const txid = result?.txid ?? result?.hash;
  if (typeof txid !== 'string') throw new CliError('SEND_SHAPE', `Invio RGB senza txid: ${JSON.stringify(result)}`);
  if (!await inMempool(txid)) {
    const finalized = await bitcoinRpc('finalizepsbt', [signedPsbt]);
    if (!finalized.complete) throw new CliError('PSBT_INCOMPLETE', `PSBT non finalizzata per ${txid}`);
    await bitcoinRpc('sendrawtransaction', [finalized.hex]);
  }
  return txid;
}

async function sendIssuer(asset, amount, to, invoice) {
  if (!asset.startsWith('rgb:')) throw new CliError('INVALID_ASSET', 'Contract id RGB mancante');
  let recipient = to;
  let rgbInvoice = invoice;
  if (!rgbInvoice) {
    const api = await nodeSession(to);
    const created = await api('/api/wallet/receive/rgb', { assetId: null, amount: null, expirySec: 3600 });
    rgbInvoice = created.invoice;
  }
  if (typeof rgbInvoice !== 'string' || !rgbInvoice.startsWith('rgb:')) throw new CliError('INVALID_INVOICE', 'Invoice RGB non valida');
  console.log('\ninvio on-chain');
  line('invoice', rgbInvoice);
  line('asset', asset);
  line('importo', String(amount));
  line('verso', recipient ?? '');
  await withIssuer(async account => {
    try {
      await account.syncWallet();
      await account.refreshWallet();
      const sent = await sendRgb(account, rgbInvoice, asset, amount);
      console.log(`txid ${sent}`);
      for (let attempt = 0; attempt < 12 && await inMempool(sent); attempt++) {
        await rpcMine(1);
        await pause(1000);
        if (attempt === 11) throw new CliError('TX_UNCONFIRMED', `Trasferimento ${sent} ancora in mempool`);
      }
      return sent;
    } finally {
      try { await printIssuer(account); }
      catch (error) { console.error(`errore  ${error.code ?? 'CLI'}  emittente  ${error.message}`); }
    }
  });
  if (!recipient) return;
  const api = await nodeSession(recipient);
  let spendable = null;
  for (let attempt = 0; attempt < 45 && !(spendable && BigInt(spendable) > 0n); attempt++) {
    await pause(2000);
    await api('/api/wallet/sync', {});
    try { spendable = (await api(`/api/wallet/asset-balance?assetId=${encodeURIComponent(asset)}`)).spendable; }
    catch { /* Il contratto non è ancora nello stash del nodo. */ }
  }
  await printNode(recipient);
  if (!spendable || BigInt(spendable) <= 0n) throw new CliError('RGB_NOT_RECEIVED', `${recipient} non ha ricevuto il NIA`);
}

function issuerNeeded(positionals) {
  const [command, target] = positionals;
  return command === 'issuer' || command === 'send' || target === 'issuer' || (command === 'status' && target === 'all');
}

function relaunch(positionals) {
  if (process.versions.node === nodeVersion || !issuerNeeded(positionals)) return false;
  const nodeBin = join(walletRoot, 'native-data', `node-v${nodeVersion}`, 'bin', 'node');
  if (!existsSync(nodeBin)) throw new CliError('NODE_VERSION', `Emittente RGB richiede Node ${nodeVersion}. Manca ${nodeBin}. Esegui npm run test:rgb una volta oppure lancia la CLI con quel Node.`);
  const result = spawnSync(nodeBin, ['--env-file=native-data/regtest/wallet.env', '--import', 'tsx', 'infra/regtest/cli.mjs', ...process.argv.slice(2)], { stdio: 'inherit', cwd: walletRoot });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

async function status(target) {
  const names = target === 'all' ? ['alice', 'bob', 'issuer'] : target ? [target] : ['alice', 'bob'];
  const failures = [];
  for (const name of names) {
    try {
      if (name === 'issuer') await withIssuer(printIssuer);
      else await printNode(nodeName(name));
    } catch (error) {
      failures.push(error);
      console.error(`errore  ${error.code ?? 'CLI'}  ${name}  ${error.message}`);
    }
  }
  if (failures.length) process.exitCode = 1;
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2), allowPositionals: true, strict: true,
    options: {
      help: { type: 'boolean', short: 'h' }, peer: { type: 'string' }, capacity: { type: 'string' },
      asset: { type: 'string' }, amount: { type: 'string' }, msat: { type: 'string' }, count: { type: 'string' },
      size: { type: 'string' }, fee: { type: 'string' }, ticker: { type: 'string' }, name: { type: 'string' },
      precision: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, invoice: { type: 'string' },
      algorithm: { type: 'string' }, weights: { type: 'string' },
      expiry: { type: 'string' },
    },
  });
  if (values.help || positionals.length === 0 || positionals[0] === 'help') { help(); return; }
  await loadEnv();
  relaunch(positionals);
  const [command, target, extra] = positionals;
  const count = values.count === undefined ? 4 : positiveInt(values.count, 'Numero UTXO');
  const fee = values.fee === undefined ? 2 : positiveInt(values.fee, 'Fee');
  if (command === 'status') return status(target);
  if (command === 'create') return createNode(nodeName(target));
  if (command === 'unlock') return unlockNode(nodeName(target));
  if (command === 'sync' && target === 'issuer') return withIssuer(printIssuer);
  if (command === 'sync') return syncNode(nodeName(target));
  if (command === 'fund' && target === 'issuer') return fundIssuer(btcAmount(extra));
  if (command === 'fund') return fundNode(nodeName(target), btcAmount(extra));
  if (command === 'mine') return mineCommand(target === undefined ? 1 : positiveInt(target, 'Blocchi'));
  if (command === 'utxos' && target === 'issuer') return utxosIssuer(count, values.size === undefined ? 10000 : positiveInt(values.size, 'Dimensione UTXO'), fee);
  if (command === 'utxos') return utxosNode(nodeName(target), count, values.size === undefined ? 200000 : positiveInt(values.size, 'Dimensione UTXO'), fee);
  if (command === 'connect') return connectNode(nodeName(target), values.peer);
  if (command === 'issue') return issueNode(nodeName(target), (values.ticker ?? '').toUpperCase(), values.name ?? '', positiveInt(values.amount, 'Importo'), values.precision === undefined ? 0 : nonNegativeInt(values.precision, 'Precisione'));
  if (command === 'channel') return channelNode(nodeName(target), String(positiveInt(values.capacity, 'Capacità')), requireAsset(values.asset), String(positiveInt(values.amount, 'Importo asset')), values.peer);
  if (command === 'invoice') return invoiceNode(nodeName(target), requireAsset(values.asset), positiveInt(values.amount, 'Importo asset'), values.msat === undefined ? 3000000 : positiveInt(values.msat, 'msat'), values.expiry === undefined ? 3600 : positiveInt(values.expiry, 'Scadenza'));
  if (command === 'pay') {
    if (typeof values.invoice !== 'string') throw new CliError('USAGE', 'Manca --invoice');
    if (!ROUTING_ALGORITHMS.includes(values.algorithm)) throw new CliError('USAGE', `Specificare --algorithm: ${ROUTING_ALGORITHMS.join(', ')}`);
    if ((values.algorithm === 'multi_objective') !== (values.weights !== undefined)) throw new CliError('USAGE', '--weights è richiesto solo con --algorithm multi_objective');
    const routing = { algorithm: values.algorithm };
    if (values.weights !== undefined) {
      try { routing.weights = JSON.parse(values.weights); }
      catch { throw new CliError('USAGE', '--weights deve essere un oggetto JSON con fee, reliability, cltv e hops'); }
    }
    return payNode(nodeName(target), values.invoice, routing);
  }
  if (command === 'issuer') return issuerDispatch(target, extra, values, count, fee);
  if (command === 'send') {
    if (values.from !== 'issuer') throw new CliError('USAGE', 'L\'invio on-chain parte dall\'emittente: --from issuer');
    if (values.to === undefined && values.invoice === undefined) throw new CliError('USAGE', 'Specifica --to alice|bob, --invoice rgb:..., oppure entrambi');
    if (values.to !== undefined && values.to !== 'alice' && values.to !== 'bob') throw new CliError('USAGE', '--to: alice o bob');
    return sendIssuer(requireAsset(values.asset), positiveInt(values.amount, 'Importo asset'), values.to, values.invoice);
  }
  throw new CliError('USAGE', `Comando sconosciuto: ${command}`);
}

function requireAsset(value) {
  if (typeof value !== 'string' || !value.startsWith('rgb:')) throw new CliError('USAGE', 'Manca --asset rgb:...');
  return value;
}

async function syncIfReady(name) {
  const api = await nodeSession(name);
  const state = await api('/api/wallet/state');
  if (state.node === 'ready') await api('/api/wallet/sync', {});
}

async function mineCommand(blocks) {
  if (blocks > 100) throw new CliError('INVALID_AMOUNT', 'Massimo 100 blocchi');
  const mined = await mineOnNode('alice', blocks);
  console.log(`minati ${mined.mined}  altezza ${mined.height}`);
  for (const name of ['alice', 'bob']) {
    try { await syncIfReady(name); }
    catch (error) { console.error(`errore  ${error.code ?? 'CLI'}  ${name}  ${error.message}`); }
    try { await printNode(name); }
    catch (error) { console.error(`errore  ${error.code ?? 'CLI'}  ${name}  ${error.message}`); }
  }
}

async function issuerDispatch(subcommand, extra, values, count, fee) {
  if (subcommand === 'create') return issuerCreate();
  if (subcommand === 'status' || subcommand === 'sync') return withIssuer(printIssuer);
  if (subcommand === 'fund') return fundIssuer(btcAmount(extra));
  if (subcommand === 'utxos') return utxosIssuer(count, values.size === undefined ? 10000 : positiveInt(values.size, 'Dimensione UTXO'), fee);
  if (subcommand === 'issue') return issueIssuer((values.ticker ?? '').toUpperCase(), values.name ?? '', positiveInt(values.amount, 'Importo'), values.precision === undefined ? 0 : nonNegativeInt(values.precision, 'Precisione'));
  throw new CliError('USAGE', 'issuer: create, status, sync, fund, utxos, issue');
}

main().catch(error => {
  console.error(`errore  ${error.code ?? 'CLI'}  ${error.message}`);
  if (error.code === 'USAGE') help();
  process.exitCode = 1;
});
