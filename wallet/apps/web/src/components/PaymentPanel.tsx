import { useCallback, useEffect, useState } from 'react';
import { useNodeSession } from './node-client.js';
import {
  ROUTING_ALGORITHMS,
  type AlgorithmSelectionResult,
  type ChannelScoringResult,
  type CompileResult,
  type ExtractedConstraints,
  type FixtureLoadResult,
  type RoutingAlgorithm,
  type ObjectiveWeights,
  type PaymentRouting,
  type SyntheticHistoryLevel,
} from '../../../../packages/contracts/types.js';

const RGB_HTLC_MINIMUM_MSAT = '3000000';
const SYNTHETIC_NODES = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi', 'ivan', 'judy'] as const;
const SYNTHETIC_LEVELS: SyntheticHistoryLevel[] = [20, 100, 500, 2000];

type WalletState = { node: string; sendEnabled: boolean };
type Decoded = { invoice: string; paymentHash: string; amountMsat: string | null; assetId: string | null; assetAmount: string | null; expiresAt: number; payeePubkey: string | null };
type Intent = { id: string; paymentHash: string; amountMsat: string; assetId: string | null; status: string; routing: PaymentRouting };
type NativePayment = { paymentHash: string | null; status: string; amountMsat: string | null; assetId: string | null; assetAmount: string | null };
type TelemetryStatus = {
  vectorStoreId: string | null;
  ragBackend: string;
  count: number;
  totalSqliteCount?: number;
  activeFixture?: { datasetId: string; level: SyntheticHistoryLevel; nodeId: string; channelCount: number } | null;
};

type PaymentPanelProps = { label: string; baseUrl: string };

