import { useState } from 'react';
import { ALICE_BASE_URL, useNodeSession } from './node-client.js';

type ChainStatus = { height: number };

export function ChainControls() {
  const { token, offline, api } = useNodeSession(ALICE_BASE_URL);
  const [height, setHeight] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function readHeight() {
    const status = await api<ChainStatus>('/api/chain/status');
    setHeight(status.height);
  }

  async function mineOneBlock() {
    setBusy(true);
    setMessage('');
    try {
      const mined = await api<ChainStatus & { mined: number }>('/api/chain/mine', { blocks: 1 });
      setHeight(mined.height);
      setMessage(`Mined 1 block. Height ${mined.height}.`);
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <section>
    <h2>Regtest</h2>
    <p>bitcoind, electrs and proxy are the shared containers. The button mines to the <code>miner</code> wallet.</p>
    {offline && <p className="error" role="alert">Alice is unreachable at {ALICE_BASE_URL}.</p>}
    <p><strong>Height:</strong> {height ?? 'not read'}</p>
    <button disabled={busy || !token} onClick={() => void readHeight().catch(error => setMessage((error as Error).message))}>Read height</button>
    <button disabled={busy || !token} onClick={() => void mineOneBlock()}>Mine 1 Block</button>
    {message && <p role="status">{message}</p>}
  </section>;
}
