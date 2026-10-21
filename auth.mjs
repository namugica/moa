// Supabase OAuth with PKCE. Provider secrets stay in Supabase, never in this app.
export function createAuth({ url, publishableKey, storage, transientStorage, location, replaceUrl, navigate, fetcher = globalThis.fetch, cryptoImpl = globalThis.crypto, now = () => Date.now() }) {
  const base = url.replace(/\/$/, '');
  const key = `moa.auth.v1:${base}`, pendingKey = `${key}:pkce`;
  const listeners = new Set();
  let session = null, refreshing, revision = 0;
  const emit = () => { for (const fn of listeners) fn(session?.user || null); };
  const save = (data, expectedRevision) => {
    if (expectedRevision !== undefined && revision !== expectedRevision) throw new Error('로그인 상태가 변경되었어요. 다시 시도해 주세요.');
    const oldId = session?.user?.id;
    if (!data?.access_token || !data?.refresh_token || !data?.user?.id) throw new Error('로그인 정보를 확인하지 못했어요. 다시 로그인해 주세요.');
    const next = { ...data, expires_at: data.expires_at || Math.floor(now() / 1000) + data.expires_in };
    storage.setItem(key, JSON.stringify(next)); session = next; if (oldId !== next.user.id) emit(); return next;
  };
  const clear = () => { revision++; storage.removeItem(key); session = null; emit(); };
  async function call(path, { method = 'GET', data, token } = {}) {
    let response;
    try { response = await fetcher(`${base}/auth/v1${path}`, { method, headers: { apikey: publishableKey, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) }); }
    catch { throw new Error('로그인 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.'); }
    const result = response.status === 204 ? {} : await response.json();
    if (!response.ok) throw Object.assign(new Error('로그인을 완료하지 못했어요. 다시 시도해 주세요.'), { status: response.status, code: result.error_code || result.code });
    return result;
  }
  async function getAccessToken() {
    if (!session) return null;
    if (session.expires_at > Math.floor(now() / 1000) + 60) return session.access_token;
    if (!refreshing) refreshing = (async () => {
      const expectedRevision = revision;
      try { return save(await call('/token?grant_type=refresh_token', { method: 'POST', data: { refresh_token: session.refresh_token } }), expectedRevision).access_token; }
      catch (error) { if (error.status === 400 || error.status === 401) clear(); throw error; }
      finally { refreshing = null; }
    })();
    return refreshing;
  }
  async function initialize() {
    try { const saved = JSON.parse(storage.getItem(key) || 'null'); if (saved?.access_token && saved?.refresh_token && saved?.user?.id) session = saved; } catch { session = null; }
    const callback = new URL(location.href);
    const code = callback.searchParams.get('code');
    const oauthError = callback.searchParams.get('error');
    if (code || oauthError) {
      let pending;
      try { pending = JSON.parse(transientStorage.getItem(pendingKey) || 'null'); } catch { /* Reject malformed callback state. */ }
      callback.searchParams.delete('code');
      for (const name of ['error','error_code','error_description']) callback.searchParams.delete(name);
      if (pending?.returnHash?.startsWith('#')) callback.hash = pending.returnHash;
      replaceUrl(callback.href);
      transientStorage.removeItem(pendingKey);
      if (oauthError) throw new Error('로그인이 취소되었거나 허용되지 않았어요. 다시 선택해 주세요.');
      if (!pending?.verifier || now() - pending.createdAt > 10 * 60 * 1000) throw new Error('로그인 요청이 만료되었어요. 다시 로그인해 주세요.');
      save(await call('/token?grant_type=pkce', { method: 'POST', data: { auth_code: code, code_verifier: pending.verifier } }));
    }
    if (session) {
      const token = await getAccessToken();
      try { session.user = await call('/user', { token }); storage.setItem(key, JSON.stringify(session)); }
      catch (error) { if (error.status === 401 || error.status === 403) clear(); throw error; }
    }
    emit(); return session?.user || null;
  }
  async function signIn(provider) {
    if (!['google','kakao'].includes(provider)) throw new Error('지원하지 않는 로그인 방식이에요.');
    const settings = await call('/settings');
    if (!settings.external?.[provider]) throw new Error(`${provider === 'kakao' ? '카카오' : '구글'} 로그인이 아직 준비되지 않았어요. 잠시 후 다시 시도해 주세요.`);
    const encode = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
    const verifier = encode(cryptoImpl.getRandomValues(new Uint8Array(32)));
    const challenge = encode(new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    transientStorage.setItem(pendingKey, JSON.stringify({ verifier, createdAt: now(), returnHash: location.hash || '#home' }));
    const redirect = new URL(location.href); redirect.search = ''; redirect.hash = '';
    const target = new URL(`${base}/auth/v1/authorize`);
    for (const [name,value] of Object.entries({ provider, redirect_to: redirect.href, code_challenge: challenge, code_challenge_method: 's256' })) target.searchParams.set(name,value);
    navigate(target.href);
  }
  async function signOut() {
    const token = session?.access_token;
    // Keep local sign-out immediate even when the network is unavailable.
    clear(); transientStorage.removeItem(pendingKey);
    if (token) try { await call('/logout?scope=local', { method:'POST', token }); } catch { /* Local data is already hidden. */ }
  }
  return { initialize, signIn, signOut, getAccessToken, getUser: () => session?.user || null, onChange: fn => { listeners.add(fn); return () => listeners.delete(fn); }, storageKey: key };
}
