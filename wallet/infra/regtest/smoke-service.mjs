import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { RgbWallet } from '../../apps/local-service/wallet.ts';

const directory = await mkdtemp(join(tmpdir(), 'airgb-service-smoke-'));
process.env.AIRGB_LDK_PEER_PORT = '0';
const wallet = new RgbWallet(directory);
let restarted;
try {
  const password = randomBytes(24).toString('hex');
  const created = await wallet.create(password);
  if (!created.recoveryPhrase) throw new Error('Creazione wallet fallita');
  await wallet.unlock(password);
  if ((await fetch(wallet.daemon.client.url + '/nodeinfo')).status !== 403) throw new Error('API interna accessibile senza token');
  const summary = await wallet.summary();
  const channels = await wallet.channels();
  const peers = await wallet.peers();
  const assets = await wallet.assets();
  const history = await wallet.history();
  const invoice = await wallet.createLightningInvoice({ amountMsat: '100000', expirySec: 3600 });
  const decoded = await wallet.decodeLightning(invoice.invoice);
  if (decoded.amountMsat !== '100000' || decoded.network !== 'regtest') throw new Error('Decodifica invoice inattesa');
  if (!summary.address.startsWith('bcrt1')) throw new Error('Indirizzo errato');
  await wallet.shutdown();
  restarted = new RgbWallet(directory);
  await restarted.unlock(password);
  if ((await restarted.summary()).nodeId !== summary.nodeId) throw new Error('Identità del nodo cambiata dopo il riavvio');
  process.stdout.write(JSON.stringify({
    account: 0, network: summary.network, addressReady: true,
    nodeIdReady: /^[0-9a-f]{66}$/.test(summary.nodeId),
    btcSpendableSat: summary.btcSpendableSat,
    channels: channels.length, peers: peers.length, assets: assets.length, payments: history.length,
    btcInvoiceDecoded: true,
    restartIdentityPreserved: true,
    internalApiProtected: true,
    rssMiB: Math.round(process.memoryUsage().rss / 1048576),
    heapMiB: Math.round(process.memoryUsage().heapUsed / 1048576),
  }) + '\n');
} finally {
  await wallet.shutdown();
  await restarted?.shutdown();
  await rm(directory, { recursive: true, force: true });
}
