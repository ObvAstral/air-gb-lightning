import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';
import channelScoreSchema from '../../packages/contracts/channel-score.schema.json' with { type: 'json' };
import type {
  ChannelClassification,
  ChannelClassifierOutput,
  ChannelScoreEntry,
  ChannelScoreProfile,
  ChannelScoringResult,
  CompiledPolicy,
  ObjectiveWeights,
  PaymentRouting,
  RagTelemetryHit,
  TelemetryEpisode,
} from '../../packages/contracts/types.js';
import { validNodeId } from '../../packages/policy/compile.js';
import { InterpretationError } from './interpret.js';

const ajv = new Ajv({ allErrors: true, strict: true });
const validateClassifier = ajv.compile<ChannelClassifierOutput>(channelScoreSchema);

const VECTOR_STORE_NAME = 'airgb-channel-telemetry';

export type LiveChannelInput = {
  channelId: string | null;
  peerNodeId: string | null;
  assetId: string | null;
  capacitySat: string | null;
  outboundMsat: string | null;
  inboundMsat: string | null;
  assetLocalAmount: string | null;
  assetRemoteAmount: string | null;
  isUsable: boolean | null;
  public?: boolean | null;
};

export type ScoreChannelsInput = {
  amountMsat: string;
  assetId?: string | null;
  assetAmount?: string | null;
  payeePubkey?: string | null;
  userPreference?: string | null;
  compiledPolicy?: CompiledPolicy | null;
  channels: LiveChannelInput[];
  knownNodes: { alias: string; pubkey: string }[];
};

const SCORER_SYSTEM_PROMPT = [
  'Classifica i canali Lightning/RGB in base a liquidità, asset RGB, preferenza utente e storico RAG.',
  'Classi ammesse: optimal, good, congested, insufficient_liquidity, unreliable, avoid.',
  'Sii conciso: reason max 10 parole, summary max 15 parole. Rispondi solo in JSON secondo lo schema.',
].join(' ');

export function formatTelemetryDocument(episode: TelemetryEpisode): string {
  const assetLabel = episode.assetId
    ? `RGB asset ${episode.assetId} (amount ${episode.assetAmount ?? '0'})`
    : 'BTC native Lightning';
  const peerLabel = episode.peerAlias
    ? `${episode.peerAlias} (${episode.peerNodeId ?? 'unknown-pubkey'})`
    : (episode.peerNodeId ?? 'unknown-peer');
  const ratioLabel = episode.outboundRatioPct !== null ? `${episode.outboundRatioPct}%` : 'n/a';
  const feeLabel = episode.feeMsat !== null ? `${episode.feeMsat} msat` : 'n/a';
  const failureLabel = episode.failureReason ? ` Failure: ${episode.failureReason}.` : '';
  return [
    `[TELEMETRY ${episode.id}] Event=${episode.eventType} Outcome=${episode.outcome} Peer=${peerLabel} Channel=${episode.channelId ?? 'n/a'}.`,
    `Payment=${episode.amountMsat} msat over ${assetLabel} using algorithm=${episode.routingAlgorithm}.`,
    `OutboundLiquidityRatio=${ratioLabel} Fee=${feeLabel}.${failureLabel}`,
    `Notes: ${episode.notes}`,
  ].join(' ');
}

function getQvacBaseUrl(): URL {
  const base = new URL(process.env.QVAC_URL ?? 'http://127.0.0.1:11434');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.protocol !== 'http:') {
    throw new InterpretationError('QVAC_CONFIG', 'QVAC deve essere sul loopback HTTP');
  }
  return base;
}

export class QvacRagStore {
  private db: DatabaseSync;
  private verifiedVectorStoreId: string | null = null;

