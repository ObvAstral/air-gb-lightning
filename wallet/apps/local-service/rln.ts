import { createHash, randomBytes } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import sourceLock from '../../infra/native/source-lock.json' with { type: 'json' };

type Row = Record<string, unknown>;
export class RlnError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function verifiedBinary(directory = join(import.meta.dirname, '../../native-data/runtime/bin')): Promise<string> {
  try {
    const manifest = JSON.parse(await readFile(join(directory, 'build.json'), 'utf8'));
    const binary = join(directory, 'rgb-lightning-node');
    const patchSha256 = sha(await readFile(join(import.meta.dirname, '../../infra/native/loopback.patch')));
    if (JSON.stringify(manifest.source) !== JSON.stringify(sourceLock)
      || manifest.telemetryPatchSha256 !== sha(await readFile(join(import.meta.dirname, '../../infra/native/benchmark-telemetry.patch')))
      || manifest.patchSha256 !== patchSha256 || manifest.platform !== process.platform || manifest.arch !== process.arch
      || manifest.binarySha256 !== sha(await readFile(binary))) throw new Error('Manifest non corrispondente');
    return binary;
  } catch {
    throw new RlnError('RLN_BUILD_REQUIRED', 'Eseguire npm run native:build per compilare le fork RGB MPP verificate');
  }
}

export async function prepareRlnStorage(directory: string): Promise<string> {
  // The daemon derives different keys from WDK's external signer. Reusing the
  // mnemonic does not migrate channel monitors, RGB consignments or VLS state.
  try {
    if ((await readdir(join(directory, 'wdk-rgb-lightning'))).length > 0) {
      throw new RlnError('LEGACY_NODE_STATE', 'Stato UTEXO presente: usare una nuova AIRGB_DATA_DIR per la fork MPP e conservare i dati precedenti per il recupero');
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const storage = join(directory, 'rgb-lightning-node');
  await mkdir(storage, { recursive: true, mode: 0o700 });
  return storage;
}

export class RlnClient {
  constructor(readonly url: string, private token = '') {}
  async request(path: string, body?: Row, timeoutMs = 120_000): Promise<Row> {
    // Mutations are never retried: after a transport failure a payment may
    // already be in flight. PaymentStore reconciles by payment_hash.
    const response = await fetch(this.url + '/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(this.token ? { 'x-airgb-rln-token': this.token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
    });
    const row: unknown = await response.json();
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new RlnError('RLN_SHAPE', 'Risposta del daemon non riconosciuta');
    const data = row as Row;
    if (!response.ok) throw new RlnError(typeof data.name === 'string' ? data.name : 'RLN_HTTP_ERROR', typeof data.error === 'string' ? data.error : `Errore daemon HTTP ${response.status}`);
    return data;
  }
}

export class RlnDaemon {
  private child: ChildProcess | null = null;
  private closed: Promise<void> = Promise.resolve();
  private exited = true;
  client: RlnClient | null = null;
  get running() { return this.child !== null && !this.exited; }
  async start(directory: string, peerPort: number, executable?: string, prefixArgs: string[] = []): Promise<RlnClient> {
    const binary = executable ?? await verifiedBinary();
    const reservation = createServer();
    await new Promise<void>((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
    const port = (reservation.address() as import('node:net').AddressInfo).port;
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    // loopback.patch limits the REST listener to localhost. Only the LN peer
    // port is reachable outside this process/container.
    const log = openSync(join(directory, 'daemon.log'), 'a', 0o600);
    const token = randomBytes(32).toString('hex');
    try {
      this.child = spawn(binary, [...prefixArgs, directory, '--network', 'regtest', '--daemon-listening-port', String(port), '--ldk-peer-listening-port', String(peerPort), '--disable-authentication'], { stdio: ['ignore', log, log], env: { ...process.env, AIRGB_RLN_TOKEN: token } });
    } finally { closeSync(log); }
    this.exited = false;
    let startupError: Error | null = null;
    this.child.once('error', error => { startupError = error; });
    this.closed = new Promise(resolve => this.child!.once('close', () => { this.exited = true; resolve(); }));
    const client = new RlnClient(`http://127.0.0.1:${port}`, token);
    this.client = client;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (startupError) throw startupError;
      if (this.exited) throw new RlnError('RLN_EXITED', `Daemon arrestato; verificare ${join(directory, 'daemon.log')}`);
      try { await client.request('nodeinfo', undefined, 1000); return client; }
      catch (error) { if (error instanceof RlnError && error.code === 'LockedNode') return client; }
      await pause(100);
    }
    throw new RlnError('RLN_START_TIMEOUT', `Daemon non pronto; verificare ${join(directory, 'daemon.log')}`);
  }
  async stop(): Promise<void> {
    if (!this.child || this.exited) return;
    try { await this.client?.request('shutdown', {}, 5000); } catch { /* Fall back to SIGTERM. */ }
    const wait = async (timeout: number) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([this.closed, new Promise<void>(resolve => { timer = setTimeout(resolve, timeout); })]); }
      finally { clearTimeout(timer); }
    };
    await wait(20_000);
    if (!this.exited) { this.child.kill('SIGTERM'); await wait(30_000); }
    if (!this.exited) throw new RlnError('RLN_SHUTDOWN_TIMEOUT', 'Il daemon sta ancora salvando lo stato; lock conservato');
    this.child = null; this.client = null;
  }
}

