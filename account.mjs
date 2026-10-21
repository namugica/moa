import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.mjs';
import { createAuth } from './auth.mjs';
export const auth = SUPABASE_URL ? createAuth({
  url: SUPABASE_URL, publishableKey: SUPABASE_PUBLISHABLE_KEY,
  storage: localStorage, transientStorage: sessionStorage, location,
  replaceUrl: url => history.replaceState(null, '', url),
  navigate: url => location.assign(url)
}) : null;
