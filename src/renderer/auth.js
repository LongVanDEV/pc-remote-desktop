const { ipcRenderer } = require('electron');
const { createClient } = require('@supabase/supabase-js');
const { SUPABASE_URL, SUPABASE_ANON_KEY, LOOPBACK_PORT } = require('./config');

// One Supabase client per renderer window. persistSession is off because
// we handle session storage ourselves (encrypted, via main.js/safeStorage)
// instead of relying on localStorage.
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    flowType: 'pkce',
    persistSession: false,
    autoRefreshToken: true,
    detectSessionInUrl: false
  }
});

let cachedSession = null;
let persistQueue = Promise.resolve();

async function persistSession(session) {
  cachedSession = session;
  persistQueue = persistQueue
    .catch(() => {})
    .then(async () => {
      if (!session) {
        await ipcRenderer.invoke('auth-clear-session');
        return;
      }
      await ipcRenderer.invoke(
        'auth-save-session',
        JSON.stringify({ access_token: session.access_token, refresh_token: session.refresh_token })
      );
    });
  return persistQueue;
}

// Supabase automatically rotates refresh tokens while autoRefreshToken is on.
// Persist every refreshed session so the next app launch uses the newest pair.
supabase.auth.onAuthStateChange((event, session) => {
  cachedSession = session;
  if (session) {
    supabase.realtime.setAuth(session.access_token);
    if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
      void persistSession(session);
    }
  } else if (event === 'SIGNED_OUT') {
    void persistSession(null);
  }
});

async function restoreSession() {
  const raw = await ipcRenderer.invoke('auth-load-session');
  if (!raw) return null;
  try {
    const { access_token, refresh_token } = JSON.parse(raw);
    const { data, error } = await supabase.auth.setSession({ access_token, refresh_token });
    if (error) throw error;
    cachedSession = data.session;
    await persistSession(cachedSession);
    return cachedSession;
  } catch (err) {
    console.warn('Could not restore saved session:', err.message);
    await ipcRenderer.invoke('auth-clear-session');
    return null;
  }
}

async function signInWithGoogle() {
  const redirectTo = `http://127.0.0.1:${LOOPBACK_PORT}/callback`;

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo, skipBrowserRedirect: true }
  });
  if (error) throw error;

  const code = await ipcRenderer.invoke('oauth-authorize', { url: data.url, port: LOOPBACK_PORT });
  const { data: sessionData, error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
  if (exchangeError) throw exchangeError;

  await persistSession(sessionData.session);
  return sessionData.session;
}

async function getCurrentSession() {
  if (cachedSession) return cachedSession;
  return restoreSession();
}

async function getCurrentUser() {
  const session = await getCurrentSession();
  return session ? session.user : null;
}

async function signOut() {
  await supabase.auth.signOut();
  await persistSession(null);
  await ipcRenderer.invoke('stop-hosting');
}

module.exports = {
  supabase,
  signInWithGoogle,
  getCurrentSession,
  getCurrentUser,
  signOut
};
