import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import Ajv from 'ajv';
import schema from '../../packages/contracts/extracted.schema.json' with { type: 'json' };
import type { ExtractedConstraints, PaymentDraft, RoutingCapabilities, SyntheticHistoryLevel } from '../../packages/contracts/types.js';
import { compileConstraints, validNodeId } from '../../packages/policy/compile.js';
import { interpretWithQvac, InterpretationError } from './interpret.js';
import { RgbWallet, WalletError } from './wallet.js';
import { RlnError } from './rln.js';
import sourceLock from '../../infra/native/source-lock.json' with { type: 'json' };
import { PaymentStore, parseCompiledPolicy, type PaymentRecord } from './payments.js';
import { VaultError } from './vault.js';
import { chainHeight, mineBlocks } from './chain.js';
import { QvacRagStore, scoreChannelsWithQvac, type LiveChannelInput } from './channel-scoring.js';
import { selectRoutingAlgorithmWithQvac } from './routing-selector.js';

const port = Number(process.env.PORT ?? 8787);
const bindHost = process.env.BIND_HOST ?? '127.0.0.1';
if (bindHost !== '127.0.0.1' && bindHost !== '0.0.0.0') throw new Error('BIND_HOST deve essere 127.0.0.1 oppure 0.0.0.0');
if (!process.env.QVAC_MODEL) process.env.QVAC_MODEL = 'my-llm';

