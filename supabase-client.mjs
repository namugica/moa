// Supabase PostgREST RPC adapter. No privileged keys or table access in the browser.
export function createSupabaseTransport({ url, publishableKey, fetcher = globalThis.fetch, intervalMs = 2000 }) {
  const endpoint = `${url.replace(/\/$/, '')}/rest/v1/rpc/moa_api`;
  async function request(path, { token, method = 'GET', data = {}, signal } = {}) {
    let args;
    if (path === '/trips' && method === 'POST') args = { action: 'create', payload: data };
    const trip = path.match(/^\/trips\/([\w-]+)(?:\/(invites))?$/);
    const invite = path.match(/^\/invites\/([^/]+)(\/join)?$/);
    if (trip) {
      const action = trip[2] === 'invites' && method === 'POST' ? 'invite' : !trip[2] && method === 'PATCH' ? 'update' : !trip[2] && method === 'GET' ? 'get' : null;
      if (action) args = { action, trip_id: trip[1], session_token: token, payload: data };
    }
    if (invite && ((method === 'GET' && !invite[2]) || (method === 'POST' && invite[2]))) args = { action: invite[2] ? 'join' : 'preview', invite_token: decodeURIComponent(invite[1]) };
    if (!args) throw new Error('지원하지 않는 공유 요청이에요.');
    let response;
    try {
      response = await fetcher(endpoint, { method: 'POST', signal, cache: 'no-store', headers: { apikey: publishableKey, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new Error('Supabase에 연결하지 못했어요. 인터넷 연결과 프로젝트 상태를 확인해 주세요.');
    }
    let result;
    try { result = await response.json(); } catch { throw new Error('Supabase 응답을 읽지 못했어요. 잠시 후 다시 시도해 주세요.'); }
    if (result?.code === 'PGRST202') throw new Error('Supabase 초기 설정이 필요해요. 프로젝트 SQL Editor에서 supabase/setup.sql을 실행해 주세요.');
    if (!response.ok || result?._status) {
      const status = result?._status || response.status;
      throw Object.assign(new Error(result?.error || 'Supabase 요청을 처리하지 못했어요. 프로젝트 설정을 확인해 주세요.'), { status, snapshot: result?.trip ? result : null });
    }
    if (!result || typeof result !== 'object') throw new Error('Supabase 응답 형식이 올바르지 않아요.');
    return result;
  }
  function subscribe(tripId, token, onSnapshot, onConnection) {
    const controller = new AbortController();
    let timer, wake;
    const wait = () => new Promise(resolve => { wake = resolve; timer = setTimeout(resolve, intervalMs); });
    (async () => {
      while (!controller.signal.aborted) {
        try {
          const result = await request(`/trips/${tripId}`, { token, signal: controller.signal });
          if (controller.signal.aborted) break;
          onSnapshot(result); onConnection('connected');
        } catch (error) {
          if (controller.signal.aborted) break;
          onConnection(error.status === 401 ? 'unauthorized' : 'reconnecting');
          if (error.status === 401) break;
        }
        await wait();
      }
    })();
    return () => { controller.abort(); clearTimeout(timer); wake?.(); };
  }
  return { request, subscribe };
}
