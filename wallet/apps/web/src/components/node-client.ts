import { useCallback, useEffect, useMemo, useState } from 'react';
import topology from '../../../../../topology.json' with { type: 'json' };

export const USER_BASE_URL = 'http://127.0.0.1:8789';

export type NodeAccent = 'purple' | 'blue' | 'emerald';

export type NodeEndpoint = {
  id: string;
  label: string;
  port: number;
  baseUrl: string;
  accent: NodeAccent;
};

const FORK_ACCENTS: NodeAccent[] = ['purple', 'blue'];

export const FORK_NODES: NodeEndpoint[] = topology.nodes.map((node, index) => ({
  id: node.id,
  label: node.alias,
  port: node.apiPort,
  baseUrl: `http://127.0.0.1:${node.apiPort}`,
  accent: FORK_ACCENTS[index % FORK_ACCENTS.length],
}));

export const USER_NODE: NodeEndpoint = {
  id: 'user',
  label: 'Wallet',
  port: 8789,
  baseUrl: USER_BASE_URL,
  accent: 'emerald',
};

export const UI_NODES: NodeEndpoint[] = [USER_NODE, ...FORK_NODES];

export const ALICE_BASE_URL = FORK_NODES.find(node => node.id === 'alice')?.baseUrl ?? 'http://127.0.0.1:8801';
export const BOB_BASE_URL = FORK_NODES.find(node => node.id === 'bob')?.baseUrl ?? 'http://127.0.0.1:8802';

export type NodeSession = {
  baseUrl: string;
  token: string;
  offline: boolean;
  api: <T>(path: string, body?: unknown) => Promise<T>;
};

async function readSession(baseUrl: string): Promise<{ token: string; offline: boolean }> {
  const response = await fetch(`${baseUrl}/api/session`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = (await response.json()) as { token?: string };
  if (!body.token) throw new Error('Sessione senza token');
  return { token: body.token, offline: false };
}

export function useNodeDirectory(endpoints: readonly NodeEndpoint[]): Record<string, NodeSession> {
  const [rows, setRows] = useState<Record<string, { token: string; offline: boolean }>>({});
  const endpointsKey = endpoints.map(endpoint => `${endpoint.id}@${endpoint.baseUrl}`).join('|');

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      endpoints.map(async endpoint => {
        try {
          return [endpoint.id, await readSession(endpoint.baseUrl)] as const;
        } catch {
          return [endpoint.id, { token: '', offline: true }] as const;
        }
      }),
    ).then(entries => {
      if (!cancelled) setRows(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [endpoints, endpointsKey]);

  return useMemo(() => {
    const directory: Record<string, NodeSession> = {};
    for (const endpoint of endpoints) {
      const row = rows[endpoint.id] ?? { token: '', offline: false };
      directory[endpoint.id] = {
        baseUrl: endpoint.baseUrl,
        token: row.token,
        offline: row.offline,
        api: async <T,>(path: string, body?: unknown): Promise<T> => {
          const response = await fetch(`${endpoint.baseUrl}${path}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { 'content-type': 'application/json', 'x-session-token': row.token },
            body: body === undefined ? undefined : JSON.stringify(body),
            cache: 'no-store',
          });
          const value = (await response.json()) as { message?: string; code?: string };
          if (!response.ok) throw new Error(value.message ?? value.code ?? `HTTP ${response.status}`);
          return value as T;
        },
      };
    }
    return directory;
  }, [endpoints, rows]);
}

export function useNodeSession(baseUrl: string) {
  const [token, setToken] = useState('');
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setToken('');
    setOffline(false);
    void readSession(baseUrl)
      .then(body => { if (!cancelled) { setToken(body.token); setOffline(false); } })
      .catch(() => { if (!cancelled) setOffline(true); });
    return () => { cancelled = true; };
  }, [baseUrl]);
  const api = useCallback(async <T,>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': token },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
    const value = await response.json() as { message?: string; code?: string };
    if (!response.ok) throw new Error(value.message ?? value.code ?? `HTTP ${response.status}`);
    return value as T;
  }, [baseUrl, token]);
  return useMemo(() => ({ baseUrl, token, offline, api }), [baseUrl, token, offline, api]);
}