const checkQvacHealth = async (): Promise<string> => {
  try {
    const base = new URL(process.env.QVAC_URL ?? 'http://127.0.0.1:11434');
    const res = await fetch(new URL('/v1/models', base), {
      method: 'GET',
      signal: AbortSignal.timeout(1000),
    });
    if (res.ok) return 'online';
  } catch {
    /* QVAC server unreachable */
  }
  return process.env.QVAC_MODEL ? 'offline' : 'not_configured';
};
const token = randomBytes(32).toString('hex');
const wallet = new RgbWallet();
const ragStore = new QvacRagStore(wallet.dataDir);
const recordPaymentEpisode = async (record: PaymentRecord): Promise<void> => {
  if (record.status !== 'succeeded' && record.status !== 'failed') return;
  let channels: LiveChannelInput[] = [];
  let known: { alias: string; pubkey: string }[] = [];
  let payeePubkey: string | null = null;
  try {
    if (wallet.ready) {
      [channels, known] = await Promise.all([wallet.channels(), resolveKnownNodes()]);
      const decoded = await wallet.decodeLightning(record.invoice);
      payeePubkey = decoded.payeePubkey;
    }
  } catch {
    /* Best-effort channel/node enrichment for payment telemetry. */
  }
  const matchedChannel =
    channels.find(ch => payeePubkey && ch.peerNodeId?.toLocaleLowerCase() === payeePubkey.toLocaleLowerCase()) ??
    channels[0];
  const peerNodeId = matchedChannel?.peerNodeId ?? payeePubkey ?? null;
  const peerAlias =
    (peerNodeId && known.find(n => n.pubkey.toLocaleLowerCase() === peerNodeId.toLocaleLowerCase())?.alias) ?? null;
  const out = matchedChannel?.outboundMsat ? BigInt(matchedChannel.outboundMsat) : null;
  const inb = matchedChannel?.inboundMsat ? BigInt(matchedChannel.inboundMsat) : null;
  const outboundRatioPct = out !== null && inb !== null && out + inb > 0n ? Number((out * 100n) / (out + inb)) : null;

  await ragStore.ingestEpisode({
    id: `ep-pay-${record.id}`,
    timestamp: record.updatedAt,
    eventType: record.status === 'succeeded' ? 'payment_succeeded' : 'payment_failed',
    peerNodeId,
    peerAlias,
    channelId: matchedChannel?.channelId ?? null,
    amountMsat: record.amountMsat,
    assetId: record.assetId,
    assetAmount: record.assetAmount,
    routingAlgorithm: record.routing.algorithm,
    outcome: record.status,
    failureReason: record.status === 'failed' ? 'Payment routing or HTLC settlement failed' : null,
    outboundRatioPct,
    feeMsat: record.routing.max_fee_msat ?? null,
    notes: `Pagamento ${record.status} (${record.amountMsat} msat${record.assetId ? `, RGB ${record.assetId}` : ''}) con algoritmo ${record.routing.algorithm}.`,
  });
};
const payments = new PaymentStore(wallet.dataDir, wallet, recordPaymentEpisode);
const capabilities: RoutingCapabilities = Object.freeze({
  backendVersion: `ObvAstral/rgb-lightning-node@${sourceLock.node.commit.slice(0, 12)}/rust-lightning@${sourceLock.lightning.commit.slice(0, 12)}`, revision: 'rgb-mpp-1', hardFeeCap: true,
  hardNodeExclusion: true, hardChannelExclusion: false, perPaymentScoringProfile: true,
  avoidExtraProbing: true, canInspectFullRoute: true, canGuaranteeConstraintsAcrossRetries: true,
});
const resolveKnownNodes = async (custom?: unknown): Promise<{ alias: string; pubkey: string }[]> => {
  const map = new Map<string, { alias: string; pubkey: string }>();
  const add = (alias: unknown, pubkey: unknown) => {
    if (typeof alias !== 'string' || typeof pubkey !== 'string') return;
    const cleanAlias = alias.trim();
    const cleanPubkey = pubkey.trim().toLowerCase();
    if (!cleanAlias || !validNodeId(cleanPubkey)) return;
    map.set(cleanAlias.toLocaleLowerCase(), { alias: cleanAlias, pubkey: cleanPubkey });
  };
  for (const item of await wallet.knownNodes()) add(item.alias, item.pubkey);
  const activeFixture = ragStore.getActiveFixtureContext();
  if (activeFixture) {
    for (const item of activeFixture.knownNodes) add(item.alias, item.pubkey);
  }
  for (const peer of [{ alias: 'Alice', port: 8787 }, { alias: 'Bob', port: 8788 }]) {
    if (peer.port === port || map.has(peer.alias.toLocaleLowerCase())) continue;
    try {
      const baseUrl = `http://127.0.0.1:${peer.port}`;
      const sessionRes = await fetch(`${baseUrl}/api/session`, { signal: AbortSignal.timeout(400) });
      if (!sessionRes.ok) continue;
      const { token: peerToken } = await sessionRes.json() as { token?: string };
      if (!peerToken) continue;
      const summaryRes = await fetch(`${baseUrl}/api/wallet/summary`, {
        headers: { 'x-session-token': peerToken },
        signal: AbortSignal.timeout(400),
      });
      if (!summaryRes.ok) continue;
      const summary = await summaryRes.json() as { nodeId?: string };
      add(peer.alias, summary.nodeId);
    } catch {
      /* Ignore offline or locked peer service. */
    }
  }
  if (Array.isArray(custom)) {
    for (const item of custom) {
      if (item && typeof item === 'object') {
        const row = item as Record<string, unknown>;
        add(row.alias, row.pubkey);
      }
    }
  }
  return [...map.values()];
};
const validate = new Ajv({ allErrors: true, strict: true }).compile<ExtractedConstraints>(schema);
const json = (res: import('node:http').ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(data, (_key, value) => typeof value === 'bigint' ? value.toString() : value));
};
const webPort = Number(process.env.AIRGB_WEB_PORT ?? 5173);
const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://127.0.0.1:${webPort}`, `http://localhost:${webPort}`]);
const applyCors = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !allowedOrigins.has(origin)) return;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('access-control-allow-headers', 'content-type, x-session-token');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('vary', 'Origin');
};
const server = createServer(async (req, res) => {
  const host = req.headers.host;
  applyCors(req, res);
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return json(res, 403, { code: 'BAD_HOST' });
  if (req.headers.origin && !allowedOrigins.has(req.headers.origin)) return json(res, 403, { code: 'BAD_ORIGIN' });
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const path = new URL(req.url ?? '/', `http://${host}`).pathname;
  if (req.method === 'GET' && path === '/api/health') return json(res, 200, { api: 'ready', rln: wallet.ready ? 'ready' : 'locked', qvac: await checkQvacHealth(), network: 'regtest' });
  if (req.method === 'GET' && path === '/api/routing/capabilities') return json(res, 200, capabilities);
  if (req.method === 'GET' && path === '/api/session') return json(res, 200, { token });
  if (req.headers['x-session-token'] !== token || (req.headers.origin && !allowedOrigins.has(req.headers.origin)) || (req.method === 'POST' && !req.headers.origin)) return json(res, 403, { code: 'SESSION_REQUIRED' });
  let raw = '';
  try {
    if (req.method === 'GET') {
      if (path === '/api/wallet/state') return json(res, 200, await wallet.state());
      if (path === '/api/wallet/summary') return json(res, 200, await wallet.summary());
      if (path === '/api/wallet/channels') return json(res, 200, await wallet.channels());
      if (path === '/api/wallet/peers') return json(res, 200, await wallet.peers());
      if (path === '/api/routing/known-nodes') return json(res, 200, await resolveKnownNodes());
      if (path === '/api/routing/telemetry') {
        const episodes = ragStore.listEpisodes(30);
        const activeFixture = ragStore.getActiveFixtureContext();
        return json(res, 200, {
          vectorStoreId: ragStore.getSavedVectorStoreId(),
          ragBackend: 'qvac-turbovec',
          count: episodes.length,
          totalSqliteCount: ragStore.countEpisodes(),
          activeFixture: activeFixture
            ? {
                datasetId: activeFixture.datasetId,
                level: activeFixture.level,
                nodeId: activeFixture.nodeId,
                channelCount: activeFixture.channels.length,
              }
            : null,
          episodes,
        });
      }
      if (path === '/api/wallet/assets') return json(res, 200, await wallet.assets());
      if (path === '/api/wallet/asset-balance') {
        const assetId = new URL(req.url ?? '/', `http://${host}`).searchParams.get('assetId');
        return assetId ? json(res, 200, await wallet.assetBalance(assetId)) : json(res, 400, { code: 'INVALID_ASSET' });
      }
      if (path === '/api/wallet/history') return json(res, 200, await wallet.history());
      if (path === '/api/wallet/history/bitcoin') return json(res, 200, { source: 'rln-bitcoin', data: await wallet.bitcoinHistory() });
      if (path === '/api/wallet/history/rgb') {
        const assetId = new URL(req.url ?? '/', `http://${host}`).searchParams.get('assetId');
        return assetId ? json(res, 200, { source: 'rln-rgb', assetId, data: await wallet.rgbTransfers(assetId) }) : json(res, 400, { code: 'INVALID_ASSET' });
      }
      if (path === '/api/chain/status') return json(res, 200, { height: await chainHeight() });
      if (path === '/api/payments') return json(res, 200, wallet.ready ? await payments.listReconciled() : payments.list());
      if (path.startsWith('/api/payments/')) {
        const id = path.slice('/api/payments/'.length);
        const record = wallet.ready ? await payments.reconcile(id) : payments.get(id);
        return record ? json(res, 200, record) : json(res, 404, { code: 'INTENT_NOT_FOUND' });
      }
      return json(res, 404, { code: 'NOT_FOUND' });
    }
    if (req.method !== 'POST') return json(res, 404, { code: 'NOT_FOUND' });
    for await (const chunk of req) { raw += chunk; if (raw.length > 64000) return json(res, 413, { code: 'TOO_LARGE' }); }
    const body = JSON.parse(raw) as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { code: 'INVALID_JSON_OBJECT' });
    if (path === '/api/wallet/create' || path === '/api/wallet/import') {
      if (typeof body.password !== 'string' || (path.endsWith('/import') && typeof body.mnemonic !== 'string')) return json(res, 400, { code: 'INVALID_INPUT' });
      return json(res, 200, await wallet.create(body.password, path.endsWith('/import') ? body.mnemonic as string : undefined));
    }
    if (path === '/api/wallet/unlock') {
      if (typeof body.password !== 'string') return json(res, 400, { code: 'INVALID_INPUT' });
      await wallet.unlock(body.password);
      return json(res, 200, await wallet.state());
    }
    if (path === '/api/wallet/sync') {
      await wallet.refresh();
      return json(res, 200, { synced: true });
    }
    if (path === '/api/chain/mine') {
      if (typeof body.blocks !== 'number') return json(res, 400, { code: 'INVALID_INPUT' });
      return json(res, 200, await mineBlocks(body.blocks));
    }
    if (path === '/api/wallet/rgb/issue') {
      if (typeof body.ticker !== 'string' || typeof body.name !== 'string' || typeof body.precision !== 'number' || !Array.isArray(body.amounts) || body.amounts.some(amount => typeof amount !== 'number')) return json(res, 400, { code: 'INVALID_INPUT' });
      return json(res, 200, await wallet.issueNia({ ticker: body.ticker, name: body.name, precision: body.precision, amounts: body.amounts as number[] }));
    }
    if (path === '/api/wallet/rgb/utxos') {
      if (typeof body.count !== 'number' || typeof body.sizeSat !== 'string' || typeof body.feeRateSatPerVbyte !== 'string') return json(res, 400, { code: 'INVALID_INPUT' });
      return json(res, 200, await wallet.prepareRgbUtxos({ count: body.count, sizeSat: body.sizeSat, feeRateSatPerVbyte: body.feeRateSatPerVbyte }));
    }
    if (path === '/api/wallet/receive/lightning') {
      if (typeof body.amountMsat !== 'string' || typeof body.expirySec !== 'number') return json(res, 400, { code: 'INVALID_INPUT' });
      return json(res, 200, await wallet.createLightningInvoice({ amountMsat: body.amountMsat, expirySec: body.expirySec, assetId: typeof body.assetId === 'string' ? body.assetId : undefined, assetAmount: typeof body.assetAmount === 'string' ? body.assetAmount : undefined }));
    }
    if (path === '/api/wallet/receive/rgb') {
      if ((body.assetId !== null && typeof body.assetId !== 'string') || (body.amount !== null && typeof body.amount !== 'string') || typeof body.expirySec !== 'number') return json(res, 400, { code: 'INVALID_INPUT' });
      return json(res, 200, await wallet.createRgbInvoice({ assetId: body.assetId, amount: body.amount, expirySec: body.expirySec }));
    }
    if (path === '/api/wallet/peers/connect') {
      if (typeof body.peer !== 'string') return json(res, 400, { code: 'INVALID_INPUT' });
      return json(res, 200, await wallet.connectPeer(body.peer));
    }
    if (path === '/api/wallet/channels/open') {
      if (typeof body.peer !== 'string' || typeof body.capacitySat !== 'string') return json(res, 400, { code: 'INVALID_INPUT' });
      const optNumOrStr = (val: unknown): number | string | undefined =>
        typeof val === 'number' || typeof val === 'string' ? val : undefined;
      return json(
        res,
        200,
        await wallet.openChannel({
          peer: body.peer,
          capacitySat: body.capacitySat,
          public: body.public === true,
          withAnchors: typeof body.withAnchors === 'boolean' ? body.withAnchors : typeof body.with_anchors === 'boolean' ? body.with_anchors : undefined,
          pushMsat: optNumOrStr(body.pushMsat ?? body.push_msat),
          pushAssetAmount: optNumOrStr(body.pushAssetAmount ?? body.push_asset_amount),
          feeBaseMsat: optNumOrStr(body.feeBaseMsat ?? body.fee_base_msat),
          feeProportionalMillionths: optNumOrStr(body.feeProportionalMillionths ?? body.fee_proportional_millionths),
          assetId: typeof body.assetId === 'string' ? body.assetId : undefined,
          assetAmount: typeof body.assetAmount === 'string' ? body.assetAmount : undefined,
        }),
      );
    }
    if (path === '/api/payments/decode') {
      if (typeof body.invoice !== 'string') return json(res, 400, { code: 'INVALID_INPUT' });
      return json(res, 200, await wallet.decodeLightning(body.invoice));
    }
    if (path === '/api/wallet/receive/lightning/status') {
      if (typeof body.invoice !== 'string') return json(res, 400, { code: 'INVALID_INPUT' });
      return json(res, 200, { source: 'rln-lightning', data: await wallet.invoiceStatus(body.invoice) });
    }
    if (path === '/api/payments/prepare') {
      if (typeof body.id !== 'string' || typeof body.invoice !== 'string') return json(res, 400, { code: 'INVALID_INPUT' });
      return json(res, 200, await payments.prepare({ id: body.id, invoice: body.invoice, amountMsat: typeof body.amountMsat === 'string' ? body.amountMsat : undefined, constraints: body.constraints, routing: body.routing }));
    }
    if (path === '/api/payments/confirm') {
      if (typeof body.id !== 'string') return json(res, 400, { code: 'INVALID_INPUT' });
      return json(res, 200, await payments.confirm(body.id));
    }
    if (path === '/api/constraints/interpret') {
      if (typeof body.text !== 'string') return json(res, 400, { code: 'INVALID_TEXT' });
      return json(res, 200, await interpretWithQvac(body.text));
    }
    if (path === '/api/routing/telemetry/seed') {
      const channels = wallet.ready ? await wallet.channels() : [];
      const knownNodes = await resolveKnownNodes(body.knownNodes);
      return json(res, 200, await ragStore.seedDemoEpisodes({ channels, knownNodes }));
    }
    if (path === '/api/routing/telemetry/load-fixture') {
      const level = Number(body.level) as SyntheticHistoryLevel;
      const nodeId = typeof body.nodeId === 'string' ? body.nodeId : '';
      const maxRagIngest = typeof body.maxRagIngest === 'number' ? body.maxRagIngest : undefined;
      return json(
        res,
        200,
        await ragStore.loadSyntheticNodeHistory({
          level,
          nodeId,
          maxRagIngest,
        }),
      );
    }
    if (path === '/api/routing/score-channels' || path === '/api/routing/select-algorithm') {
      let amountMsat = typeof body.amountMsat === 'string' ? body.amountMsat : null;
      let assetId = typeof body.assetId === 'string' ? body.assetId : null;
      let assetAmount = typeof body.assetAmount === 'string' ? body.assetAmount : null;
      let payeePubkey = typeof body.payeePubkey === 'string' ? body.payeePubkey : null;
      if (typeof body.invoice === 'string' && body.invoice.trim() && wallet.ready) {
        const decoded = await wallet.decodeLightning(body.invoice.trim());
        amountMsat = decoded.amountMsat ?? amountMsat;
        assetId = decoded.assetId ?? assetId;
        assetAmount = decoded.assetAmount ?? assetAmount;
        payeePubkey = decoded.payeePubkey ?? payeePubkey;
      }
      if (!amountMsat || !/^[1-9][0-9]*$/.test(amountMsat)) {
        return json(res, 422, { code: 'INVALID_AMOUNT', message: 'Importo in msat richiesto per valutare i canali' });
      }
      let liveChannels: LiveChannelInput[] = [];
      if (Array.isArray(body.channels)) {
        liveChannels = body.channels as LiveChannelInput[];
      } else if (wallet.ready) {
        liveChannels = await wallet.channels();
      }
      if (liveChannels.length === 0 && ragStore.getActiveFixtureContext()) {
        liveChannels = ragStore.getActiveFixtureContext()!.channels;
      }
      const knownNodes = await resolveKnownNodes(body.knownNodes);
      const compiledPolicy = parseCompiledPolicy(body.constraints);
      const userPreference = typeof body.userPreference === 'string' ? body.userPreference.slice(0, 500) : null;
      const scoringInput = {
        amountMsat,
        assetId,
        assetAmount,
        payeePubkey,
        userPreference,
        compiledPolicy,
        channels: liveChannels,
        knownNodes,
      };
      if (path === '/api/routing/select-algorithm') {
        return json(res, 200, await selectRoutingAlgorithmWithQvac(scoringInput, ragStore));
      }
      return json(res, 200, await scoreChannelsWithQvac(scoringInput, ragStore));
    }
    if (path !== '/api/constraints/compile') return json(res, 404, { code: 'NOT_FOUND' });
    if (!validate(body.extracted)) return json(res, 400, { code: 'INVALID_SCHEMA' });
    const payment = body.payment as PaymentDraft;
    if (!payment || typeof payment !== 'object' || typeof payment.invoice !== 'string' || typeof payment.amount !== 'string' || typeof payment.assetId !== 'string') return json(res, 400, { code: 'INVALID_PAYMENT' });
    if (!/^[1-9][0-9]*$/.test(payment.amount) || BigInt(payment.amount) > BigInt(Number.MAX_SAFE_INTEGER)) return json(res, 422, { code: 'INVALID_AMOUNT', message: 'Importo Lightning in msat non valido' });
    const decoded = await wallet.decodeLightning(payment.invoice);
    const amount = BigInt(payment.amount).toString();
    if (decoded.amountMsat !== null && decoded.amountMsat !== amount) return json(res, 422, { code: 'AMOUNT_MISMATCH', message: 'Importo diverso dalla invoice' });
    if ((decoded.assetId ?? 'BTC') !== payment.assetId) return json(res, 422, { code: 'ASSET_MISMATCH', message: 'Asset diverso dalla invoice' });
    const canonical: PaymentDraft = { invoice: decoded.invoice, amount, assetId: decoded.assetId ?? 'BTC', network: decoded.network };
    const knownNodes = await resolveKnownNodes(body.knownNodes);
    return json(res, 200, compileConstraints({ extracted: body.extracted, payment: canonical, capabilities, knownNodes, payeePubkey: decoded.payeePubkey }));
  } catch (error) {
    if (error instanceof WalletError || error instanceof VaultError || error instanceof RlnError) return json(res, 422, { code: error.code, message: error.message });
    if (error instanceof InterpretationError) return json(res, 422, { code: error.code, message: error.message });
    if (error instanceof SyntaxError) return json(res, 400, { code: 'INVALID_JSON' });
    return json(res, 503, { code: 'RLN_UNAVAILABLE', message: 'Operazione RLN non disponibile; verificare i servizi regtest e il log locale' });
  }
});
server.listen(port, bindHost, () => console.log(`AIR-GB local service: http://127.0.0.1:${port}`));
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void wallet.shutdown().catch(error => {
    console.error('Shutdown RLN non riuscito:', error instanceof Error ? error.message : 'errore sconosciuto');
    process.exitCode = 1;
  }).finally(() => { payments.close(); ragStore.close(); server.close(); });
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
