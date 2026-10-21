// Supabase PostgREST RPC adapter. No privileged keys or table access in the browser.
export function createSupabaseTransport({ url, publishableKey, fetcher = globalThis.fetch, intervalMs = 5000, getAccessToken = async () => null }) {
  const endpoint = `${url.replace(/\/$/, '')}/rest/v1/rpc/moa_api`;
  async function request(path, { token, method = 'GET', data = {}, signal } = {}) {
    const account = path.startsWith('/account/');
    if (account) path = path.slice(8);
    let args;
    if (path === '/trips' && method === 'POST') args = { action: 'create', payload: data };
    const trip = path.match(/^\/trips\/([\w-]+)(?:\/(invites))?$/);
    const invite = path.match(/^\/invites\/([^/]+)(\/join)?$/);
    if (trip) {
      const action = trip[2] === 'invites' && method === 'POST' ? 'invite' : !trip[2] && method === 'PATCH' ? 'update' : !trip[2] && method === 'GET' ? 'get' : null;
      if (action) args = { action, trip_id: trip[1], session_token: token, payload: data };
    }
    if (invite && ((method === 'GET' && !invite[2]) || (method === 'POST' && invite[2]))) args = { action: invite[2] ? 'join' : 'preview', invite_token: decodeURIComponent(invite[1]) };
    if (account && path === '/trips' && method === 'GET') args = { action: 'list' };
    if (account && path === '/profile') args = { action: method === 'GET' ? 'profile' : 'save_profile', payload: data };
    if (account && path === '/adopt') args = { action: 'adopt', trip_id: data.tripId, payload: { token: data.token } };
    if (!args) throw new Error('지원하지 않는 공유 요청이에요.');
    const accessToken = await getAccessToken();
    if (account && args.action !== 'preview' && !accessToken) throw Object.assign(new Error('로그인한 뒤 이용해 주세요.'), { status: 401 });
    let response;
    try {
      response = await fetcher(account ? endpoint.replace(/moa_api$/, 'moa_account_api') : endpoint, { method: 'POST', signal, cache: 'no-store', headers: { apikey: publishableKey, ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}), 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new Error('Supabase에 연결하지 못했어요. 인터넷 연결과 프로젝트 상태를 확인해 주세요.');
    }
    let result;
    try { result = await response.json(); } catch { throw new Error('Supabase 응답을 읽지 못했어요. 잠시 후 다시 시도해 주세요.'); }
    if (result?.code === 'PGRST202') throw new Error(`공유 설정을 준비하고 있어요. ${account ? 'supabase/auth.sql' : 'supabase/setup.sql'} 적용이 필요해요.`);
    if (!response.ok || result?._status) {
      const status = result?._status || response.status;
      throw Object.assign(new Error(result?.error || 'Supabase 요청을 처리하지 못했어요. 프로젝트 설정을 확인해 주세요.'), { status, snapshot: result?.trip ? result : null });
    }
    if (!result || typeof result !== 'object') throw new Error('Supabase 응답 형식이 올바르지 않아요.');
    return result;
  }
  function subscribe(tripId, token, onSnapshot, onConnection, account = false) {
    const controller = new AbortController();
    const documentRef = globalThis.document;
    const windowRef = globalThis.window;
    const maxRetryMs = 30000;
    let timer, wake, activeRequest;
    let failures = 0;
    const isActive = () => documentRef?.visibilityState !== 'hidden' && windowRef?.navigator?.onLine !== false;
    const wait = (ms = null) => new Promise(resolve => {
      wake = resolve;
      if (ms !== null) timer = setTimeout(resolve, ms);
    });
    const wakeNow = () => {
      clearTimeout(timer);
      timer = undefined;
      wake?.();
      wake = undefined;
    };
    const onVisibility = () => {
      if (!isActive()) activeRequest?.abort();
      wakeNow();
    };
    const onOffline = () => {
      activeRequest?.abort();
      wakeNow();
    };
    documentRef?.addEventListener?.('visibilitychange', onVisibility);
    windowRef?.addEventListener?.('online', onVisibility);
    windowRef?.addEventListener?.('offline', onOffline);

    (async () => {
      while (!controller.signal.aborted) {
        if (!isActive()) {
          onConnection('paused');
          await wait();
          continue;
        }
        const requestController = new AbortController();
        activeRequest = requestController;
        const abortRequest = () => requestController.abort();
        controller.signal.addEventListener('abort', abortRequest, { once: true });
        try {
          const result = await request(`${account ? '/account' : ''}/trips/${tripId}`, { token, signal: requestController.signal });
          if (controller.signal.aborted) break;
          if (!isActive()) continue;
          failures = 0;
          onSnapshot(result);
          onConnection('connected');
          await wait(intervalMs);
        } catch (error) {
          if (controller.signal.aborted) break;
          if (error.name === 'AbortError' && !isActive()) continue;
          if (error.status === 401) {
            onConnection('unauthorized');
            break;
          }
          if (!isActive()) continue;
          onConnection('reconnecting');
          const retryMs = Math.min(intervalMs * (2 ** Math.min(failures + 1, 10)), maxRetryMs);
          failures += 1;
          await wait(retryMs);
        } finally {
          controller.signal.removeEventListener('abort', abortRequest);
          if (activeRequest === requestController) activeRequest = undefined;
        }
      }
      clearTimeout(timer);
      documentRef?.removeEventListener?.('visibilitychange', onVisibility);
      windowRef?.removeEventListener?.('online', onVisibility);
      windowRef?.removeEventListener?.('offline', onOffline);
    })();
    return () => {
      controller.abort();
      activeRequest?.abort();
      clearTimeout(timer);
      wakeNow();
    };
  }
  return { request, subscribe };
}