  constructor(directory: string, private vectorStoreName = VECTOR_STORE_NAME) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, 'payments.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS scoring_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS scoring_episodes (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        peer_node_id TEXT,
        peer_alias TEXT,
        channel_id TEXT,
        amount_msat TEXT NOT NULL,
        asset_id TEXT,
        asset_amount TEXT,
        routing_algorithm TEXT NOT NULL,
        outcome TEXT NOT NULL,
        failure_reason TEXT,
        outbound_ratio_pct INTEGER,
        fee_msat INTEGER,
        notes TEXT NOT NULL,
        file_id TEXT,
        vector_store_id TEXT
      );
    `);
  }

  getSavedVectorStoreId(): string | null {
    const row = this.db.prepare('SELECT value FROM scoring_meta WHERE key = ?').get('vector_store_id') as { value?: string } | undefined;
    return row?.value ?? null;
  }

  private setSavedVectorStoreId(id: string): void {
    this.db.prepare('INSERT OR REPLACE INTO scoring_meta (key, value) VALUES (?, ?)').run('vector_store_id', id);
  }

  listEpisodes(limit = 50): (TelemetryEpisode & { fileId: string | null; vectorStoreId: string | null })[] {
    const rows = this.db.prepare('SELECT * FROM scoring_episodes ORDER BY timestamp DESC, id DESC LIMIT ?').all(limit) as Record<string, unknown>[];
    return rows.map(row => ({
      id: String(row.id),
      timestamp: Number(row.timestamp),
      eventType: row.event_type as TelemetryEpisode['eventType'],
      peerNodeId: (row.peer_node_id as string | null) ?? null,
      peerAlias: (row.peer_alias as string | null) ?? null,
      channelId: (row.channel_id as string | null) ?? null,
      amountMsat: String(row.amount_msat),
      assetId: (row.asset_id as string | null) ?? null,
      assetAmount: (row.asset_amount as string | null) ?? null,
      routingAlgorithm: String(row.routing_algorithm),
      outcome: row.outcome as TelemetryEpisode['outcome'],
      failureReason: (row.failure_reason as string | null) ?? null,
      outboundRatioPct: row.outbound_ratio_pct !== null && row.outbound_ratio_pct !== undefined ? Number(row.outbound_ratio_pct) : null,
      feeMsat: row.fee_msat !== null && row.fee_msat !== undefined ? Number(row.fee_msat) : null,
      notes: String(row.notes),
      fileId: (row.file_id as string | null) ?? null,
      vectorStoreId: (row.vector_store_id as string | null) ?? null,
    }));
  }

  saveEpisodeLocal(episode: TelemetryEpisode, fileId: string | null = null, vectorStoreId: string | null = null): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO scoring_episodes (
        id, timestamp, event_type, peer_node_id, peer_alias, channel_id,
        amount_msat, asset_id, asset_amount, routing_algorithm, outcome,
        failure_reason, outbound_ratio_pct, fee_msat, notes, file_id, vector_store_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      episode.id,
      episode.timestamp,
      episode.eventType,
      episode.peerNodeId,
      episode.peerAlias,
      episode.channelId,
      episode.amountMsat,
      episode.assetId,
      episode.assetAmount,
      episode.routingAlgorithm,
      episode.outcome,
      episode.failureReason,
      episode.outboundRatioPct,
      episode.feeMsat,
      episode.notes,
      fileId,
      vectorStoreId,
    );
  }

  async ensureVectorStore(signal?: AbortSignal): Promise<string> {
    if (this.verifiedVectorStoreId) return this.verifiedVectorStoreId;
    const base = getQvacBaseUrl();
    const savedId = this.getSavedVectorStoreId();
    const listRes = await fetch(new URL('/v1/vector_stores', base), {
      method: 'GET',
      signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
    });
    if (!listRes.ok) {
      throw new InterpretationError('AI_HTTP', `QVAC vector_stores list HTTP ${listRes.status}`);
    }
    const listBody = (await listRes.json()) as { data?: { id?: string; name?: string | null }[] };
    const stores = Array.isArray(listBody.data) ? listBody.data : [];

    if (savedId) {
      const matchSaved = stores.find(s => s.id === savedId);
      if (matchSaved?.id) {
        this.verifiedVectorStoreId = matchSaved.id;
        return matchSaved.id;
      }
    }
    const matchNamed = stores.find(s => s.name === this.vectorStoreName || s.id === this.vectorStoreName);
    if (matchNamed?.id) {
      this.setSavedVectorStoreId(matchNamed.id);
      this.verifiedVectorStoreId = matchNamed.id;
      return matchNamed.id;
    }

    const createRes = await fetch(new URL('/v1/vector_stores', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
      body: JSON.stringify({
        name: this.vectorStoreName,
        metadata: { app: 'air-gb-lightning', feature: 'channel-scoring' },
      }),
    });
    if (!createRes.ok) {
      throw new InterpretationError('AI_HTTP', `QVAC vector_stores create HTTP ${createRes.status}`);
    }
    const created = (await createRes.json()) as { id?: string };
    if (typeof created.id !== 'string' || !created.id) {
      throw new InterpretationError('AI_MALFORMED_RESPONSE', 'ID vector_store QVAC mancante');
    }
    this.setSavedVectorStoreId(created.id);
    this.verifiedVectorStoreId = created.id;
    return created.id;
  }

  async ingestEpisode(episode: TelemetryEpisode, signal?: AbortSignal): Promise<{ fileId: string | null; vectorStoreId: string | null }> {
    const existing = this.db.prepare('SELECT file_id, vector_store_id FROM scoring_episodes WHERE id = ?').get(episode.id) as
      | { file_id?: string | null; vector_store_id?: string | null }
      | undefined;
    const savedVsId = this.getSavedVectorStoreId();
    if (existing?.file_id && existing.vector_store_id && existing.vector_store_id === savedVsId) {
      return { fileId: existing.file_id, vectorStoreId: existing.vector_store_id };
    }

    this.saveEpisodeLocal(episode, null, null);

    try {
      const base = getQvacBaseUrl();
      const vectorStoreId = await this.ensureVectorStore(signal);
      const docText = formatTelemetryDocument(episode);
      const filename = `${episode.id}.txt`;

      const form = new FormData();
      form.append('purpose', 'assistants');
      form.append('file', new Blob([docText], { type: 'text/plain; charset=utf-8' }), filename);

      const uploadRes = await fetch(new URL('/v1/files', base), {
        method: 'POST',
        signal: AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])]),
        body: form,
      });
      if (!uploadRes.ok) {
        throw new InterpretationError('AI_HTTP', `QVAC /v1/files HTTP ${uploadRes.status}`);
      }
      const uploaded = (await uploadRes.json()) as { id?: string };
      if (typeof uploaded.id !== 'string' || !uploaded.id) {
        throw new InterpretationError('AI_MALFORMED_RESPONSE', 'ID file QVAC mancante');
      }

      const attachRes = await fetch(new URL(`/v1/vector_stores/${encodeURIComponent(vectorStoreId)}/files`, base), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]),
        body: JSON.stringify({ file_id: uploaded.id }),
      });
      if (!attachRes.ok) {
        throw new InterpretationError('AI_HTTP', `QVAC vector_store attach HTTP ${attachRes.status}`);
      }

      this.saveEpisodeLocal(episode, uploaded.id, vectorStoreId);
      return { fileId: uploaded.id, vectorStoreId };
    } catch {
      return { fileId: null, vectorStoreId: this.getSavedVectorStoreId() };
    }
  }

  async searchEpisodes(query: string, topK = 5, signal?: AbortSignal): Promise<{ vectorStoreId: string | null; hits: RagTelemetryHit[] }> {
    const cleanQuery = query.trim() || 'Lightning RGB channel payment reliability liquidity';
    try {
      const base = getQvacBaseUrl();
      const vectorStoreId = await this.ensureVectorStore(signal);
      const res = await fetch(new URL(`/v1/vector_stores/${encodeURIComponent(vectorStoreId)}/search`, base), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.any([AbortSignal.timeout(25000), ...(signal ? [signal] : [])]),
        body: JSON.stringify({
          query: cleanQuery,
          max_num_results: Math.max(1, Math.min(10, topK)),
        }),
      });
      if (res.ok) {
        const body = (await res.json()) as {
          data?: {
            file_id?: string;
            filename?: string;
            score?: number;
            content?: { type?: string; text?: string }[];
          }[];
        };
        const hits: RagTelemetryHit[] = (Array.isArray(body.data) ? body.data : [])
          .map(item => ({
            fileId: typeof item.file_id === 'string' ? item.file_id : 'unknown',
            filename: typeof item.filename === 'string' ? item.filename : 'telemetry.txt',
            score: typeof item.score === 'number' && Number.isFinite(item.score) ? Number(item.score.toFixed(4)) : 0,
            text: Array.isArray(item.content) && typeof item.content[0]?.text === 'string' ? item.content[0].text : '',
          }))
          .filter(hit => hit.text.length > 0);
        if (hits.length > 0) {
          return { vectorStoreId, hits };
        }
      }
    } catch {
      /* Fallback to local episode matching if QVAC search fails or workspace has not been populated yet. */
    }

    // Rank the complete local history before taking top-K; LIMIT 20 loses
    // relevant older episodes as soon as a wallet accumulates more history.
    const local = this.listEpisodes(-1);
    const terms = cleanQuery.toLocaleLowerCase().split(/\W+/).filter(t => t.length > 2);
    const scored = local
      .map(ep => {
        const text = formatTelemetryDocument(ep);
        const lower = text.toLocaleLowerCase();
        const matches = terms.reduce((acc, term) => acc + (lower.includes(term) ? 1 : 0), 0);
        const score = terms.length > 0 ? Number((matches / terms.length).toFixed(4)) : 0.5;
        return {
          fileId: ep.fileId ?? ep.id,
          filename: `${ep.id}.txt`,
          score,
          text,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return { vectorStoreId: this.getSavedVectorStoreId(), hits: scored };
  }

  async seedDemoEpisodes(
    context: { channels: LiveChannelInput[]; knownNodes: { alias: string; pubkey: string }[] },
    signal?: AbortSignal,
  ): Promise<{ seededCount: number; vectorStoreId: string | null; episodes: TelemetryEpisode[] }> {
    const primaryChannel = context.channels[0];
    const secondaryChannel = context.channels[1] ?? context.channels[0];
    const bobNode = context.knownNodes.find(n => n.alias.toLocaleLowerCase() === 'bob') ?? context.knownNodes[0];
    const primaryPeerPubkey = primaryChannel?.peerNodeId ?? bobNode?.pubkey ?? '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5';
    const primaryPeerAlias =
      context.knownNodes.find(n => n.pubkey.toLocaleLowerCase() === primaryPeerPubkey.toLocaleLowerCase())?.alias ?? 'Bob';
    const primaryChannelId = primaryChannel?.channelId ?? 'ch-bob-primary-01';
    const primaryAssetId = primaryChannel?.assetId ?? 'rgb:2eVw8uw-9bf88LQ-T357192-G12422M-749193s-n39485';
    const secondaryChannelId =
      secondaryChannel && secondaryChannel.channelId !== primaryChannelId
        ? secondaryChannel.channelId!
        : 'ch-congested-edge-02';
    const secondaryPeerPubkey =
      secondaryChannel && secondaryChannel.peerNodeId && secondaryChannel.peerNodeId !== primaryPeerPubkey
        ? secondaryChannel.peerNodeId
        : '02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9';

    const now = Date.now();
    const demoEpisodes: TelemetryEpisode[] = [
      {
        id: 'ep-demo-rgb-success-01',
        timestamp: now - 3600_000 * 6,
        eventType: 'payment_succeeded',
        peerNodeId: primaryPeerPubkey,
        peerAlias: primaryPeerAlias,
        channelId: primaryChannelId,
        amountMsat: '3000000',
        assetId: primaryAssetId,
        assetAmount: '15',
        routingAlgorithm: 'multi_objective',
        outcome: 'succeeded',
        failureReason: null,
        outboundRatioPct: 78,
        feeMsat: 120,
        notes: `Pagamento RGB verso ${primaryPeerAlias} completato al primo tentativo su ${primaryChannelId}; ottima liquidità outbound e latenza minima.`,
      },
      {
        id: 'ep-demo-rgb-success-02',
        timestamp: now - 3600_000 * 4,
        eventType: 'payment_succeeded',
        peerNodeId: primaryPeerPubkey,
        peerAlias: primaryPeerAlias,
        channelId: primaryChannelId,
        amountMsat: '3000000',
        assetId: primaryAssetId,
        assetAmount: '25',
        routingAlgorithm: 'multi_objective',
        outcome: 'succeeded',
        failureReason: null,
        outboundRatioPct: 72,
        feeMsat: 150,
        notes: `Secondo trasferimento RGB su ${primaryChannelId} con ${primaryPeerAlias} riuscito senza retry né probing extra.`,
      },
      {
        id: 'ep-demo-btc-lowfee-03',
        timestamp: now - 3600_000 * 3,
        eventType: 'payment_succeeded',
        peerNodeId: primaryPeerPubkey,
        peerAlias: primaryPeerAlias,
        channelId: primaryChannelId,
        amountMsat: '4500000',
        assetId: null,
        assetAmount: null,
        routingAlgorithm: 'ldk_dijkstra',
        outcome: 'succeeded',
        failureReason: null,
        outboundRatioPct: 68,
        feeMsat: 85,
        notes: `Pagamento BTC Lightning rapido su ${primaryChannelId} (${primaryPeerAlias}) con commissioni basse e saldo ben bilanciato.`,
      },
      {
        id: 'ep-demo-congested-fail-04',
        timestamp: now - 3600_000 * 2,
        eventType: 'payment_failed',
        peerNodeId: secondaryPeerPubkey,
        peerAlias: 'Carol-Relay',
        channelId: secondaryChannelId,
        amountMsat: '8000000',
        assetId: primaryAssetId,
        assetAmount: '50',
        routingAlgorithm: 'yen',
        outcome: 'failed',
        failureReason: 'TemporaryChannelFailure: outbound RGB liquidity exhausted on hop',
        outboundRatioPct: 14,
        feeMsat: null,
        notes: `Fallimento ripetuto su ${secondaryChannelId} (Carol-Relay): liquidità outbound scesa al 14% e HTLC RGB rifiutato.`,
      },
      {
        id: 'ep-demo-anomaly-probe-05',
        timestamp: now - 3600_000,
        eventType: 'channel_anomaly',
        peerNodeId: secondaryPeerPubkey,
        peerAlias: 'Carol-Relay',
        channelId: secondaryChannelId,
        amountMsat: '5000000',
        assetId: null,
        assetAmount: null,
        routingAlgorithm: 'min_cost_flow',
        outcome: 'degraded',
        failureReason: 'High fee spike and HTLC timeout during MPP split',
        outboundRatioPct: 11,
        feeMsat: 9500,
        notes: `Anomalia su ${secondaryChannelId}: spike di commissioni (9500 msat) e latenza elevata durante probing multi-path; preferire percorsi ad alta affidabilità.`,
      },
    ];

    let lastVsId: string | null = null;
    for (const ep of demoEpisodes) {
      const res = await this.ingestEpisode(ep, signal);
      if (res.vectorStoreId) lastVsId = res.vectorStoreId;
    }

    return {
      seededCount: demoEpisodes.length,
      vectorStoreId: lastVsId ?? this.getSavedVectorStoreId(),
      episodes: demoEpisodes,
    };
  }

  close(): void {
    this.db.close();
  }
}

function computeOutboundRatioPct(channel: LiveChannelInput): number | null {
  const out = channel.outboundMsat ? BigInt(channel.outboundMsat) : null;
  const inb = channel.inboundMsat ? BigInt(channel.inboundMsat) : null;
  if (out !== null && inb !== null && out + inb > 0n) {
    return Number((out * 100n) / (out + inb));
  }
  const capSat = channel.capacitySat ? BigInt(channel.capacitySat) : null;
  if (out !== null && capSat !== null && capSat > 0n) {
    const capMsat = capSat * 1000n;
    return Math.min(100, Number((out * 100n) / capMsat));
  }
  return null;
}

function deterministicChannelFallback(
  channel: LiveChannelInput,
  index: number,
  input: ScoreChannelsInput,
  aliasMap: Map<string, string>,
): ChannelScoreEntry {
  const channelId = channel.channelId ?? `channel-${index + 1}`;
  const peerNodeId = channel.peerNodeId ?? 'unknown-peer';
  const peerAlias = aliasMap.get(peerNodeId.toLocaleLowerCase()) ?? null;
  const reqMsat = BigInt(input.amountMsat || '0');
  const outMsat = channel.outboundMsat ? BigInt(channel.outboundMsat) : 0n;
  const ratioPct = computeOutboundRatioPct(channel);
  const needsRgb = Boolean(input.assetId);
  const reqAssetAmt = input.assetAmount ? BigInt(input.assetAmount) : 0n;
  const localAssetAmt = channel.assetLocalAmount ? BigInt(channel.assetLocalAmount) : 0n;

  if (channel.isUsable === false) {
    return {
      channelId,
      peerNodeId,
      peerAlias,
      classification: 'avoid',
      score: 5,
      reason: 'Canale non utilizzabile (peer disconnesso o canale non pronto).',
      outboundMsat: channel.outboundMsat,
      inboundMsat: channel.inboundMsat,
      assetId: channel.assetId,
      assetLocalAmount: channel.assetLocalAmount,
      isUsable: channel.isUsable,
    };
  }

  if (outMsat < reqMsat) {
    return {
      channelId,
      peerNodeId,
      peerAlias,
      classification: 'insufficient_liquidity',
      score: 20,
      reason: `Liquidità outbound (${outMsat} msat) inferiore all’importo richiesto (${reqMsat} msat).`,
      outboundMsat: channel.outboundMsat,
      inboundMsat: channel.inboundMsat,
      assetId: channel.assetId,
      assetLocalAmount: channel.assetLocalAmount,
      isUsable: channel.isUsable,
    };
  }

  if (needsRgb && (channel.assetId !== input.assetId || localAssetAmt < reqAssetAmt)) {
    return {
      channelId,
      peerNodeId,
      peerAlias,
      classification: 'insufficient_liquidity',
      score: 25,
      reason: `Saldo RGB locale insufficiente o contract ID non corrispondente (${localAssetAmt} < ${reqAssetAmt}).`,
      outboundMsat: channel.outboundMsat,
      inboundMsat: channel.inboundMsat,
      assetId: channel.assetId,
      assetLocalAmount: channel.assetLocalAmount,
      isUsable: channel.isUsable,
    };
  }

  if (ratioPct !== null && ratioPct < 25) {
    return {
      channelId,
      peerNodeId,
      peerAlias,
      classification: 'congested',
      score: 55,
      reason: `Canale utilizzabile ma con rapporto di liquidità outbound basso (${ratioPct}%).`,
      outboundMsat: channel.outboundMsat,
      inboundMsat: channel.inboundMsat,
      assetId: channel.assetId,
      assetLocalAmount: channel.assetLocalAmount,
      isUsable: channel.isUsable,
    };
  }

  if (ratioPct !== null && ratioPct >= 60) {
    return {
      channelId,
      peerNodeId,
      peerAlias,
      classification: 'optimal',
      score: 92,
      reason: `Ampia liquidità outbound (${ratioPct}%)${needsRgb ? ` e copertura RGB (${localAssetAmt} unità)` : ''} verificata.`,
      outboundMsat: channel.outboundMsat,
      inboundMsat: channel.inboundMsat,
      assetId: channel.assetId,
      assetLocalAmount: channel.assetLocalAmount,
      isUsable: channel.isUsable,
    };
  }

  return {
    channelId,
    peerNodeId,
    peerAlias,
    classification: 'good',
    score: 78,
    reason: `Canale attivo e capiente per ${reqMsat} msat.`,
    outboundMsat: channel.outboundMsat,
    inboundMsat: channel.inboundMsat,
    assetId: channel.assetId,
    assetLocalAmount: channel.assetLocalAmount,
    isUsable: channel.isUsable,
  };
}

function normalizeScoreForClass(
  classification: ChannelClassification,
  rawScore: number | null,
  fallbackScore: number,
): number {
  const ranges: Record<ChannelClassification, [number, number, number]> = {
    optimal: [80, 100, 92],
    good: [65, 85, 78],
    congested: [35, 60, 48],
    unreliable: [20, 45, 32],
    insufficient_liquidity: [10, 30, 20],
    avoid: [0, 15, 5],
  };
  const [min, max, def] = ranges[classification];
  const candidate = rawScore !== null && rawScore > 0 ? rawScore : (fallbackScore >= min && fallbackScore <= max ? fallbackScore : def);
  return Math.max(min, Math.min(max, Math.round(candidate)));
}

function defaultWeightsForProfile(profile: ChannelScoreProfile): ObjectiveWeights {
  switch (profile) {
    case 'fee_saver':
      return { fee: 120, reliability: 25, cltv: 5, hops: 10 };
    case 'high_reliability':
      return { fee: 10, reliability: 150, cltv: 10, hops: 20 };
    case 'liquidity_preserving':
      return { fee: 35, reliability: 90, cltv: 10, hops: 25 };
    case 'single_path_privacy':
      return { fee: 20, reliability: 100, cltv: 15, hops: 80 };
    case 'balanced':
    default:
      return { fee: 40, reliability: 60, cltv: 10, hops: 20 };
  }
}

function inferProfileFromPreference(pref: string | null | undefined, policy?: CompiledPolicy | null): ChannelScoreProfile | null {
  if (policy?.soft.privacyPreference === 'avoid_extra_probing') return 'single_path_privacy';
  if (policy?.soft.priority === 'lowest_fee') return 'fee_saver';
  if (policy?.soft.priority === 'reliability') return 'high_reliability';
  if (!pref) return null;
  const text = pref.toLocaleLowerCase();
  if (/(?:privac|probing|singol|single)/i.test(text)) return 'single_path_privacy';
  if (/(?:risparm|fee|econom|commission|cheap|low cost)/i.test(text)) return 'fee_saver';
  if (/(?:affidabil|reliab|sicur|garant|stabi)/i.test(text)) return 'high_reliability';
  if (/(?:liquidit|bilanc|preserv)/i.test(text)) return 'liquidity_preserving';
  if (/(?:balanced|equilibr)/i.test(text)) return 'balanced';
  return null;
}

export function sanitizeAndValidateChannelScore(
  raw: unknown,
  input: ScoreChannelsInput,
  ragHits: RagTelemetryHit[],
): {
  overallProfile: ChannelScoreProfile;
  recommendedWeights: ObjectiveWeights;
  channels: ChannelScoreEntry[];
  excludedNodeIds: string[];
  recommendedRouting: PaymentRouting;
  summary: string;
} {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new InterpretationError('AI_EMPTY', 'QVAC ha restituito una risposta di scoring vuota');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InterpretationError('AI_MALFORMED_JSON', 'JSON QVAC channel scoring non valido');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InterpretationError('AI_SCHEMA', 'Oggetto JSON di scoring non valido');
  }

  const obj = parsed as Record<string, unknown>;
  obj.schemaVersion = '1.0';

  const validProfiles: ChannelScoreProfile[] = [
    'balanced',
    'fee_saver',
    'high_reliability',
    'liquidity_preserving',
    'single_path_privacy',
  ];
  const preferredProfile = inferProfileFromPreference(input.userPreference, input.compiledPolicy);
  if (preferredProfile) {
    obj.overallProfile = preferredProfile;
  } else if (!validProfiles.includes(obj.overallProfile as ChannelScoreProfile)) {
    obj.overallProfile = input.assetId ? 'high_reliability' : 'balanced';
  }

  const profile = obj.overallProfile as ChannelScoreProfile;
  const fallbackWeights = defaultWeightsForProfile(profile);
  const rawWeights = obj.recommendedWeights && typeof obj.recommendedWeights === 'object' && !Array.isArray(obj.recommendedWeights)
    ? (obj.recommendedWeights as Record<string, unknown>)
    : {};
  const clampWeight = (val: unknown, def: number): number => {
    const n = typeof val === 'number' && Number.isFinite(val) ? Math.round(val) : def;
    return Math.max(1, Math.min(1000, n));
  };
  obj.recommendedWeights = preferredProfile
    ? fallbackWeights
    : {
        fee: clampWeight(rawWeights.fee, fallbackWeights.fee),
        reliability: clampWeight(rawWeights.reliability, fallbackWeights.reliability),
        cltv: clampWeight(rawWeights.cltv, fallbackWeights.cltv),
        hops: clampWeight(rawWeights.hops, fallbackWeights.hops),
      };

  const aliasMap = new Map<string, string>();
  for (const node of input.knownNodes) {
    aliasMap.set(node.pubkey.toLocaleLowerCase(), node.alias);
  }

  const validClasses: ChannelClassification[] = [
    'optimal',
    'good',
    'congested',
    'insufficient_liquidity',
    'unreliable',
    'avoid',
  ];

  const rawChannels = Array.isArray(obj.channels)
    ? obj.channels.filter((value): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value))
    : [];
  const normalizedChannels: ChannelScoreEntry[] = input.channels.map((live, idx) => {
    const fallback = deterministicChannelFallback(live, idx, input, aliasMap);
    const match = rawChannels.find(
      rc =>
        (typeof rc.channelId === 'string' && rc.channelId === fallback.channelId) ||
        (typeof rc.peerNodeId === 'string' && rc.peerNodeId.toLocaleLowerCase() === fallback.peerNodeId.toLocaleLowerCase()),
    );
    if (!match) return fallback;

    let classification: ChannelClassification = validClasses.includes(match.classification as ChannelClassification)
      ? (match.classification as ChannelClassification)
      : fallback.classification;
    const rawScore = typeof match.score === 'number' && Number.isFinite(match.score)
      ? Math.max(0, Math.min(100, Math.round(match.score)))
      : null;
    let score = normalizeScoreForClass(classification, rawScore, fallback.score);
    let reason = typeof match.reason === 'string' && match.reason.trim().length > 0
      ? match.reason.trim().slice(0, 120)
      : fallback.reason.slice(0, 120);

    // Enforce physical hard constraints so LLM cannot mark an unusable or underfunded channel as optimal/good
    if (fallback.classification === 'avoid' || fallback.classification === 'insufficient_liquidity') {
      classification = fallback.classification;
      score = fallback.score;
      reason = fallback.reason.slice(0, 120);
    }

    return {
      ...fallback,
      classification,
      score,
      reason,
    };
  });

  obj.channels = normalizedChannels.map(ch => ({
    channelId: ch.channelId,
    peerNodeId: ch.peerNodeId,
    classification: ch.classification,
    score: ch.score,
    reason: ch.reason,
  }));

  if (typeof obj.summary !== 'string' || !obj.summary.trim()) {
    obj.summary = `Valutati ${normalizedChannels.length} canali con ${ragHits.length} episodi RAG (${profile}).`;
  } else {
    obj.summary = obj.summary.trim().slice(0, 160);
  }

  if (!validateClassifier(obj)) {
    throw new InterpretationError('AI_SCHEMA', `Schema scoring non valido: ${ajv.errorsText(validateClassifier.errors)}`);
  }

  // Derive safe node exclusions: only exclude peers whose channels are ALL 'avoid',
  // and NEVER exclude the destination payeePubkey!
  const payeeLower = input.payeePubkey?.toLocaleLowerCase() ?? null;
  const peerChannels = new Map<string, ChannelScoreEntry[]>();
  for (const ch of normalizedChannels) {
    if (!validNodeId(ch.peerNodeId)) continue;
    const key = ch.peerNodeId.toLocaleLowerCase();
    const list = peerChannels.get(key) ?? [];
    list.push(ch);
    peerChannels.set(key, list);
  }

  const excludedSet = new Set<string>(
    (input.compiledPolicy?.hard.excludedNodeIds ?? []).map(id => id.toLocaleLowerCase()),
  );
  for (const [peerPubkey, list] of peerChannels.entries()) {
    if (payeeLower && peerPubkey === payeeLower) continue;
    if (list.length > 0 && list.every(ch => ch.classification === 'avoid')) {
      excludedSet.add(peerPubkey);
    }
  }
  if (payeeLower) excludedSet.delete(payeeLower);

  const excludedNodeIds = [...excludedSet];
  const recommendedRouting: PaymentRouting = {
    algorithm: 'multi_objective',
    weights: obj.recommendedWeights,
    ...(input.compiledPolicy?.hard.maxRoutingFeeMsat
      ? { max_fee_msat: Number(input.compiledPolicy.hard.maxRoutingFeeMsat) }
      : {}),
    ...(excludedNodeIds.length > 0 ? { excluded_nodes: excludedNodeIds } : {}),
    ...(profile === 'single_path_privacy' || input.compiledPolicy?.soft.privacyPreference === 'avoid_extra_probing'
      ? { max_paths: 1 }
      : {}),
  };

  return {
    overallProfile: obj.overallProfile,
    recommendedWeights: obj.recommendedWeights,
    channels: normalizedChannels,
    excludedNodeIds,
    recommendedRouting,
    summary: obj.summary,
  };
}

export async function scoreChannelsWithQvac(
  input: ScoreChannelsInput,
  ragStore: QvacRagStore,
  signal?: AbortSignal,
): Promise<ChannelScoringResult> {
  if (!/^[1-9][0-9]*$/.test(input.amountMsat)) {
    throw new InterpretationError('INVALID_AMOUNT', 'amountMsat deve essere un intero positivo');
  }
  const base = getQvacBaseUrl();
  const model = process.env.QVAC_MODEL;
  if (!model) throw new InterpretationError('QVAC_CONFIG', 'Impostare QVAC_MODEL');

  const started = performance.now();

  const peerNames = input.knownNodes.map(n => n.alias).join(' ');
  const ragQuery = [
    input.assetId ? `RGB asset ${input.assetId}` : 'BTC Lightning payment',
    `amount ${input.amountMsat} msat`,
    peerNames,
    input.userPreference ?? '',
    'channel liquidity reliability failure fee',
  ]
    .filter(Boolean)
    .join(' ');

  const { vectorStoreId, hits: ragHits } = await ragStore.searchEpisodes(ragQuery, 4, signal);

  const aliasMap = new Map<string, string>();
  for (const node of input.knownNodes) {
    aliasMap.set(node.pubkey.toLocaleLowerCase(), node.alias);
  }

  const telemetryPayload = {
    payment: {
      amountMsat: input.amountMsat,
      asset: input.assetId ? 'RGB' : 'BTC',
      assetAmount: input.assetAmount ?? null,
      preference: input.userPreference ?? 'balanced',
    },
    channels: input.channels.map((ch, idx) => ({
      channelId: ch.channelId ?? `channel-${idx + 1}`,
      peerNodeId: ch.peerNodeId ?? 'unknown-peer',
      peerAlias: ch.peerNodeId ? (aliasMap.get(ch.peerNodeId.toLocaleLowerCase()) ?? null) : null,
      outboundRatioPct: computeOutboundRatioPct(ch),
      isUsable: ch.isUsable,
      canCoverMsat: ch.outboundMsat ? BigInt(ch.outboundMsat) >= BigInt(input.amountMsat) : false,
      canCoverAsset: !input.assetId
        ? true
        : ch.assetId === input.assetId &&
          BigInt(ch.assetLocalAmount ?? '0') >= BigInt(input.assetAmount ?? '0'),
    })),
    ragHistory: ragHits.slice(0, 3).map(h => ({
      score: h.score,
      summary: h.text.slice(0, 220),
    })),
  };

  const candidateChannelIds = input.channels.map((ch, idx) => ch.channelId ?? `channel-${idx + 1}`);
  const dynamicInferenceSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'overallProfile', 'recommendedWeights', 'channels', 'summary'],
    properties: {
      schemaVersion: { const: '1.0' },
      overallProfile: {
        enum: ['balanced', 'fee_saver', 'high_reliability', 'liquidity_preserving', 'single_path_privacy'],
      },
      recommendedWeights: {
        type: 'object',
        additionalProperties: false,
        required: ['fee', 'reliability', 'cltv', 'hops'],
        properties: {
          fee: { type: 'integer', minimum: 1, maximum: 1000 },
          reliability: { type: 'integer', minimum: 1, maximum: 1000 },
          cltv: { type: 'integer', minimum: 1, maximum: 1000 },
          hops: { type: 'integer', minimum: 1, maximum: 1000 },
        },
      },
      channels: {
        type: 'array',
        minItems: candidateChannelIds.length,
        maxItems: Math.max(1, candidateChannelIds.length),
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['channelId', 'classification', 'score', 'reason'],
          properties: {
            channelId: candidateChannelIds.length > 0 ? { enum: candidateChannelIds } : { type: 'string', maxLength: 64 },
            classification: {
              enum: ['optimal', 'good', 'congested', 'insufficient_liquidity', 'unreliable', 'avoid'],
            },
            score: { type: 'integer', minimum: 0, maximum: 100 },
            reason: { type: 'string', minLength: 1, maxLength: 48 },
          },
        },
      },
      summary: { type: 'string', minLength: 1, maxLength: 64 },
    },
  };

  let response: Response;
  try {
    response = await fetch(new URL('/v1/chat/completions', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.any([AbortSignal.timeout(60000), ...(signal ? [signal] : [])]),
      body: JSON.stringify({
        model,
        stream: false,
        temperature: 0,
        max_tokens: 512,
        reasoning_budget: false,
        messages: [
          { role: 'system', content: SCORER_SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(telemetryPayload) },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'channel_scoring_classifier',
            strict: true,
            schema: dynamicInferenceSchema,
          },
        },
      }),
    });
  } catch (error) {
    throw new InterpretationError(
      (error as Error).name === 'TimeoutError' ? 'AI_TIMEOUT' : 'AI_UNAVAILABLE',
      'QVAC non raggiungibile o scaduto durante lo scoring dei canali',
    );
  }

  if (!response.ok) throw new InterpretationError('AI_HTTP', `QVAC HTTP ${response.status}`);
  if (Number(response.headers.get('content-length') ?? 0) > 30000) {
    throw new InterpretationError('AI_TOO_LARGE', 'Risposta QVAC troppo grande');
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new InterpretationError('AI_MALFORMED_RESPONSE', 'Risposta HTTP QVAC non valida');
  }
  const choice = (body as { choices?: { finish_reason?: string; message?: { content?: unknown } }[] }).choices?.[0];
  if (choice?.finish_reason === 'length') throw new InterpretationError('AI_TRUNCATED', 'Output QVAC troncato');
  if (choice?.finish_reason !== 'stop') throw new InterpretationError('AI_INCOMPLETE', 'QVAC non ha completato la risposta');

  const validated = sanitizeAndValidateChannelScore(choice.message?.content, input, ragHits);

  return {
    schemaVersion: '1.0',
    vectorStoreId,
    ragBackend: 'qvac-turbovec',
    overallProfile: validated.overallProfile,
    recommendedWeights: validated.recommendedWeights,
    recommendedRouting: validated.recommendedRouting,
    excludedNodeIds: validated.excludedNodeIds,
    channels: validated.channels,
    ragHits,
    summary: validated.summary,
    latencyMs: Math.round(performance.now() - started),
  };
}
