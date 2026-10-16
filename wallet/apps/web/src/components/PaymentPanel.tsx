import { useCallback, useEffect, useState } from 'react';
import { useNodeSession } from './node-client.js';
import { ROUTING_ALGORITHMS, type RoutingAlgorithm, type ObjectiveWeights, type PaymentRouting } from '../../../../packages/contracts/types.js';

const RGB_HTLC_MINIMUM_MSAT = '3000000';

type WalletState = { node: string; sendEnabled: boolean };
type Decoded = { invoice: string; paymentHash: string; amountMsat: string | null; assetId: string | null; assetAmount: string | null; expiresAt: number; payeePubkey: string | null };
type Intent = { id: string; paymentHash: string; amountMsat: string; assetId: string | null; status: string; routing: PaymentRouting };
type NativePayment = { paymentHash: string | null; status: string; amountMsat: string | null; assetId: string | null; assetAmount: string | null };

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
  const [intent, setIntent] = useState<Intent | null>(null);
  const [history, setHistory] = useState<NativePayment[]>([]);

  const refresh = useCallback(async () => {
    if (!token) return;
    const next = await api<WalletState>('/api/wallet/state');
    setState(next);
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
      <label>Invoice Lightning regtest<textarea value={sendInvoice} onChange={event => { setSendInvoice(event.target.value); setDecoded(null); setIntent(null); }} /></label>
      <label>msat, solo se la invoice non ha importo<input value={sendAmount} onChange={event => { setSendAmount(event.target.value); setDecoded(null); setIntent(null); }} inputMode="numeric" /></label>
      <label>Algoritmo di routing<select disabled={busy || intent !== null} value={algorithm} onChange={event => setAlgorithm(event.target.value as RoutingAlgorithm)}>
        {ROUTING_ALGORITHMS.map(value => <option key={value} value={value}>{value}</option>)}
      </select></label>
      {algorithm === 'multi_objective' && <div className="row">
        {(['fee', 'reliability', 'cltv', 'hops'] as const).map(key => <label key={key}>Peso {key}<input type="number" min="0" max="1000000" step="1" disabled={busy || intent !== null} value={weights[key]} onChange={event => setWeights(previous => ({ ...previous, [key]: Number(event.target.value) }))} /></label>)}
      </div>}
      <button disabled={busy || !sendInvoice} onClick={() => void action(async () => setDecoded(await api<Decoded>('/api/payments/decode', { invoice: sendInvoice })))}>Decodifica</button>
      {decoded && <div>
        <dl>
          <dt>Payment hash</dt><dd>{decoded.paymentHash}</dd>
          <dt>Importo</dt><dd>{decoded.amountMsat ?? `${sendAmount || 'da indicare'} msat`}</dd>
          <dt>Asset</dt><dd>{decoded.assetId ?? 'BTC'} {decoded.assetAmount ?? ''}</dd>
          <dt>Scadenza</dt><dd>{new Date(decoded.expiresAt).toLocaleString()}</dd>
        </dl>
        <button disabled={busy} onClick={() => void action(async () => {
          const id = crypto.randomUUID();
          const routing: PaymentRouting = algorithm === 'multi_objective' ? { algorithm, weights } : { algorithm };
          setIntent(await api<Intent>('/api/payments/prepare', { id, invoice: decoded.invoice, ...(sendAmount ? { amountMsat: sendAmount } : {}), constraints: {}, routing }));
        })}>Prepara</button>
      </div>}
      {intent && <div className="notice">
        <p>Intento {intent.id}: {intent.status}. {intent.amountMsat} msat{intent.assetId ? ` · ${intent.assetId}` : ''}. Algoritmo: {intent.routing.algorithm}.</p>
        <button disabled={busy || intent.status !== 'prepared' || !state?.sendEnabled} onClick={() => void action(async () => { setIntent(await api<Intent>('/api/payments/confirm', { id: intent.id })); await refresh(); })}>Conferma invio</button>
        <button disabled={busy} onClick={() => void action(async () => setIntent(await api<Intent>(`/api/payments/${intent.id}`)))}>Aggiorna stato</button>
      </div>}
      <h3>Storico Lightning</h3>
      {history.length ? <ul>{history.map((payment, index) => <li key={`${payment.paymentHash ?? 'unknown'}-${index}`}>{payment.status} · {payment.amountMsat ?? '?'} msat · {payment.assetId ?? 'BTC'}{payment.assetAmount ? ` · ${payment.assetAmount}` : ''}</li>)}</ul> : <p>Nessun pagamento.</p>}
    </>}
    {message && <p className="notice" role="status">{message}</p>}
  </section>;
}
