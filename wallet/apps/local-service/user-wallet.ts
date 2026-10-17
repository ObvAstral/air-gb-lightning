import { join, resolve } from 'node:path';
import type { PaymentRouting } from '../../packages/contracts/types.js';
import { validNodeId } from '../../packages/policy/compile.js';
import { VaultStore } from './vault.js';
import { WalletError, type DecodedLightning } from './wallet.js';

type Row = Record<string, unknown>;
type AddressState = { status: string; address: string | null };
type WdkAccount = {
  unlock(request: Row): Promise<unknown>;
  sync(): Promise<unknown>;
  getAddressState(): Promise<AddressState>;
  getBalance(skipSync?: boolean): Promise<bigint | number>;
  getNodeInfo(): Promise<unknown>;
  getNetworkInfo(): Promise<unknown>;
  listChannels(): Promise<unknown>;
  listPeers(): Promise<unknown>;
  listAssets(filter?: unknown): Promise<unknown>;
  getAssetBalance(assetId: string): Promise<unknown>;
  listPayments(): Promise<unknown>;
  createUtxos(request: Row): Promise<unknown>;
  createLightningInvoice(request: Row): Promise<unknown>;
  getInvoiceStatus(invoice: string): Promise<unknown>;
  decodeInvoice(invoice: string): Promise<unknown>;
  connectPeer(peer: string): Promise<unknown>;
  openChannel(request: Row): Promise<unknown>;
  sendPayment(request: Row): Promise<unknown>;
  getPayment(hash: string, type?: string): Promise<unknown>;
  refreshTransfers?(request: Row): Promise<unknown>;
  issueAssetNia?(request: Row): Promise<unknown>;
  keyPair?: { publicKey?: unknown };
};
type WdkManager = { getAccount(index?: number): Promise<WdkAccount>; dispose(): void };

const object = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const positiveInteger = (value: unknown): bigint | null => {
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  return null;
};
const safeNumber = (value: string, name: string): number => {
  const parsed = positiveInteger(value);
  if (parsed === null || parsed <= 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new WalletError('INVALID_AMOUNT', `${name} deve essere un intero positivo rappresentabile`);
  return Number(parsed);
};
const stringField = (row: Row, key: string): string | null => typeof row[key] === 'string' ? row[key] as string : null;
const rowsOf = (value: unknown, key: string): Row[] => {
  const list = Array.isArray(value) ? value : object(value)[key];
  return Array.isArray(list) ? list.map(object) : [];
};
const pubkeyHex = (value: unknown): string | null => {
  if (typeof value === 'string' && /^[0-9a-fA-F]{66}$/.test(value)) return value.toLowerCase();
  if (value instanceof Uint8Array && value.length === 33) return Buffer.from(value).toString('hex');
  return null;
};
const peerPort = (): number => {
  const value = Number(process.env.AIRGB_USER_PEER_PORT ?? '9739');
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) throw new WalletError('INVALID_PEER_PORT', 'Porta LDK utente non valida');
  return value;
};
const announceHost = (): string => {
  const host = process.env.AIRGB_USER_ANNOUNCE_HOST ?? 'host.docker.internal';
  if (!/^[a-zA-Z0-9.-]{1,253}$/.test(host)) throw new WalletError('INVALID_ANNOUNCE_HOST', 'Host di announce non valido');
  return host;
};

