import { useCallback, useEffect, useState } from 'react';
import { useNodeSession } from './node-client.js';

type WalletState = { keystoreExists: boolean; node: string; network: string; sendEnabled: boolean };
type Summary = { address: string; nodeId: string; peerUri: string | null; btcSpendableSat: string };
type IssuedAsset = { assetId: string; ticker: string; name: string; precision: number; issuedSupply: string };

type WalletCardProps = { label: string; baseUrl: string };

export function WalletCard({ label, baseUrl }: WalletCardProps) {
  const { token, offline, api } = useNodeSession(baseUrl);
  const [state, setState] = useState<WalletState | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [assets, setAssets] = useState<unknown[]>([]);
  const [channels, setChannels] = useState<unknown[]>([]);
  const [password, setPassword] = useState('');
  const [mnemonic, setMnemonic] = useState('');
  const [recovery, setRecovery] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [utxoCount, setUtxoCount] = useState('4');
  const [utxoSizeSat, setUtxoSizeSat] = useState('200000');
  const [utxoFeeRate, setUtxoFeeRate] = useState('2');
  const [ticker, setTicker] = useState('DEMO');
  const [assetName, setAssetName] = useState('Demo asset');
  const [issueAmount, setIssueAmount] = useState('1000');
  const [precision, setPrecision] = useState('0');
  const [issued, setIssued] = useState<IssuedAsset | null>(null);
  const [peer, setPeer] = useState('');
  const [capacitySat, setCapacitySat] = useState('200000');
  const [channelAssetId, setChannelAssetId] = useState('');
  const [channelAssetAmount, setChannelAssetAmount] = useState('100');
  const [balanceAssetId, setBalanceAssetId] = useState('');
  const [assetBalance, setAssetBalance] = useState<unknown>(null);

  const refresh = useCallback(async () => {
    if (!token) return;
    const next = await api<WalletState>('/api/wallet/state');
    setState(next);
    if (next.node !== 'ready') return;
    const [info, assetRows, channelRows] = await Promise.all([
      api<Summary>('/api/wallet/summary'),
      api<unknown[]>('/api/wallet/assets'),
      api<unknown[]>('/api/wallet/channels'),
    ]);
    setSummary(info);
    setAssets(assetRows);
    setChannels(channelRows);
  }, [api, token]);

  useEffect(() => { void refresh().catch(error => setMessage((error as Error).message)); }, [refresh]);

  async function action(task: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try { await task(); } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); }
  }

  return <section>
    <h2>{label}</h2>
    <p>{baseUrl}</p>
    {offline && <p className="error" role="alert">Nodo non raggiungibile.</p>}
    <p><strong>Keystore:</strong> {state?.keystoreExists ? 'presente' : 'da creare'} · <strong>Nodo:</strong> {state?.node ?? 'non disponibile'} · <strong>Invio:</strong> {state?.sendEnabled ? 'abilitato' : 'disabilitato'}</p>
    {!state?.keystoreExists && <div>
      <label>Password del keystore<input type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} /></label>
      <button disabled={busy || !token || password.length < 12} onClick={() => void action(async () => {
        const created = await api<{ recoveryPhrase: string | null }>('/api/wallet/create', { password });
        setRecovery(created.recoveryPhrase);
        setPassword('');
        await refresh();
      })}>Crea wallet</button>
      <label>Importa frase BIP39 di 12 parole<textarea value={mnemonic} onChange={event => setMnemonic(event.target.value)} autoComplete="off" /></label>
      <button disabled={busy || !token || password.length < 12 || !mnemonic.trim()} onClick={() => void action(async () => {
        await api('/api/wallet/import', { password, mnemonic });
        setMnemonic('');
        setPassword('');
        await refresh();
      })}>Importa wallet</button>
    </div>}
    {recovery && <div className="notice"><strong>Salva la frase di recupero ora.</strong><p>{recovery}</p><button onClick={() => setRecovery(null)}>Ho salvato la frase</button></div>}
    {state?.keystoreExists && state.node !== 'ready' && <div>
      <label>Password per sbloccare<input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} /></label>
      <button disabled={busy || !token || !password} onClick={() => void action(async () => { await api('/api/wallet/unlock', { password }); setPassword(''); await refresh(); })}>Sblocca nodo</button>
    </div>}
    {summary && <dl>
      <dt>Node ID</dt><dd>{summary.nodeId}</dd>
      <dt>Indirizzo BTC</dt><dd>{summary.address}</dd>
      <dt>BTC spendibili</dt><dd>{summary.btcSpendableSat} sat</dd>
      {summary.peerUri && <><dt>Peer URI</dt><dd>{summary.peerUri}</dd></>}
    </dl>}
    {state?.node === 'ready' && <>
      <button disabled={busy} onClick={() => void action(async () => { await api('/api/wallet/sync', {}); await refresh(); })}>Aggiorna</button>
      <h3>UTXO RGB</h3>
      <div className="row">
        <label>Numero<input value={utxoCount} onChange={event => setUtxoCount(event.target.value)} inputMode="numeric" /></label>
        <label>Sat<input value={utxoSizeSat} onChange={event => setUtxoSizeSat(event.target.value)} inputMode="numeric" /></label>
        <label>sat/vB<input value={utxoFeeRate} onChange={event => setUtxoFeeRate(event.target.value)} inputMode="numeric" /></label>
      </div>
      <button disabled={busy} onClick={() => void action(async () => {
        const prepared = await api<{ status: string }>('/api/wallet/rgb/utxos', { count: Number(utxoCount), sizeSat: utxoSizeSat, feeRateSatPerVbyte: utxoFeeRate });
        setMessage(prepared.status === 'ready' ? 'UTXO RGB già presenti.' : 'UTXO richiesti. Mina almeno un blocco e aggiorna.');
        await refresh();
      })}>Prepara UTXO</button>
      <h3>Emissione NIA</h3>
      <div className="row">
        <label>Ticker<input value={ticker} onChange={event => setTicker(event.target.value.toUpperCase())} /></label>
        <label>Nome<input value={assetName} onChange={event => setAssetName(event.target.value)} /></label>
      </div>
      <div className="row">
        <label>Quantità<input value={issueAmount} onChange={event => setIssueAmount(event.target.value)} inputMode="numeric" /></label>
        <label>Precisione<input value={precision} onChange={event => setPrecision(event.target.value)} inputMode="numeric" /></label>
      </div>
      <button disabled={busy || !ticker || !assetName || !issueAmount} onClick={() => void action(async () => {
        const created = await api<IssuedAsset>('/api/wallet/rgb/issue', { ticker, name: assetName, precision: Number(precision), amounts: [Number(issueAmount)] });
        setIssued(created);
        setBalanceAssetId(created.assetId);
        setChannelAssetId(created.assetId);
        await refresh();
      })}>Emetti NIA</button>
      {issued && <p role="status">{issued.ticker} · {issued.assetId} · supply {issued.issuedSupply}</p>}
      <h3>Canale</h3>
      <label>Peer pubkey@host:porta<input value={peer} onChange={event => setPeer(event.target.value)} placeholder="02...@bob:9736" /></label>
      <button disabled={busy || !peer} onClick={() => void action(async () => { await api('/api/wallet/peers/connect', { peer }); await refresh(); })}>Collega peer</button>
      <div className="row">
        <label>Capacità sat<input value={capacitySat} onChange={event => setCapacitySat(event.target.value)} inputMode="numeric" /></label>
        <label>Asset<input value={channelAssetId} onChange={event => setChannelAssetId(event.target.value)} /></label>
        <label>Importo asset<input value={channelAssetAmount} onChange={event => setChannelAssetAmount(event.target.value)} inputMode="numeric" /></label>
      </div>
      <button disabled={busy || !peer || !capacitySat} onClick={() => void action(async () => {
        await api('/api/wallet/channels/open', { peer, capacitySat, public: true, ...(channelAssetId ? { assetId: channelAssetId, assetAmount: channelAssetAmount } : {}) });
        setMessage('Apertura richiesta. Mina 6 blocchi prima di pagare.');
        await refresh();
      })}>Apri canale</button>
      <p>Canali: {channels.length} · Asset noti: {assets.length}</p>
      <pre>{JSON.stringify({ channels, assets }, null, 2)}</pre>
      <label>Contract ID per il saldo<input value={balanceAssetId} onChange={event => { setBalanceAssetId(event.target.value); setAssetBalance(null); }} /></label>
      <button disabled={busy || !balanceAssetId} onClick={() => void action(async () => setAssetBalance(await api(`/api/wallet/asset-balance?assetId=${encodeURIComponent(balanceAssetId)}`)))}>Leggi saldo</button>
      {assetBalance !== null && <pre>{JSON.stringify(assetBalance, null, 2)}</pre>}
    </>}
    {message && <p className="notice" role="status">{message}</p>}
  </section>;
}