// Keep the service's wallet operations stable while translating the fork's
// REST shapes. Routing and multipart splitting stay inside the pinned daemon.
export class RlnAccount {
  private address: string | null = null;
  constructor(private client: RlnClient, private proxyEndpoint: string) {}
  async getAddressState() {
    if (!this.address) {
      const row = await this.client.request('address', {});
      if (typeof row.address !== 'string') throw new RlnError('RLN_SHAPE', 'Indirizzo del daemon mancante');
      this.address = row.address;
    }
    return { status: 'ready', address: this.address };
  }
  async getBalance() {
    const row = await this.client.request('btcbalance', { skip_sync: true });
    const amount = (row.vanilla as Row | undefined)?.spendable;
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) throw new RlnError('RLN_SHAPE', 'Saldo BTC non riconosciuto');
    return BigInt(amount);
  }
  getNodeInfo() { return this.client.request('nodeinfo'); }
  getNetworkInfo() { return this.client.request('networkinfo'); }
  async sync() {
    await this.client.request('sync', { options: { keychain: { Vanilla: { lookback: 20 } }, strategy: 'FullSync' } });
    await this.client.request('sync', { options: { keychain: 'Colored', strategy: 'FullSync' } });
  }
  refreshTransfers(body: Row) { return this.client.request('refreshtransfers', body); }
  createUtxos(body: Row) { return this.client.request('createutxos', body); }
  issueAssetNia(body: Row) { return this.client.request('issueassetnia', body); }
  async listChannels() { return (await this.client.request('listchannels')).channels; }
  async listPeers() { return (await this.client.request('listpeers')).peers; }
  listAssets() { return this.client.request('listassets', { filter_asset_schemas: [] }); }
  getAssetBalance(assetId: string) { return this.client.request('assetbalance', { asset_id: assetId }); }
  async listPayments() { return (await this.client.request('listpayments')).payments; }
  getTransactions() { return this.client.request('listtransactions', { skip_sync: false }); }
  listTransfers(assetId: string) { return this.client.request('listtransfers', { asset_filter: { type: 'Id', value: assetId } }); }
  getInvoiceStatus(invoice: string) { return this.client.request('invoicestatus', { invoice }); }
  createLightningInvoice(body: { amountMsat: number; expirySec: number; assetId?: string; assetAmount?: number }) {
    return this.client.request('lninvoice', { amt_msat: body.amountMsat, expiry_sec: body.expirySec, asset_id: body.assetId, asset_amount: body.assetAmount });
  }
  createRgbInvoice(body: Row) {
    return this.client.request('rgbinvoice', {
      asset_id: body.asset_id, assignment: body.assignment_amount === undefined ? undefined : { type: 'Fungible', value: body.assignment_amount },
      expiration_timestamp: Math.floor(Date.now() / 1000) + Number(body.duration_seconds),
      min_confirmations: body.min_confirmations, witness: body.witness, transport_endpoints: [this.proxyEndpoint],
    });
  }
  decodeInvoice(invoice: string) { return this.client.request('decodelninvoice', { invoice }); }
  decodeRgbInvoice(invoice: string) { return this.client.request('decodergbinvoice', { invoice }); }
  sendRgb(body: Row) { return this.client.request('sendrgb', body); }
  connectPeer(peer: string) { return this.client.request('connectpeer', { peer_pubkey_and_addr: peer }); }
  openChannel(body: Row) { return this.client.request('openchannel', body); }
  sendPayment(body: Row) { return this.client.request('sendpayment', body); }
  async getPayment(hash: string) {
    const row = await this.client.request('getpayment', { payment_hash: hash });
    if (!row.payment || typeof row.payment !== 'object' || Array.isArray(row.payment)) throw new RlnError('RLN_SHAPE', 'Pagamento del daemon mancante');
    return row.payment as Row;
  }
}
