import { API_BASE, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.mjs';
import { auth } from './account.mjs';
import { createSupabaseTransport } from './supabase-client.mjs';
const supabase = SUPABASE_URL ? createSupabaseTransport({ url: SUPABASE_URL, publishableKey: SUPABASE_PUBLISHABLE_KEY, getAccessToken: () => auth.getAccessToken() }) : null;
export const CONNECTION_LABEL = supabase ? '자동 동기화 · 2초마다' : '실시간 연결됨';
const base = API_BASE.replace(/\/$/, '');
export const SESSION_KEY = `moa.shared.v1:${SUPABASE_URL || base || location.origin}`;
export async function request(path, { token, method = 'GET', data, signal, stream = false } = {}) {
  if (supabase) return supabase.request(path, { token, method, data, signal });
  let response;
  try {
    response = await fetch(`${base}/api${path}`, {
      method, signal, cache: 'no-store',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) },
      ...(data ? { body: JSON.stringify(data) } : {})
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('공유 서버에 연결하지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요.');
  }
  if (stream && response.ok) return response;
  let result;
  try { result = await response.json(); } catch { throw new Error('이 사이트에 공유 서버가 연결되지 않았어요. 서버 배포와 API 주소 설정이 필요해요.'); }
  if (!response.ok) throw Object.assign(new Error(result.error || '요청을 처리하지 못했어요.'), { status: response.status, snapshot: result.trip ? result : null });
  return result;
}
export function subscribe(tripId, token, onSnapshot, onConnection, account = false) {
  if (supabase) return supabase.subscribe(tripId, token, onSnapshot, onConnection, account);
  const controller = new AbortController();
  (async () => {
    while (!controller.signal.aborted) {
      try {
        const response = await request(`/trips/${tripId}/events`, { token, signal: controller.signal, stream: true });
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        onConnection('connected');
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) throw new Error('Disconnected');
          buffer += decoder.decode(value, { stream: true });
          let end;
          while ((end = buffer.indexOf('\n\n')) !== -1) {
            const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            if (event.startsWith('data: ')) onSnapshot(JSON.parse(event.slice(6)));
          }
        }
      } catch (error) {
        if (controller.signal.aborted) break;
        onConnection(error.status === 401 ? 'unauthorized' : 'reconnecting');
        if (error.status === 401) break;
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  })();
  return () => controller.abort();
}
