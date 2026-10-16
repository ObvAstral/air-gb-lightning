import { WalletError } from './wallet.js';

const MINER_WALLET = 'miner';
const MAX_MINE_BLOCKS = 6;
const MISSING_WALLET_CODES = new Set([-18, -35]);

type RpcPayload = { error?: { code?: number; message?: string } | null; result?: unknown };

async function bitcoinRpc(method: string, params: unknown[], wallet = ''): Promise<unknown> {
  const user = process.env.BITCOIND_RPC_USER;
  const password = process.env.BITCOIND_RPC_PASSWORD;
  if (!user || !password) throw new WalletError('REGTEST_CONFIG_MISSING', 'Configurazione RPC Bitcoin mancante');
  const host = process.env.BITCOIND_RPC_HOST ?? '127.0.0.1';
  const port = process.env.BITCOIND_RPC_PORT ?? '18443';
  const url = `http://${host}:${port}${wallet ? `/wallet/${wallet}` : ''}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '1.0', id: 'airgb-chain', method, params }),
    });
  } catch {
    throw new WalletError('BITCOIN_RPC', 'Nodo Bitcoin non raggiungibile');
  }
  const data = await response.json() as RpcPayload;
  if (!response.ok || data.error) {
    if (data.error?.code !== undefined && MISSING_WALLET_CODES.has(data.error.code)) {
      throw new WalletError('MINER_WALLET_MISSING', 'Wallet miner assente: eseguire ./scripts/regtest.sh init-chain');
    }
    throw new WalletError('BITCOIN_RPC', data.error?.message ?? `HTTP ${response.status}`);
  }
  return data.result;
}

export async function chainHeight(): Promise<number> {
  const height = await bitcoinRpc('getblockcount', []);
  if (typeof height !== 'number' || !Number.isSafeInteger(height) || height < 0) throw new WalletError('BITCOIN_RPC', 'Altezza blocco non valida');
  return height;
}

export async function mineBlocks(blocks: number): Promise<{ mined: number; height: number }> {
  if (!Number.isSafeInteger(blocks) || blocks < 1 || blocks > MAX_MINE_BLOCKS) throw new WalletError('INVALID_BLOCK_COUNT', 'Blocchi da minare: da 1 a 6');
  const address = await bitcoinRpc('getnewaddress', [], MINER_WALLET);
  if (typeof address !== 'string' || !address.startsWith('bcrt1')) throw new WalletError('BITCOIN_RPC', 'Indirizzo miner non valido');
  await bitcoinRpc('generatetoaddress', [blocks, address], MINER_WALLET);
  return { mined: blocks, height: await chainHeight() };
}
