import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WdkWallet } from '../../apps/local-service/wallet.ts';
import { PaymentStore } from '../../apps/local-service/payments.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dir = join(root, 'native-data/e2e');
const secrets = JSON.parse(await readFile(join(dir, 'test-passwords.json'), 'utf8'));
let a, b, payments;
try {
  process.env.AIRGB_LDK_PEER_PORT = '9745';
  a = new WdkWallet(join(dir, 'a'));
  await a.unlock(secrets.a);
  process.env.AIRGB_LDK_PEER_PORT = '9746';
  b = new WdkWallet(join(dir, 'b'));
  await b.unlock(secrets.b);
  const bPeer = (await b.summary()).peerUri;
  await a.connectPeer(bPeer);
  payments = new PaymentStore(join(dir, 'a'), a);
  const records = payments.list();
  for (let attempt = 0; attempt < (process.argv.includes('--once') ? 1 : 24); attempt++) {
    await a.sync(); await b.sync();
    const states = await Promise.all(records.map(record => payments.reconcile(record.id)));
    process.stdout.write(JSON.stringify({ step: 'reconcile', seconds: attempt * 5, statuses: states.map(item => item.status) }) + '\n');
    if (states.every(item => ['succeeded', 'failed'].includes(item.status))) break;
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  const statuses = [];
  for (const record of records) {
    const reconciled = await payments.reconcile(record.id);
    let native = null, receiver = null;
    try { native = await a.paymentStatus(record.paymentHash); } catch (error) { native = { error: error.message }; }
    try { receiver = await b.invoiceStatus(record.invoice); } catch (error) { receiver = { error: error.message }; }
    if (native && typeof native === 'object') delete native.preimage;
    statuses.push({ id: record.id, local: reconciled.status, native, receiver });
  }
  const bPayments = await b.account.listPayments();
  for (const payment of bPayments) delete payment.preimage;
  process.stdout.write(JSON.stringify({ aChannels: await a.account.listChannels(), bChannels: await b.account.listChannels(), aNetwork: await a.account.getNetworkInfo(), bNetwork: await b.account.getNetworkInfo(), payments: statuses, aPeers: await a.account.listPeers(), bPeers: await b.account.listPeers(), bPayments }) + '\n');
} finally {
  payments?.close();
  await Promise.allSettled([a?.shutdown(), b?.shutdown()]);
}