export function PaymentPanel({ label, baseUrl }: PaymentPanelProps) {
  const { token, offline, api } = useNodeSession(baseUrl);
  const [state, setState] = useState<WalletState | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [receiveAmount, setReceiveAmount] = useState(RGB_HTLC_MINIMUM_MSAT);
  const [receiveAssetId, setReceiveAssetId] = useState('');
  const [receiveAssetAmount, setReceiveAssetAmount] = useState('10');
  const [receivedInvoice, setReceivedInvoice] = useState('');
  const [invoiceStatus, setInvoiceStatus] = useState<unknown>(null);
  const [sendInvoice, setSendInvoice] = useState('');
  const [sendAmount, setSendAmount] = useState('');
  const [algorithm, setAlgorithm] = useState<RoutingAlgorithm>('ldk_dijkstra');
  const [weights, setWeights] = useState<ObjectiveWeights>({ fee: 1, reliability: 2, cltv: 1, hops: 10 });
  const [decoded, setDecoded] = useState<Decoded | null>(null);
  const [constraintText, setConstraintText] = useState('');
  const [compileResult, setCompileResult] = useState<CompileResult | null>(null);
  const [qvacLatencyMs, setQvacLatencyMs] = useState<number | null>(null);
  const [channelScore, setChannelScore] = useState<ChannelScoringResult | null>(null);
  const [algorithmSelection, setAlgorithmSelection] = useState<AlgorithmSelectionResult | null>(null);
  const [fixtureNodeId, setFixtureNodeId] = useState<string>(label.toLowerCase() === 'bob' ? 'bob' : 'alice');
  const [fixtureLevel, setFixtureLevel] = useState<SyntheticHistoryLevel>(100);
  const [telemetryStatus, setTelemetryStatus] = useState<TelemetryStatus | null>(null);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [history, setHistory] = useState<NativePayment[]>([]);

  const refresh = useCallback(async () => {
    if (!token) return;
    const next = await api<WalletState>('/api/wallet/state');
    setState(next);
    const tel = await api<TelemetryStatus>('/api/routing/telemetry').catch(() => null);
    if (tel) setTelemetryStatus(tel);
    if (next.node === 'ready') setHistory(await api<NativePayment[]>('/api/wallet/history'));
  }, [api, token]);

  useEffect(() => { void refresh().catch(error => setMessage((error as Error).message)); }, [refresh]);

  async function action(task: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try { await task(); } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); }
  }

  const ready = state?.node === 'ready';
  return <section>
    <h2>Pagamento {label}</h2>
    {offline && <p className="error" role="alert">Nodo non raggiungibile.</p>}
    {ready && <>
      <h3>Invoice RGB Lightning</h3>
      <p>Minimo HTLC di questa versione: {RGB_HTLC_MINIMUM_MSAT} msat.</p>
      <div className="row">
        <label>msat<input value={receiveAmount} onChange={event => { setReceiveAmount(event.target.value); setReceivedInvoice(''); }} inputMode="numeric" /></label>
        <label>Contract ID<input value={receiveAssetId} onChange={event => { setReceiveAssetId(event.target.value); setReceivedInvoice(''); }} /></label>
        <label>Unità RGB<input value={receiveAssetAmount} onChange={event => { setReceiveAssetAmount(event.target.value); setReceivedInvoice(''); }} inputMode="numeric" /></label>
      </div>
      <button disabled={busy || !receiveAssetId || !receiveAssetAmount || !receiveAmount} onClick={() => void action(async () => {
        const created = await api<{ invoice: string }>('/api/wallet/receive/lightning', { amountMsat: receiveAmount, expirySec: 3600, assetId: receiveAssetId, assetAmount: receiveAssetAmount });
        setReceivedInvoice(created.invoice);
        setInvoiceStatus(null);
      })}>Crea invoice</button>
      {receivedInvoice && <label>Invoice<textarea readOnly value={receivedInvoice} /></label>}
      {receivedInvoice && <button disabled={busy} onClick={() => void action(async () => setInvoiceStatus(await api('/api/wallet/receive/lightning/status', { invoice: receivedInvoice })))}>Stato invoice</button>}
      {invoiceStatus !== null && <pre>{JSON.stringify(invoiceStatus, null, 2)}</pre>}
      <h3>Invia</h3>
      <label>Invoice Lightning regtest<textarea value={sendInvoice} onChange={event => { setSendInvoice(event.target.value); setDecoded(null); setCompileResult(null); setChannelScore(null); setAlgorithmSelection(null); setIntent(null); }} /></label>
      <label>msat, solo se la invoice non ha importo<input value={sendAmount} onChange={event => { setSendAmount(event.target.value); setDecoded(null); setCompileResult(null); setChannelScore(null); setAlgorithmSelection(null); setIntent(null); }} inputMode="numeric" /></label>
      <label>Algoritmo di routing<select disabled={busy || intent !== null} value={algorithm} onChange={event => setAlgorithm(event.target.value as RoutingAlgorithm)}>
        {ROUTING_ALGORITHMS.map(value => <option key={value} value={value}>{value}</option>)}
      </select></label>
      {algorithm === 'multi_objective' && <div className="row">
        {(['fee', 'reliability', 'cltv', 'hops'] as const).map(key => <label key={key}>Peso {key}<input type="number" min="0" max="1000000" step="1" disabled={busy || intent !== null} value={weights[key]} onChange={event => setWeights(previous => ({ ...previous, [key]: Number(event.target.value) }))} /></label>)}
      </div>}
      <button disabled={busy || !sendInvoice} onClick={() => void action(async () => {
        setCompileResult(null);
        setChannelScore(null);
        setAlgorithmSelection(null);
        setIntent(null);
        setDecoded(await api<Decoded>('/api/payments/decode', { invoice: sendInvoice }));
      })}>Decodifica</button>
      {decoded && <div>
        <dl>
          <dt>Payment hash</dt><dd>{decoded.paymentHash}</dd>
          <dt>Importo</dt><dd>{decoded.amountMsat ?? `${sendAmount || 'da indicare'} msat`}</dd>
          <dt>Asset</dt><dd>{decoded.assetId ?? 'BTC'} {decoded.assetAmount ?? ''}</dd>
          <dt>Scadenza</dt><dd>{new Date(decoded.expiresAt).toLocaleString()}</dd>
        </dl>
        <label>Vincoli in linguaggio naturale (opzionale, via QVAC)
          <input value={constraintText} disabled={busy || intent !== null} onChange={event => { setConstraintText(event.target.value); setCompileResult(null); }} placeholder="Es. Massimo 10 sat di commissioni, evita Bob" maxLength={1000} />
        </label>
        <div className="row">
          <button disabled={busy || intent !== null || !constraintText.trim()} onClick={() => void action(async () => {
            const amount = decoded.amountMsat ?? sendAmount;
            if (!amount) throw new Error('Indicare prima l’importo in msat');
            const interpreted = await api<{ extracted: ExtractedConstraints; latencyMs: number }>('/api/constraints/interpret', { text: constraintText });
            setQvacLatencyMs(interpreted.latencyMs);
            const compiled = await api<CompileResult>('/api/constraints/compile', {
              extracted: interpreted.extracted,
              payment: { invoice: decoded.invoice, amount, assetId: decoded.assetId ?? 'BTC', network: 'regtest' },
            });
            setCompileResult(compiled);
            if (compiled.normalized?.priority === 'lowest_fee') {
              setAlgorithm('multi_objective');
              setWeights({ fee: 100, reliability: 10, cltv: 1, hops: 5 });
            } else if (compiled.normalized?.priority === 'reliability') {
              setAlgorithm('multi_objective');
              setWeights({ fee: 5, reliability: 100, cltv: 5, hops: 10 });
            }
          })}>Interpreta e compila vincoli (QVAC)</button>
          {compileResult && <button disabled={busy || intent !== null} onClick={() => { setCompileResult(null); setQvacLatencyMs(null); }}>Rimuovi vincoli</button>}
        </div>
        {compileResult && <div className="notice">
          <p><strong>Policy QVAC: {compileResult.code}</strong> ({compileResult.status}){qvacLatencyMs !== null ? ` · ${qvacLatencyMs} ms` : ''}</p>
          {compileResult.normalized && <p>Fee max: {compileResult.normalized.maxRoutingFeeMsat ?? 'nessun limite'} msat · Nodi esclusi: {compileResult.normalized.excludedNodeIds.join(', ') || 'nessuno'} · Priorità: {compileResult.normalized.priority} · Privacy: {compileResult.normalized.privacyPreference}</p>}
          {compileResult.issues.map((issue, idx) => <p key={idx} className="error">{issue}</p>)}
        </div>}
        <div className="row">
          <button disabled={busy || intent !== null} onClick={() => void action(async () => {
            const amount = decoded.amountMsat ?? sendAmount;
            if (!amount) throw new Error('Indicare prima l’importo in msat');
            const selected = await api<AlgorithmSelectionResult>('/api/routing/select-algorithm', {
              invoice: decoded.invoice,
              amountMsat: amount,
              assetId: decoded.assetId,
              assetAmount: decoded.assetAmount,
              payeePubkey: decoded.payeePubkey,
              userPreference: constraintText.trim() || undefined,
              constraints: compileResult?.policy ?? undefined,
            });
            setAlgorithmSelection(selected);
            setChannelScore(selected.channelScoring);
            setAlgorithm(selected.selectedAlgorithm);
            setWeights(selected.recommendedWeights);
            await refresh();
          })}>Scegli algoritmo + valuta canali (QVAC Feature 2+3)</button>
          <button disabled={busy} onClick={() => void action(async () => {
            await api('/api/routing/telemetry/seed', {});
            await refresh();
          })}>Popola telemetria RAG demo{telemetryStatus ? ` (${telemetryStatus.totalSqliteCount ?? telemetryStatus.count})` : ''}</button>
        </div>
        <div className="row">
          <label>Nodo fixture
            <select disabled={busy} value={fixtureNodeId} onChange={e => setFixtureNodeId(e.target.value)}>
              {SYNTHETIC_NODES.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label>Storico tx
            <select disabled={busy} value={fixtureLevel} onChange={e => setFixtureLevel(Number(e.target.value) as SyntheticHistoryLevel)}>
              {SYNTHETIC_LEVELS.map(lv => <option key={lv} value={lv}>{lv} tx</option>)}
            </select>
          </label>
          <button disabled={busy} onClick={() => void action(async () => {
            const loaded = await api<FixtureLoadResult>('/api/routing/telemetry/load-fixture', {
              nodeId: fixtureNodeId,
              level: fixtureLevel,
            });
            setMessage(`Caricato storico first-party per '${loaded.nodeId}' (${loaded.level} tx): ${loaded.loadedSqliteCount} episodi SQLite, ${loaded.ingestedRagCount} indicizzati in QVAC TurboVec.`);
            await refresh();
          })}>Carica storico nodo (first-party)</button>
        </div>
        {telemetryStatus?.activeFixture && <p className="notice">
          Fixture attiva: <strong>{telemetryStatus.activeFixture.nodeId}</strong> ({telemetryStatus.activeFixture.datasetId} · {telemetryStatus.activeFixture.channelCount} canali locali · {telemetryStatus.totalSqliteCount ?? telemetryStatus.count} episodi first-party)
        </p>}
        {algorithmSelection && <div className="notice">
          <p><strong>Feature 3 — Algoritmo scelto da QVAC: <code>{algorithmSelection.selectedAlgorithm}</code></strong> ({algorithmSelection.reasonCode}) · max_paths={algorithmSelection.recommendedRouting.max_paths ?? 1} · {algorithmSelection.latencyMs} ms</p>
          <p>{algorithmSelection.rationale}</p>
          <p>Fattibilità (RAM effimera rimossa: {algorithmSelection.feasibility.ephemeralRamWiped ? 'sì' : 'no'}): single-path={algorithmSelection.feasibility.singlePathPossible ? 'sì' : 'no'} · MPP={algorithmSelection.feasibility.mppPossible ? 'sì' : 'no'} · canali attivi={algorithmSelection.feasibility.usableChannelCount}</p>
        </div>}
        {channelScore && <div className="notice">
          <p><strong>Scoring QVAC ({channelScore.ragBackend}): profilo {channelScore.overallProfile}</strong> · {channelScore.latencyMs} ms{channelScore.vectorStoreId ? ` · store ${channelScore.vectorStoreId}` : ''}</p>
          <p>{channelScore.summary}</p>
          <p>Pesi consigliati: fee={channelScore.recommendedWeights.fee}, reliability={channelScore.recommendedWeights.reliability}, cltv={channelScore.recommendedWeights.cltv}, hops={channelScore.recommendedWeights.hops}</p>
          {channelScore.channels.length > 0 && <ul>
            {channelScore.channels.map(ch => <li key={ch.channelId}>
              <strong>[{ch.classification.toUpperCase()} · {ch.score}/100]</strong> {ch.peerAlias ? `${ch.peerAlias} (${ch.channelId})` : ch.channelId}: {ch.reason}
            </li>)}
          </ul>}
          {channelScore.ragHits.length > 0 && <details>
            <summary>Episodi storici recuperati via QVAC RAG ({channelScore.ragHits.length})</summary>
            <ul>
              {channelScore.ragHits.map((hit, idx) => <li key={`${hit.fileId}-${idx}`}>
                <code>score={hit.score}</code> {hit.text}
              </li>)}
            </ul>
          </details>}
        </div>}
        <button disabled={busy || (constraintText.trim().length > 0 && compileResult?.status !== 'validated')} onClick={() => void action(async () => {
          const id = crypto.randomUUID();
          const routingPatch = {
            ...(channelScore?.excludedNodeIds.length ? { excluded_nodes: channelScore.excludedNodeIds } : {}),
            ...(channelScore?.recommendedRouting.max_paths ? { max_paths: channelScore.recommendedRouting.max_paths } : {}),
          };
          const routing: PaymentRouting = algorithm === 'multi_objective'
            ? {
                algorithm,
                weights,
                ...routingPatch,
              }
            : {
                algorithm,
                ...routingPatch,
              };
          const constraints = compileResult?.policy ?? {};
          setIntent(await api<Intent>('/api/payments/prepare', { id, invoice: decoded.invoice, ...(sendAmount ? { amountMsat: sendAmount } : {}), constraints, routing }));
        })}>Prepara</button>
      </div>}
      {intent && <div className="notice">
        <p>Intento {intent.id}: {intent.status}. {intent.amountMsat} msat{intent.assetId ? ` · ${intent.assetId}` : ''}. Algoritmo: {intent.routing.algorithm}{intent.routing.max_fee_msat !== undefined ? ` · max fee: ${intent.routing.max_fee_msat} msat` : ''}{intent.routing.excluded_nodes?.length ? ` · esclusi: ${intent.routing.excluded_nodes.length}` : ''}.</p>
        <button disabled={busy || intent.status !== 'prepared' || !state?.sendEnabled} onClick={() => void action(async () => { setIntent(await api<Intent>('/api/payments/confirm', { id: intent.id })); await refresh(); })}>Conferma invio</button>
        <button disabled={busy} onClick={() => void action(async () => setIntent(await api<Intent>(`/api/payments/${intent.id}`)))}>Aggiorna stato</button>
      </div>}
      <h3>Storico Lightning</h3>
      {history.length ? <ul>{history.map((payment, index) => <li key={`${payment.paymentHash ?? 'unknown'}-${index}`}>{payment.status} · {payment.amountMsat ?? '?'} msat · {payment.assetId ?? 'BTC'}{payment.assetAmount ? ` · ${payment.assetAmount}` : ''}</li>)}</ul> : <p>Nessun pagamento.</p>}
    </>}
    {message && <p className="notice" role="status">{message}</p>}
  </section>;
}
