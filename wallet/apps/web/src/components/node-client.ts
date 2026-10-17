import { useCallback, useEffect, useMemo, useState } from 'react';

export const ALICE_BASE_URL = 'http://127.0.0.1:8787';
export const BOB_BASE_URL = 'http://127.0.0.1:8788';
export const USER_BASE_URL = 'http://127.0.0.1:8789';

export function useNodeSession(baseUrl: string) {
  const [token, setToken] = useState('');
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setToken('');
    setOffline(false);
    void fetch(`${baseUrl}/api/session`, { cache: 'no-store' })
      .then(async response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<{ token: string }>;
      })
      .then(body => { if (!cancelled) setToken(body.token); })
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
