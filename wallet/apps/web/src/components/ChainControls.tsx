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
      setMessage(`Minato 1 blocco. Altezza ${mined.height}.`);
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <section>
    <h2>Regtest</h2>
    <p>bitcoind, electrs e proxy sono i container condivisi. Il bottone mina sul wallet <code>miner</code>.</p>
    {offline && <p className="error" role="alert">Alice non è raggiungibile su {ALICE_BASE_URL}.</p>}
    <p><strong>Altezza:</strong> {height ?? 'non letta'}</p>
    <button disabled={busy || !token} onClick={() => void readHeight().catch(error => setMessage((error as Error).message))}>Leggi altezza</button>
    <button disabled={busy || !token} onClick={() => void mineOneBlock()}>Mine 1 Block</button>
    {message && <p role="status">{message}</p>}
  </section>;
}