export class UserRgbWallet {
  readonly dataDir: string;
  readonly vault: VaultStore;
  readonly listeningPort: number;
  private manager: WdkManager | null = null;
  private account: WdkAccount | null = null;
  private starting: Promise<void> | null = null;
  private stopped = false;
  constructor(directory = process.env.AIRGB_DATA_DIR ?? join(import.meta.dirname, '../../native-data/user-wallet')) {
    this.dataDir = resolve(directory);
    this.vault = new VaultStore(this.dataDir);
    this.listeningPort = peerPort();
  }
  get ready(): boolean { return this.account !== null; }
  get canSend(): boolean { return this.ready && process.env.ENABLE_REGTEST_SEND === '1'; }
  async state() { return { keystoreExists: await this.vault.exists(), node: this.ready ? 'ready' : 'locked', network: 'regtest', sendEnabled: this.canSend }; }
  async create(password: string, mnemonic?: string) { return { recoveryPhrase: await this.vault.create(password, mnemonic), state: await this.state() }; }
  async unlock(password: string): Promise<void> {
    if (this.stopped) throw new WalletError('STOPPED', 'Servizio wallet arrestato');
    if (this.ready) return;
    if (this.starting) return this.starting;
    this.starting = this.start(password);
    try { await this.starting; } finally { this.starting = null; }
  }
  private requireAccount(): WdkAccount {
    if (!this.account) throw new WalletError('WALLET_LOCKED', 'Sbloccare il wallet utente');
    return this.account;
  }
  private async start(password: string) {
    const required = ['BITCOIND_RPC_USER', 'BITCOIND_RPC_PASSWORD', 'INDEXER_URL', 'RGB_PROXY_ENDPOINT'];
    const missing = required.filter(key => !process.env[key]);
    if (missing.length) throw new WalletError('REGTEST_CONFIG_MISSING', `Configurazione mancante: ${missing.join(', ')}`);
    const mnemonic = await this.vault.unlockMnemonic(password);
    let WalletManagerRgbLightning: new (seed: string, config: object) => WdkManager;
    try {
      ({ default: WalletManagerRgbLightning } = await import('@utexo/wdk-rgb-lightning') as unknown as { default: new (seed: string, config: object) => WdkManager });
    } catch (error) { throw new WalletError('WDK_NATIVE', `Modulo WDK RGB Lightning non caricabile: ${error instanceof Error ? error.message : 'errore sconosciuto'}`); }
    const manager = new WalletManagerRgbLightning(mnemonic, {
      network: 'regtest',
      dataDir: this.dataDir,
      daemonListeningPort: 0,
      ldkPeerListeningPort: this.listeningPort,
      nodeSeedDerivation: 'auto',
      permissiveSignerPolicy: true,
    });
    try {
      const account = await manager.getAccount(0);
      await account.unlock({
        bitcoind_rpc_username: process.env.BITCOIND_RPC_USER,
        bitcoind_rpc_password: process.env.BITCOIND_RPC_PASSWORD,
        bitcoind_rpc_host: process.env.BITCOIND_RPC_HOST ?? '127.0.0.1',
        bitcoind_rpc_port: Number(process.env.BITCOIND_RPC_PORT ?? 18443),
        indexer_url: process.env.INDEXER_URL,
        proxy_endpoint: process.env.RGB_PROXY_ENDPOINT,
        announce_addresses: [`${announceHost()}:${this.listeningPort}`],
        announce_alias: 'AIR-GB-user',
      });
      const address = await account.getAddressState();
      if (address.status !== 'ready') throw new WalletError('NODE_LOCKED', 'Il wallet utente non è pronto');
      this.manager = manager;
      this.account = account;
    } catch (error) {
      try { manager.dispose(); } catch { /* La chiusura non deve coprire l'errore di avvio. */ }
      if (error instanceof WalletError) throw error;
      throw new WalletError('WDK_UNLOCK', error instanceof Error ? error.message : 'Sblocco WDK non riuscito');
    }
  }
  async summary() {
    const account = this.requireAccount();
    const address = await account.getAddressState();
    if (address.status !== 'ready' || !address.address) throw new WalletError('WALLET_LOCKED', 'Account bloccato');
    const [btc, node, network] = await Promise.all([account.getBalance(true), account.getNodeInfo(), account.getNetworkInfo()]);
    const nodeId = stringField(object(node), 'pubkey') ?? pubkeyHex(account.keyPair?.publicKey);
    if (!nodeId || !validNodeId(nodeId)) throw new WalletError('RLN_SHAPE', 'Pubkey del wallet utente non valida');
    const sat = positiveInteger(btc);
    return { network: 'regtest', address: address.address, nodeId, peerUri: `${nodeId}@${announceHost()}:${this.listeningPort}`, btcSpendableSat: (sat ?? 0n).toString(), nodeInfo: object(node), networkInfo: object(network) };
  }
  async sync() { await this.requireAccount().sync(); }
  async refresh() {
    await this.sync();
    await this.requireAccount().refreshTransfers?.({ filter: [], skip_sync: false });
  }
  async prepareRgbUtxos(input: { count: number; sizeSat: string; feeRateSatPerVbyte: string }) {
    if (!Number.isSafeInteger(input.count) || input.count < 1 || input.count > 8) throw new WalletError('INVALID_UTXO_COUNT', 'Numero UTXO compreso tra 1 e 8');
    const size = safeNumber(input.sizeSat, 'Dimensione UTXO in sat');
    const feeRate = safeNumber(input.feeRateSatPerVbyte, 'Fee in sat/vB');
    if (size < 10000 || size > 1000000 || feeRate > 100) throw new WalletError('INVALID_UTXO_PARAMETERS', 'Dimensione UTXO: 10000–1000000 sat; fee: 1–100 sat/vB');
    try {
      await this.requireAccount().createUtxos({ up_to: true, num: input.count, size, fee_rate: feeRate, skip_sync: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('Allocations already available')) return { status: 'ready', confirmationRequired: false };
      throw error;
    }
    return { status: 'requested', confirmationRequired: true };
  }
  async issueNia(input: { ticker: string; name: string; precision: number; amounts: number[] }) {
    const issue = this.requireAccount().issueAssetNia;
    if (!issue) throw new WalletError('ISSUE_UNSUPPORTED', 'Questo wallet WDK non emette NIA. Emetti su Alice e ricevi l\'asset via canale.');
    const response = object(await issue.call(this.account, { ticker: input.ticker, name: input.name.trim(), precision: input.precision, amounts: input.amounts }));
    const asset = object(response.asset);
    const assetId = stringField(asset, 'asset_id') ?? stringField(response, 'asset_id');
    if (!assetId?.startsWith('rgb:')) throw new WalletError('ISSUE_SHAPE', 'Risposta di emissione NIA non riconosciuta');
    return { assetId, ticker: input.ticker, name: input.name.trim(), precision: input.precision, issuedSupply: (positiveInteger(asset.issued_supply) ?? positiveInteger(String(input.amounts.reduce((sum, amount) => sum + amount, 0))))?.toString() ?? null };
  }
  async channels() {
    return rowsOf(await this.requireAccount().listChannels(), 'channels').map(row => ({
      channelId: stringField(row, 'channel_id'), peerNodeId: stringField(row, 'peer_pubkey') ?? stringField(row, 'peer_node_id'),
      assetId: stringField(row, 'asset_id'), capacitySat: positiveInteger(row.capacity_sat)?.toString() ?? null,
      outboundMsat: positiveInteger(row.outbound_balance_msat ?? row.outbound_capacity_msat)?.toString() ?? null,
      inboundMsat: positiveInteger(row.inbound_balance_msat)?.toString() ?? null,
      assetLocalAmount: positiveInteger(row.asset_local_amount)?.toString() ?? null,
      assetRemoteAmount: positiveInteger(row.asset_remote_amount)?.toString() ?? null,
      isUsable: typeof row.is_usable === 'boolean' ? row.is_usable : null,
      fundingTxid: stringField(row, 'funding_txid'),
      public: typeof row.public === 'boolean' ? row.public : null,
    }));
  }
  async peers() {
    return rowsOf(await this.requireAccount().listPeers(), 'peers').map(row => ({ nodeId: stringField(row, 'pubkey') ?? stringField(row, 'node_id'), connected: typeof row.is_connected === 'boolean' ? row.is_connected : null }));
  }
  async assets() {
    const source = await this.requireAccount().listAssets();
    const grouped = object(source);
    const rows = ['nia', 'uda', 'cfa', 'ifa'].some(key => Object.hasOwn(grouped, key))
      ? ['nia', 'uda', 'cfa', 'ifa'].flatMap(kind => rowsOf(grouped[kind] ?? [], kind).map(value => ({ ...value, kind })))
      : rowsOf(source, 'assets');
    return rows.map(row => ({ assetId: stringField(row, 'asset_id') ?? stringField(row, 'id'), ticker: stringField(row, 'ticker'), name: stringField(row, 'name'), kind: stringField(row, 'kind') }));
  }
  async assetBalance(assetId: string) {
    if (!assetId || assetId.length > 200) throw new WalletError('INVALID_ASSET', 'Asset ID non valido');
    const row = object(await this.requireAccount().getAssetBalance(assetId));
    return { assetId, settled: positiveInteger(row.settled)?.toString() ?? null, spendable: positiveInteger(row.spendable)?.toString() ?? null, future: positiveInteger(row.future)?.toString() ?? null };
  }
  async history() {
    return rowsOf(await this.requireAccount().listPayments(), 'payments').map(row => ({
      paymentHash: stringField(row, 'payment_hash'), status: stringField(row, 'status') ?? 'unknown',
      amountMsat: positiveInteger(row.amt_msat)?.toString() ?? null,
      assetId: stringField(row, 'asset_id'), assetAmount: positiveInteger(row.asset_amount)?.toString() ?? null,
    }));
  }
  async invoiceStatus(invoice: string) {
    if (!/^lnbcrt[0-9a-z]{10,4096}$/i.test(invoice)) throw new WalletError('INVALID_INVOICE', 'Serve una invoice Lightning regtest');
    return await this.requireAccount().getInvoiceStatus(invoice);
  }
  async createLightningInvoice(input: { amountMsat: string; expirySec: number; assetId?: string; assetAmount?: string }) {
    const amountMsat = safeNumber(input.amountMsat, 'Importo Lightning');
    if (!Number.isSafeInteger(input.expirySec) || input.expirySec < 60 || input.expirySec > 86400) throw new WalletError('INVALID_EXPIRY', 'Scadenza tra 60 e 86400 secondi');
    if (!!input.assetId !== !!input.assetAmount) throw new WalletError('INVALID_ASSET', 'Asset ID e importo RGB devono essere presenti insieme');
    if (input.assetId && amountMsat < 3_000_000) throw new WalletError('RGB_HTLC_MINIMUM', 'RGB Lightning richiede almeno 3000000 msat in questa versione');
    const request: Row = { amountMsat, expirySec: input.expirySec };
    if (input.assetId) { request.assetId = input.assetId; request.assetAmount = safeNumber(input.assetAmount!, 'Importo RGB'); }
    const response = object(await this.requireAccount().createLightningInvoice(request));
    const invoice = stringField(response, 'invoice') ?? stringField(response, 'bolt11');
    if (!invoice?.toLowerCase().startsWith('lnbcrt')) throw new WalletError('INVOICE_SHAPE', 'Risposta invoice WDK non riconosciuta');
    return { invoice, kind: input.assetId ? 'rgb-lightning' : 'btc-lightning', expirySec: input.expirySec };
  }
  async decodeLightning(invoice: string): Promise<DecodedLightning> {
    if (!/^lnbcrt[0-9a-z]{10,4096}$/i.test(invoice)) throw new WalletError('INVALID_INVOICE', 'Serve una invoice Lightning regtest');
    const row = object(await this.requireAccount().decodeInvoice(invoice));
    const network = stringField(row, 'network')?.toLowerCase();
    const hash = stringField(row, 'payment_hash');
    const timestamp = positiveInteger(row.timestamp);
    const expiry = positiveInteger(row.expiry_sec ?? row.expiry);
    if (network && network !== 'regtest') throw new WalletError('DECODE_SHAPE', 'Invoice non regtest');
    if (!hash || !/^[0-9a-f]{64}$/i.test(hash) || timestamp === null || expiry === null) throw new WalletError('DECODE_SHAPE', 'Risposta di decodifica non verificabile');
    const expiresAt = Number(timestamp + expiry) * 1000;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw new WalletError('INVOICE_EXPIRED', 'Invoice scaduta');
    const amount = row.amt_msat == null ? null : positiveInteger(row.amt_msat)?.toString() ?? null;
    if (row.amt_msat != null && amount === null) throw new WalletError('DECODE_SHAPE', 'Importo invoice non valido');
    const assetId = stringField(row, 'asset_id');
    const assetAmount = row.asset_amount == null ? null : positiveInteger(row.asset_amount)?.toString() ?? null;
    if (assetId && !assetAmount) throw new WalletError('DECODE_SHAPE', 'Importo RGB mancante');
    return { invoice, network: 'regtest', paymentHash: hash.toLowerCase(), payeePubkey: stringField(row, 'payee_pubkey'), amountMsat: amount, assetId, assetAmount, expiresAt, description: stringField(row, 'description') };
  }
  async connectPeer(peer: string) {
    const match = /^([0-9a-fA-F]{66})@([a-zA-Z0-9.-]+):(\d{1,5})$/.exec(peer);
    if (!match || !validNodeId(match[1]) || Number(match[3]) < 1 || Number(match[3]) > 65535) throw new WalletError('INVALID_PEER', 'Usare pubkey@host:porta');
    await this.requireAccount().connectPeer(peer);
    return { connected: true };
  }
  async openChannel(input: { peer: string; capacitySat: string; public?: boolean; assetId?: string; assetAmount?: string }) {
    const match = /^([0-9a-fA-F]{66})@([a-zA-Z0-9.-]+):(\d{1,5})$/.exec(input.peer);
    if (!match || !validNodeId(match[1])) throw new WalletError('INVALID_PEER', 'Peer non valido');
    if (!!input.assetId !== !!input.assetAmount) throw new WalletError('INVALID_ASSET', 'Asset ID e importo richiesti insieme');
    const request: Row = { peer_pubkey_and_opt_addr: input.peer, capacity_sat: safeNumber(input.capacitySat, 'Capacità canale'), push_msat: 0, public: input.public ?? true, with_anchors: true };
    if (input.assetId) { request.asset_id = input.assetId; request.asset_amount = safeNumber(input.assetAmount!, 'Importo asset'); }
    return object(await this.requireAccount().openChannel(request));
  }
  async sendLightning(decoded: DecodedLightning, amountMsat: string, _routing: PaymentRouting): Promise<Row> {
    if (!this.canSend) throw new WalletError('SEND_DISABLED', 'Invio regtest non abilitato');
    const amount = safeNumber(amountMsat, 'Importo Lightning');
    if (decoded.amountMsat !== null && decoded.amountMsat !== amountMsat) throw new WalletError('AMOUNT_MISMATCH', 'Importo diverso dalla invoice');
    const request: Row = { invoice: decoded.invoice };
    if (decoded.amountMsat === null) request.amt_msat = amount;
    if (decoded.assetId) { request.asset_id = decoded.assetId; request.asset_amount = safeNumber(decoded.assetAmount!, 'Importo RGB'); }
    return object(await this.requireAccount().sendPayment(request));
  }
  async paymentStatus(hash: string) { return object(await this.requireAccount().getPayment(hash, 'Outbound')); }
  shutdown() {
    this.stopped = true;
    const manager = this.manager;
    this.manager = null;
    this.account = null;
    try { manager?.dispose(); } catch { /* Lo shutdown non deve bloccare il processo. */ }
  }
}
