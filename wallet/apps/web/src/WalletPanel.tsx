import { useCallback, useEffect, useState } from 'react';

type WalletState = { keystoreExists: boolean; node: string; network: string; sendEnabled: boolean };
type Summary = { address: string; nodeId: string; peerUri: string | null; btcSpendableSat: string };
type Decoded = { invoice: string; paymentHash: string; amountMsat: string | null; assetId: string | null; assetAmount: string | null; expiresAt: number; payeePubkey: string | null };
type Intent = { id: string; paymentHash: string; amountMsat: string; assetId: string | null; status: string };
type NativePayment = { paymentHash: string | null; status: string; amountMsat: string | null; assetId: string | null; assetAmount: string | null };

export function WalletPanel({ token }: { token: string }) {
  const [state, setState] = useState<WalletState | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [password, setPassword] = useState('');
  const [mnemonic, setMnemonic] = useState('');
  const [recovery, setRecovery] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [channels, setChannels] = useState<unknown[]>([]);
  const [assets, setAssets] = useState<unknown[]>([]);
  const [balanceAssetId, setBalanceAssetId] = useState('');
  const [assetBalance, setAssetBalance] = useState<unknown>(null);
  const [peers, setPeers] = useState<unknown[]>([]);
  const [peer, setPeer] = useState('');
  const [capacitySat, setCapacitySat] = useState('');
  const [channelAssetId, setChannelAssetId] = useState('');
  const [channelAssetAmount, setChannelAssetAmount] = useState('');
  const [channelPublic, setChannelPublic] = useState(false);
  const [receiveKind, setReceiveKind] = useState<'btc-lightning' | 'rgb-lightning' | 'rgb-onchain'>('btc-lightning');
  const [receiveAmount, setReceiveAmount] = useState('');
  const [receiveAssetId, setReceiveAssetId] = useState('');
  const [receiveAssetAmount, setReceiveAssetAmount] = useState('');
  const [receivedInvoice, setReceivedInvoice] = useState('');
  const [invoiceStatus, setInvoiceStatus] = useState<unknown>(null);
  const [bitcoinHistory, setBitcoinHistory] = useState<unknown>(null);
  const [rgbHistory, setRgbHistory] = useState<unknown>(null);
  const [sendInvoice, setSendInvoice] = useState('');
  const [sendAmount, setSendAmount] = useState('');
  const [decoded, setDecoded] = useState<Decoded | null>(null);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [history, setHistory] = useState<Intent[]>([]);
  const [lightningHistory, setLightningHistory] = useState<NativePayment[]>([]);
  const api = useCallback(async <T,>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-session-token': token }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
    const value = await response.json();
    if (!response.ok) throw new Error(value.message ?? value.code ?? `HTTP ${response.status}`);
    return value as T;
  }, [token]);
  const refresh = useCallback(async () => {
    if (!token) return;
    const next = await api<WalletState>('/api/wallet/state'); setState(next);
    if (next.node === 'ready') {
      const [info, channelsResult, assetsResult, peersResult, intents, nativePayments] = await Promise.all([
        api<Summary>('/api/wallet/summary'), api<unknown[]>('/api/wallet/channels'), api<unknown[]>('/api/wallet/assets'), api<unknown[]>('/api/wallet/peers'), api<Intent[]>('/api/payments'), api<NativePayment[]>('/api/wallet/history'),
      ]);
      setSummary(info); setChannels(channelsResult); setAssets(assetsResult); setPeers(peersResult); setHistory(intents); setLightningHistory(nativePayments);
    }
  }, [api, token]);
  useEffect(() => { void refresh().catch(error => setMessage((error as Error).message)); }, [refresh]);
  async function action(task: () => Promise<void>) { setBusy(true); setMessage(''); try { await task(); } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); } }
  const resetSend = () => { setDecoded(null); setIntent(null); };
  return <section>
    <h2>Wallet RGB Lightning</h2><p>Rete regtest · nodo locale WDK · account 0</p>
    <p><strong>Keystore:</strong> {state?.keystoreExists ? 'presente' : 'da creare'} · <strong>Nodo:</strong> {state?.node ?? 'non disponibile'} · <strong>Invio di test:</strong> {state?.sendEnabled ? 'abilitato' : 'disabilitato'}</p>
    {!state?.keystoreExists && <div>
      <label>Password del keystore<input type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} /></label>
      <button disabled={busy || password.length < 12} onClick={() => void action(async () => { const data = await api<{ recoveryPhrase: string | null }>('/api/wallet/create', { password }); setRecovery(data.recoveryPhrase); setPassword(''); await refresh(); })}>Crea wallet di test</button>
      <label>Oppure importa frase BIP39 di 12 parole<textarea value={mnemonic} onChange={e => setMnemonic(e.target.value)} autoComplete="off" /></label>
      <button disabled={busy || password.length < 12 || !mnemonic.trim()} onClick={() => void action(async () => { await api('/api/wallet/import', { password, mnemonic }); setMnemonic(''); setPassword(''); await refresh(); })}>Importa wallet di test</button>
    </div>}
    {recovery && <div className="notice"><strong>Salva la frase di recupero ora.</strong><p>{recovery}</p><p>Il seed non recupera da solo lo stato dei canali RGB Lightning.</p><button onClick={() => setRecovery(null)}>Ho salvato la frase</button></div>}
    {state?.keystoreExists && state.node !== 'ready' && <div><label>Password per sbloccare<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></label><button disabled={busy || !password} onClick={() => void action(async () => { await api('/api/wallet/unlock', { password }); setPassword(''); await refresh(); })}>Sblocca nodo</button></div>}
    {summary && <div><h3>Dashboard</h3><dl><dt>Node ID</dt><dd>{summary.nodeId}</dd><dt>Indirizzo BTC regtest</dt><dd>{summary.address}</dd><dt>BTC spendibili</dt><dd>{summary.btcSpendableSat} sat</dd>{summary.peerUri && <><dt>Indirizzo peer locale</dt><dd>{summary.peerUri}</dd></>}</dl><button disabled={busy} onClick={() => void action(refresh)}>Aggiorna dati</button></div>}
    {state?.node === 'ready' && <>
      <details><summary>Ricevi BTC Lightning o RGB</summary>
        <label>Tipo<select value={receiveKind} onChange={e => { setReceiveKind(e.target.value as typeof receiveKind); setReceivedInvoice(''); setInvoiceStatus(null); }}><option value="btc-lightning">BTC Lightning</option><option value="rgb-lightning">RGB Lightning</option><option value="rgb-onchain">RGB on-chain</option></select></label>
        <label>{receiveKind === 'rgb-onchain' ? 'Importo RGB in unità minime' : 'Importo Lightning in msat'}<input value={receiveAmount} onChange={e => { setReceiveAmount(e.target.value); setReceivedInvoice(''); setInvoiceStatus(null); }} inputMode="numeric" /></label>
        {receiveKind !== 'btc-lightning' && <label>Contract ID RGB<input value={receiveAssetId} onChange={e => { setReceiveAssetId(e.target.value); setReceivedInvoice(''); setInvoiceStatus(null); }} /></label>}
        {receiveKind === 'rgb-lightning' && <label>Importo RGB in unità minime<input value={receiveAssetAmount} onChange={e => { setReceiveAssetAmount(e.target.value); setReceivedInvoice(''); setInvoiceStatus(null); }} inputMode="numeric" /></label>}
        <button disabled={busy} onClick={() => void action(async () => {
          const response = receiveKind === 'rgb-onchain'
            ? await api<{ invoice: string }>('/api/wallet/receive/rgb', { assetId: receiveAssetId, amount: receiveAmount, expirySec: 3600 })
            : await api<{ invoice: string }>('/api/wallet/receive/lightning', { amountMsat: receiveAmount, expirySec: 3600, ...(receiveKind === 'rgb-lightning' ? { assetId: receiveAssetId, assetAmount: receiveAssetAmount } : {}) });
          setReceivedInvoice(response.invoice); setInvoiceStatus(null);
        })}>Genera invoice</button>
        {receivedInvoice && <label>Invoice generata<textarea readOnly value={receivedInvoice} /></label>}
        {receivedInvoice && receiveKind !== 'rgb-onchain' && <button disabled={busy} onClick={() => void action(async () => setInvoiceStatus(await api('/api/wallet/receive/lightning/status', { invoice: receivedInvoice })))}>Aggiorna stato invoice</button>}
        {invoiceStatus !== null && <pre>{JSON.stringify(invoiceStatus, null, 2)}</pre>}
      </details>
      <details><summary>Peer e canali</summary><p>Peer: {peers.length} · Canali: {channels.length} · Asset: {assets.length}</p>
        <label>Peer regtest, formato pubkey@host:porta<input value={peer} onChange={e => setPeer(e.target.value)} placeholder="02...@127.0.0.1:9736" /></label>
        <button disabled={busy || !peer} onClick={() => void action(async () => { await api('/api/wallet/peers/connect', { peer }); await refresh(); })}>Collega peer</button>
        <label>Capacità canale in sat<input value={capacitySat} onChange={e => setCapacitySat(e.target.value)} inputMode="numeric" /></label>
        <label>Contract ID RGB, opzionale<input value={channelAssetId} onChange={e => setChannelAssetId(e.target.value)} /></label>
        <label>Importo RGB, se presente<input value={channelAssetAmount} onChange={e => setChannelAssetAmount(e.target.value)} inputMode="numeric" /></label>
        <label><input type="checkbox" checked={channelPublic} onChange={e => setChannelPublic(e.target.checked)} /> Canale pubblico regtest</label>
        <button disabled={busy || !peer || !capacitySat} onClick={() => void action(async () => { await api('/api/wallet/channels/open', { peer, capacitySat, public: channelPublic, ...(channelAssetId ? { assetId: channelAssetId, assetAmount: channelAssetAmount } : {}) }); await refresh(); })}>Apri canale di test</button>
        <pre>{JSON.stringify({ peers, channels, assets }, null, 2)}</pre>
      </details>
      <details><summary>Saldo asset RGB</summary><p>Usa il contract ID completo. Il saldo complessivo non dimostra liquidità per un percorso Lightning.</p>
        <label>Contract ID<input value={balanceAssetId} onChange={e => { setBalanceAssetId(e.target.value); setAssetBalance(null); }} /></label>
        <button disabled={busy || !balanceAssetId} onClick={() => void action(async () => setAssetBalance(await api(`/api/wallet/asset-balance?assetId=${encodeURIComponent(balanceAssetId)}`)))}>Leggi saldo</button>
        {assetBalance !== null && <pre>{JSON.stringify(assetBalance, null, 2)}</pre>}
      </details>
      <details><summary>Storico dal nodo</summary><p>Le risposte provengono dal nodo WDK. Uno stato pending o sconosciuto richiede una nuova lettura e non autorizza un nuovo invio automatico.</p>
        <h3>Pagamenti Lightning BTC e RGB</h3>
        {lightningHistory.length ? <ul>{lightningHistory.map((payment, index) => <li key={`${payment.paymentHash ?? 'unknown'}-${index}`}>
          {payment.status} · {payment.amountMsat ?? 'importo sconosciuto'} msat · {payment.assetId ?? 'BTC'}{payment.assetAmount ? ` · ${payment.assetAmount} unità RGB` : ''} · {payment.paymentHash ?? 'hash non disponibile'}
        </li>)}</ul> : <p>Nessun pagamento Lightning restituito dal nodo.</p>}
        <button disabled={busy} onClick={() => void action(async () => setBitcoinHistory(await api('/api/wallet/history/bitcoin')))}>Transazioni Bitcoin</button>
        {bitcoinHistory !== null && <pre>{JSON.stringify(bitcoinHistory, null, 2)}</pre>}
        <label>Contract ID per trasferimenti RGB<input value={balanceAssetId} onChange={e => { setBalanceAssetId(e.target.value); setRgbHistory(null); }} /></label>
        <button disabled={busy || !balanceAssetId} onClick={() => void action(async () => setRgbHistory(await api(`/api/wallet/history/rgb?assetId=${encodeURIComponent(balanceAssetId)}`)))}>Trasferimenti RGB</button>
        {rgbHistory !== null && <pre>{JSON.stringify(rgbHistory, null, 2)}</pre>}
      </details>
      <details><summary>Invia una invoice regtest senza vincoli</summary><p>Flusso base separato dall’interpretazione AI. Ogni invio richiede anteprima e conferma esplicita. I vincoli di routing non sono ancora applicabili.</p>
        <label>Invoice Lightning regtest<textarea value={sendInvoice} onChange={e => { resetSend(); setSendInvoice(e.target.value); }} /></label>
        <label>Importo msat, solo per invoice senza importo<input value={sendAmount} onChange={e => { resetSend(); setSendAmount(e.target.value); }} inputMode="numeric" /></label>
        <button disabled={busy || !sendInvoice} onClick={() => void action(async () => { setDecoded(await api<Decoded>('/api/payments/decode', { invoice: sendInvoice })); })}>Decodifica</button>
        {decoded && <div><dl><dt>Payment hash</dt><dd>{decoded.paymentHash}</dd><dt>Destinatario</dt><dd>{decoded.payeePubkey ?? 'non esposto'}</dd><dt>Importo</dt><dd>{decoded.amountMsat ?? `${sendAmount || 'da indicare'} msat`}</dd><dt>Asset</dt><dd>{decoded.assetId ?? 'BTC'} {decoded.assetAmount ?? ''}</dd><dt>Scadenza</dt><dd>{new Date(decoded.expiresAt).toLocaleString()}</dd></dl>
          <button disabled={busy} onClick={() => void action(async () => { const id = crypto.randomUUID(); setIntent(await api<Intent>('/api/payments/prepare', { id, invoice: decoded.invoice, ...(sendAmount ? { amountMsat: sendAmount } : {}), constraints: {} })); })}>Prepara intento</button>
        </div>}
        {intent && <div className="notice"><p>Intento {intent.id}: {intent.status}. Importo {intent.amountMsat} msat.</p><button disabled={busy || intent.status !== 'prepared' || !state.sendEnabled} onClick={() => void action(async () => { setIntent(await api<Intent>('/api/payments/confirm', { id: intent.id })); await refresh(); })}>Conferma invio regtest</button><button disabled={busy} onClick={() => void action(async () => setIntent(await api<Intent>(`/api/payments/${intent.id}`)))}>Aggiorna stato</button></div>}
        <h3>Intenti locali</h3><pre>{JSON.stringify(history.map(({ id, paymentHash, status }) => ({ id, paymentHash, status })), null, 2)}</pre>
      </details>
    </>}
    {message && <p className="error" role="alert">{message}</p>}
  </section>;
}
