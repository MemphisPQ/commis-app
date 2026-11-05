/* Sign-in for Supabase, using its plain web (REST) API. No library needed.
 * The session is kept in this browser so you stay signed in. On the one-restaurant site only you have an account (sign-ups
 * are turned off in Supabase, see README); on Commis's, restaurants make their own (sign up, confirm by email).
 */
const Auth = (() => {
  const KEY = "costing.session";
  const cfg = () => window.COSTING_CONFIG || {};
  const base = () => String(cfg().supabaseUrl || "").replace(/\/+$/, "");
  // Where the links in Supabase's emails bring you back to: this site, without the page part (#/...).
  const here = () => encodeURIComponent(location.origin + location.pathname);

  function load() {
    try { const s = JSON.parse(localStorage.getItem(KEY) || "null"); return s && s.access_token ? s : null; } catch { return null; }
  }
  function save(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private window: this visit only */ } }
  function clear() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } }

  async function call(path, body, { method = "POST", token = null } = {}) {
    let res;
    try {
      res = await fetch(base() + path, { method, headers: { apikey: cfg().supabaseAnonKey, "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
        body: body ? JSON.stringify(body) : undefined });
    } catch {
      throw new Error("Couldn't reach Supabase. Check your connection.");
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const m = (json && (json.error_description || json.msg || json.message)) || res.statusText;
      throw new Error(/invalid login/i.test(m) ? "Wrong email or password." : /not confirmed/i.test(m) ? "Confirm your email first: open the link in the email we sent." : m);
    }
    return json;
  }

  function keep(r) {
    const old = load() || {}, user = r.user || {};
    const s = { access_token: r.access_token, refresh_token: r.refresh_token, expires_at: Date.now() + (r.expires_in || 3600) * 1000,
      email: user.email || old.email, restaurant: (user.user_metadata && user.user_metadata.restaurant) || old.restaurant || "" };
    save(s);
    return s;
  }

  let refreshing = null;
  return {
    configured: () => !!(cfg().supabaseUrl && cfg().supabaseAnonKey),
    signedIn: () => !!load(),
    email: () => (load() || {}).email || "",
    restaurant: () => (load() || {}).restaurant || "",
    async signIn(email, password) { return keep(await call("/auth/v1/token?grant_type=password", { email, password })); },
    /** A new account. With email confirmation on (Commis), there's no session until the link in the email is opened. */
    async signUp(email, password, restaurant, extra = {}) {
      const r = await call(`/auth/v1/signup?redirect_to=${here()}`, { email, password, data: { restaurant, ...extra } });
      if (r.access_token) keep(r);
      return { confirm: !r.access_token };
    },
    /** Sends the "choose a new password" email. */
    async forgot(email) { await call(`/auth/v1/recover?redirect_to=${here()}`, { email }); },
    async setPassword(password) { await call("/auth/v1/user", { password }, { method: "PUT", token: await this.token() }); },
    /**
     * Coming back from a link in one of Supabase's emails: the address ends in #access_token=…&type=signup (or
     * recovery), or #error=…. Keeps the session and tidies the address. Returns { type } or { error }, or null.
     */
    async fromLink() {
      const h = new URLSearchParams(location.hash.replace(/^#\/?/, ""));
      if (!h.get("access_token") && !h.get("error_description")) return null;
      history.replaceState(null, "", location.pathname + "#/dishes");
      if (h.get("error_description")) return { error: h.get("error_description").replace(/\+/g, " ") };
      const tokens = { access_token: h.get("access_token"), refresh_token: h.get("refresh_token"), expires_in: +h.get("expires_in") || 3600 };
      let user = null;
      try { user = await call("/auth/v1/user", null, { method: "GET", token: tokens.access_token }); } catch { /* the session still works */ }
      keep({ ...tokens, user });
      return { type: h.get("type") || "" };
    },
    signOut() { clear(); },
    /** A valid access token, refreshed when it's about to run out. */
    async token() {
      const s = load();
      if (!s) return null;
      if (s.expires_at - Date.now() > 60000) return s.access_token;
      refreshing = refreshing || call("/auth/v1/token?grant_type=refresh_token", { refresh_token: s.refresh_token })
        .then((r) => keep(r).access_token)
        .catch(() => { clear(); return null; })
        .finally(() => { refreshing = null; });
      return refreshing;
    },
  };
})();
