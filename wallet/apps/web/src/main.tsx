import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CompileResult, ExtractedConstraints, PaymentDraft } from '../../../packages/contracts/types.js';
import './style.css';
import { ChainControls } from './components/ChainControls.js';
import { PaymentPanel } from './components/PaymentPanel.js';
import { WalletCard } from './components/WalletCard.js';
import { ALICE_BASE_URL, BOB_BASE_URL } from './components/node-client.js';

const initial: ExtractedConstraints = { schemaVersion: '1.0', status: 'parsed', feeLimit: null, excludedNodeReferences: [], priority: null, privacyRequest: null, unhandledRequests: [] };
function App() {
  const [health, setHealth] = useState<Record<string, string>>({});
  const [token, setToken] = useState('');
  const [payment, setPayment] = useState<PaymentDraft>({ invoice: '', amount: '', assetId: 'BTC', network: 'regtest' });
  const [text, setText] = useState('');
  const [extracted, setExtracted] = useState<ExtractedConstraints>(initial);
  const [result, setResult] = useState<CompileResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [latency, setLatency] = useState<number | null>(null);
  const revision = useRef(0);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => { void Promise.all([fetch('/api/health').then(r => r.json()), fetch('/api/session').then(r => r.json())]).then(([h, s]) => { setHealth(h); setToken(s.token); }).catch(() => setError('Servizio locale non raggiungibile')); }, []);
  function invalidate() { revision.current++; controller.current?.abort(); setResult(null); setError(''); setLatency(null); setBusy(false); }
  function editPayment(key: keyof PaymentDraft, value: string) { invalidate(); setPayment(p => ({ ...p, [key]: value })); }
  function editConstraints(patch: Partial<ExtractedConstraints>) { invalidate(); setExtracted(v => ({ ...v, ...patch })); }
  async function call(path: string, body: unknown) {
    invalidate(); const own = revision.current; const abort = new AbortController(); controller.current = abort; setBusy(true);
    try {
      const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-session-token': token }, body: JSON.stringify(body), signal: abort.signal });
      const data = await response.json();
      if (own !== revision.current) return;
      if (!response.ok) throw new Error(data.message ?? data.code);
      if (path.endsWith('interpret')) { setExtracted(data.extracted); setLatency(data.latencyMs); } else setResult(data);
    } catch (e) { if (own === revision.current && (e as Error).name !== 'AbortError') setError((e as Error).message); }
    finally { if (own === revision.current) setBusy(false); }
  }
  return <main>
    <header><div><p className="eyebrow">AIR-GB · REGTEST</p><h1>Wallet RGB Lightning</h1><p>Nodo locale RGB con MPP, pagamenti di test e anteprima dei vincoli.</p></div><div className="status">API: {health.api ?? 'offline'}<br/>RLN: {health.rln ?? 'sconosciuto'}<br/>QVAC: {health.qvac ?? 'sconosciuto'}</div></header>
    <ChainControls />
    <div className="nodes">
      <div><WalletCard label="Alice" baseUrl={ALICE_BASE_URL} /><PaymentPanel label="Alice" baseUrl={ALICE_BASE_URL} /></div>
      <div><WalletCard label="Bob" baseUrl={BOB_BASE_URL} /><PaymentPanel label="Bob" baseUrl={BOB_BASE_URL} /></div>
    </div>
    <section><h2>1. Pagamento di riferimento</h2><p>Il servizio decodifica la invoice con il nodo RGB e verifica importo, asset e rete prima di mostrare l’anteprima. Questo modulo non invia pagamenti.</p>
      <label>Invoice di test<input value={payment.invoice} onChange={e => editPayment('invoice', e.target.value)} placeholder="Invoice regtest" /></label>
      <div className="row"><label>Importo Lightning in msat<input value={payment.amount} onChange={e => editPayment('amount', e.target.value)} inputMode="numeric" placeholder="10000" /></label><label>Contract ID RGB / BTC<input value={payment.assetId} onChange={e => editPayment('assetId', e.target.value)} /></label></div>
    </section>
    <section><h2>2. Interpreta il testo con QVAC</h2><label>Come vuoi instradare questo pagamento?<textarea value={text} onChange={e => { invalidate(); setText(e.target.value); }} placeholder="Massimo 10 sat di fee, preferisco affidabilità" maxLength={1000} /></label><button onClick={() => void call('/api/constraints/interpret', { text })} disabled={!token || !text.trim() || busy}>Interpreta</button>{latency !== null && <small>Inferenza: {latency} ms</small>}</section>
    <section><h2>3. Controlla o inserisci i vincoli</h2><p>Il modulo manuale usa lo stesso contratto dell’estrazione AI.</p>
      <div className="row"><label>Budget fee<input value={extracted.feeLimit?.value ?? ''} onChange={e => editConstraints({ feeLimit: e.target.value ? { value: e.target.value, unit: extracted.feeLimit?.unit ?? 'sat', comparison: extracted.feeLimit?.comparison ?? 'lte' } : null })} placeholder="Nessun limite" /></label><label>Unità<select value={extracted.feeLimit?.unit ?? 'sat'} onChange={e => extracted.feeLimit && editConstraints({ feeLimit: { ...extracted.feeLimit, unit: e.target.value as 'sat' | 'msat' } })}><option>sat</option><option>msat</option></select></label><label>Confronto<select value={extracted.feeLimit?.comparison ?? 'lte'} onChange={e => extracted.feeLimit && editConstraints({ feeLimit: { ...extracted.feeLimit, comparison: e.target.value as 'lte' | 'lt' } })}><option value="lte">Massimo, incluso</option><option value="lt">Meno di</option></select></label></div>
      <label>Nodi da escludere, separati da virgola<input value={extracted.excludedNodeReferences.join(', ')} onChange={e => editConstraints({ excludedNodeReferences: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} placeholder="Pubkey o alias dal grafo verificato" /></label>
      <div className="row"><label>Priorità<select value={extracted.priority ?? ''} onChange={e => editConstraints({ priority: (e.target.value || null) as ExtractedConstraints['priority'] })}><option value="">Nessuna espressa</option><option value="lowest_fee">Costo</option><option value="reliability">Affidabilità</option><option value="balanced">Bilanciata</option></select></label><label>Privacy<select value={extracted.privacyRequest ?? ''} onChange={e => editConstraints({ privacyRequest: (e.target.value || null) as ExtractedConstraints['privacyRequest'] })}><option value="">Nessuna richiesta</option><option value="avoid_extra_probing">Evita probing aggiuntivo</option><option value="unspecified">Da precisare</option></select></label></div>
      {extracted.unhandledRequests.length > 0 && <p className="notice">Da chiarire: {extracted.unhandledRequests.join('; ')}</p>}
      <button onClick={() => { invalidate(); setExtracted(initial); }}>Riparti dal modulo manuale</button>
      <button onClick={() => void call('/api/constraints/compile', { payment, extracted })} disabled={!token || busy}>Valida e mostra anteprima</button>
    </section>
    {error && <aside role="alert" className="error">{error}</aside>}
    {result && <section className="result"><h2>Anteprima</h2><p><strong>{result.code}</strong> · {result.status}</p>{result.normalized && <dl><dt>Budget massimo</dt><dd>{result.normalized.maxRoutingFeeMsat ?? 'nessuno'} msat</dd><dt>Nodi esclusi</dt><dd>{result.normalized.excludedNodeIds.join(', ') || 'nessuno'}</dd><dt>Priorità</dt><dd>{result.normalized.priority}</dd><dt>Privacy</dt><dd>{result.normalized.privacyPreference}</dd></dl>}{result.issues.map((issue, i) => <p className="notice" key={i}>{issue}</p>)}<p>Invio disabilitato: nessun pagamento può partire da questa anteprima.</p></section>}
    <footer>Interpretazione QVAC, compilazione deterministica e enforcement routing RLN attivi.</footer>
  </main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
