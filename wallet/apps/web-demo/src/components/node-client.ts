import { useCallback, useEffect, useMemo, useState } from 'react';
import topology from '../../../../../topology.json' with { type: 'json' };

export type NodeAccent = 'purple' | 'blue' | 'emerald';

export type NodeEndpoint = {
  id: string;
  label: string;
  port: number;
  p2pPort: number;
  baseUrl: string;
  directUrl: string;
  accent: NodeAccent;
};

const NODE_ACCENTS: NodeAccent[] = ['purple', 'blue', 'emerald'];

function resolveBaseUrl(port: number): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `/nodes/${port}`;
  }
  return `http://127.0.0.1:${port}`;
}

export const TOPOLOGY_NODES: NodeEndpoint[] = topology.nodes.map((node, index) => ({
  id: node.id,
  label: node.alias,
  port: node.apiPort,
  p2pPort: node.p2pPort,
  baseUrl: resolveBaseUrl(node.apiPort),
  directUrl: `http://127.0.0.1:${node.apiPort}`,
  accent: NODE_ACCENTS[index % NODE_ACCENTS.length],
}));

export const UI_NODES: NodeEndpoint[] = TOPOLOGY_NODES;

export const ALICE_BASE_URL =
  TOPOLOGY_NODES.find(node => node.id === 'alice')?.baseUrl ?? resolveBaseUrl(8801);
export const BOB_BASE_URL =
  TOPOLOGY_NODES.find(node => node.id === 'bob')?.baseUrl ?? resolveBaseUrl(8802);

export type NodeSession = {
  baseUrl: string;
  directUrl: string;
  token: string;
  offline: boolean;
  api: <T>(path: string, body?: unknown) => Promise<T>;
};

async function readSession(baseUrl: string): Promise<{ token: string; offline: boolean }> {
  const response = await fetch(`${baseUrl}/api/session`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(2500),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = (await response.json()) as { token?: string };
  if (!body.token) throw new Error('Session missing token');
  return { token: body.token, offline: false };
}

export function useNodeDirectory(endpoints: readonly NodeEndpoint[]): Record<string, NodeSession> {
  const [rows, setRows] = useState<Record<string, { token: string; offline: boolean }>>({});
  const endpointsKey = endpoints.map(endpoint => `${endpoint.id}@${endpoint.baseUrl}`).join('|');

  const refreshSessions = useCallback(async () => {
    const entries = await Promise.all(
      endpoints.map(async endpoint => {
        try {
          return [endpoint.id, await readSession(endpoint.baseUrl)] as const;
        } catch {
          return [endpoint.id, { token: '', offline: true }] as const;
        }
      }),
    );
    setRows(Object.fromEntries(entries));
  }, [endpoints]);

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
  }, [endpoints, endpointsKey, refreshSessions]);

  return useMemo(() => {
    const directory: Record<string, NodeSession> = {};
    for (const endpoint of endpoints) {
      const row = rows[endpoint.id] ?? { token: '', offline: false };
      directory[endpoint.id] = {
        baseUrl: endpoint.baseUrl,
        directUrl: endpoint.directUrl,
        token: row.token,
        offline: row.offline,
        api: async <T,>(path: string, body?: unknown): Promise<T> => {
          const response = await fetch(`${endpoint.baseUrl}${path}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: {
              'content-type': 'application/json',
              'x-session-token': row.token,
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            cache: 'no-store',
          });
          const value = (await response.json()) as { message?: string; code?: string };
          if (!response.ok) {
            throw new Error(value.message ?? value.code ?? `HTTP ${response.status}`);
          }
          return value as T;
        },
      };
    }
    return directory;
  }, [endpoints, rows]);
}
