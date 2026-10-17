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
    {offline && <p className="error" role="alert">Node unreachable.</p>}
    <p><strong>Keystore:</strong> {state?.keystoreExists ? 'present' : 'not created'} · <strong>Node:</strong> {state?.node ?? 'unavailable'} · <strong>Send:</strong> {state?.sendEnabled ? 'enabled' : 'disabled'}</p>
    {!state?.keystoreExists && <div>
      <label>Keystore password<input type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} /></label>
      <button disabled={busy || !token || password.length < 12} onClick={() => void action(async () => {
        const created = await api<{ recoveryPhrase: string | null }>('/api/wallet/create', { password });
        setRecovery(created.recoveryPhrase);
        setPassword('');
        await refresh();
      })}>Create wallet</button>
      <label>Import 12-word BIP39 phrase<textarea value={mnemonic} onChange={event => setMnemonic(event.target.value)} autoComplete="off" /></label>
      <button disabled={busy || !token || password.length < 12 || !mnemonic.trim()} onClick={() => void action(async () => {
        await api('/api/wallet/import', { password, mnemonic });
        setMnemonic('');
        setPassword('');
        await refresh();
      })}>Import wallet</button>
    </div>}
    {recovery && <div className="notice"><strong>Save the recovery phrase now.</strong><p>{recovery}</p><button onClick={() => setRecovery(null)}>I have saved the phrase</button></div>}
    {state?.keystoreExists && state.node !== 'ready' && <div>
      <label>Unlock password<input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} /></label>
      <button disabled={busy || !token || !password} onClick={() => void action(async () => { await api('/api/wallet/unlock', { password }); setPassword(''); await refresh(); })}>Unlock node</button>
    </div>}
    {summary && <dl>
      <dt>Node ID</dt><dd>{summary.nodeId}</dd>
      <dt>BTC Address</dt><dd>{summary.address}</dd>
      <dt>Spendable BTC</dt><dd>{summary.btcSpendableSat} sat</dd>
      {summary.peerUri && <><dt>Peer URI</dt><dd>{summary.peerUri}</dd></>}
    </dl>}
    {state?.node === 'ready' && <>
      <button disabled={busy} onClick={() => void action(async () => { await api('/api/wallet/sync', {}); await refresh(); })}>Refresh</button>
      <h3>RGB UTXOs</h3>
      <div className="row">
        <label>Count<input value={utxoCount} onChange={event => setUtxoCount(event.target.value)} inputMode="numeric" /></label>
        <label>Sat<input value={utxoSizeSat} onChange={event => setUtxoSizeSat(event.target.value)} inputMode="numeric" /></label>
        <label>sat/vB<input value={utxoFeeRate} onChange={event => setUtxoFeeRate(event.target.value)} inputMode="numeric" /></label>
      </div>
      <button disabled={busy} onClick={() => void action(async () => {
        const prepared = await api<{ status: string }>('/api/wallet/rgb/utxos', { count: Number(utxoCount), sizeSat: utxoSizeSat, feeRateSatPerVbyte: utxoFeeRate });
        setMessage(prepared.status === 'ready' ? 'RGB UTXOs already present.' : 'UTXOs requested. Mine at least one block and refresh.');
        await refresh();
      })}>Prepare UTXOs</button>
      <h3>NIA Issuance</h3>
      <div className="row">
        <label>Ticker<input value={ticker} onChange={event => setTicker(event.target.value.toUpperCase())} /></label>
        <label>Name<input value={assetName} onChange={event => setAssetName(event.target.value)} /></label>
      </div>
      <div className="row">
        <label>Amount<input value={issueAmount} onChange={event => setIssueAmount(event.target.value)} inputMode="numeric" /></label>
        <label>Precision<input value={precision} onChange={event => setPrecision(event.target.value)} inputMode="numeric" /></label>
      </div>
      <button disabled={busy || !ticker || !assetName || !issueAmount} onClick={() => void action(async () => {
        const created = await api<IssuedAsset>('/api/wallet/rgb/issue', { ticker, name: assetName, precision: Number(precision), amounts: [Number(issueAmount)] });
        setIssued(created);
        setBalanceAssetId(created.assetId);
        setChannelAssetId(created.assetId);
        await refresh();
      })}>Issue NIA</button>
      {issued && <p role="status">{issued.ticker} · {issued.assetId} · supply {issued.issuedSupply}</p>}
      <h3>Channel</h3>
      <label>Peer pubkey@host:port<input value={peer} onChange={event => setPeer(event.target.value)} placeholder="02...@bob:9736" /></label>
      <button disabled={busy || !peer} onClick={() => void action(async () => { await api('/api/wallet/peers/connect', { peer }); await refresh(); })}>Connect peer</button>
      <div className="row">
        <label>Capacity sat<input value={capacitySat} onChange={event => setCapacitySat(event.target.value)} inputMode="numeric" /></label>
        <label>Asset<input value={channelAssetId} onChange={event => setChannelAssetId(event.target.value)} /></label>
        <label>Asset amount<input value={channelAssetAmount} onChange={event => setChannelAssetAmount(event.target.value)} inputMode="numeric" /></label>
      </div>
      <button disabled={busy || !peer || !capacitySat} onClick={() => void action(async () => {
        await api('/api/wallet/channels/open', { peer, capacitySat, public: true, ...(channelAssetId ? { assetId: channelAssetId, assetAmount: channelAssetAmount } : {}) });
        setMessage('Channel opening requested. Mine 6 blocks before paying.');
        await refresh();
      })}>Open channel</button>
      <p>Channels: {channels.length} · Known assets: {assets.length}</p>
      <pre>{JSON.stringify({ channels, assets }, null, 2)}</pre>
      <label>Contract ID for balance<input value={balanceAssetId} onChange={event => { setBalanceAssetId(event.target.value); setAssetBalance(null); }} /></label>
      <button disabled={busy || !balanceAssetId} onClick={() => void action(async () => setAssetBalance(await api(`/api/wallet/asset-balance?assetId=${encodeURIComponent(balanceAssetId)}`)))}>Read balance</button>
      {assetBalance !== null && <pre>{JSON.stringify(assetBalance, null, 2)}</pre>}
    </>}
    {message && <p className="notice" role="status">{message}</p>}
  </section>;
}
