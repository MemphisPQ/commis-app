/* Anonymous error reports, for Commis only (the build copies this file and adds its script tag; the one-restaurant site
 * doesn't have it). When the page hits an error nobody planned for, a short note goes to Commis's own Supabase table
 * (supabase/client_errors.sql): what went wrong, in which file and line, the page, the browser type, the screen width
 * and the language. It's never linked to an account.
 *
 * Commis holds restaurants' private data, and an error's words can repeat it, so:
 *  - only errors the browser itself raises (TypeError and the like) keep their wording; a message written by the app
 *    can name a recipe or a supplier, so it goes as "Error (message not sent)";
 *  - anything in quotes that doesn't look like code is cut, and so are email addresses and long numbers;
 *  - the stack keeps only where it happened (function, file, line), not the message it usually starts with;
 *  - the page is the path only, never what follows # or ?.
 * At most 5 reports per visit, each error once. Reports wait until config.js has given the Supabase address.
 * Reporting can never break the page. */
(function () {
  const MAX = 5;
  // not our bugs: browser extensions, other sites' scripts, and a lost connection
  const NOISE = /^Script error\.?$|ResizeObserver loop|extension:\/\/|webkit-masked-url|^(TypeError: )?(Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?)$/i;
  const NATIVE = /^(TypeError|ReferenceError|RangeError|SyntaxError|URIError|EvalError)$/;
  const seen = new Set();
  const waiting = [];
  let sent = 0;

  /* "Safari 17 on iOS 17.5", "Chrome 130 on Android 14": the kind of browser, not the person. */
  function browserName(ua) {
    const v = re => { const m = re.exec(ua); return m ? m[1].replace(/_/g, ".") : ""; };
    const os = /iPhone|iPad|iPod/.test(ua) ? "iOS " + v(/OS (\d+[_.]\d+)/)
      : /Android/.test(ua) ? "Android " + v(/Android (\d+)/)
      : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux|CrOS/.test(ua) ? "Linux" : "other";
    const name = /Edg\//.test(ua) ? "Edge " + v(/Edg\/(\d+)/)
      : /SamsungBrowser\//.test(ua) ? "Samsung " + v(/SamsungBrowser\/(\d+)/)
      : /CriOS\//.test(ua) ? "Chrome " + v(/CriOS\/(\d+)/)
      : /FxiOS\//.test(ua) ? "Firefox " + v(/FxiOS\/(\d+)/)
      : /Firefox\//.test(ua) ? "Firefox " + v(/Firefox\/(\d+)/)
      : /Chrome\//.test(ua) ? "Chrome " + v(/Chrome\/(\d+)/)
      : /Safari\//.test(ua) ? "Safari " + v(/Version\/(\d+)/) : "other";
    return `${name.trim()} on ${os.trim()}`.slice(0, 60);
  }

  /* The words of an error, with nothing from the restaurant's data in them. */
  function cleanMessage(message, name) {
    let m = String(message || "").replace(/^Uncaught\s+(\(in promise\)\s+)?/i, "").trim();
    const kind = (/^([A-Z]\w*Error)\b/.exec(m) || [])[1] || name || "";
    if (!NATIVE.test(kind)) return `${/^\w*Error$/.test(kind) ? kind : "Error"} (message not sent)`;
    return m
      .replace(/[“«][^”»]*[”»]/g, "“…”")
      .replace(/"[^"]*"/g, '"…"')
      .replace(/'([^']*)'/g, (all, inner) => (/^[\w.$[\]()\s-]{1,60}$/.test(inner) ? all : "'…'"))
      .replace(/[^\s@]+@[^\s@]+/g, "…")
      .replace(/\d{5,}/g, "…")
      .slice(0, 300);
  }

  const fileOf = url => {
    if (!url || url === "undefined") return "";   // some errors don't say which file (WebKit can say "undefined")
    try { return new URL(url, location.href).pathname.split("/").pop() || ""; } catch { return ""; }
  };
  // where it happened, line by line: function, file, line. A stack often starts with the message, which isn't kept.
  const whereOnly = stack => String(stack || "").split("\n")
    .map(l => l.trim())
    .filter(l => /:\d+:\d+\)?$/.test(l) && /^at\s|@/.test(l))
    .slice(0, 6)
    .map(l => l.replace(/(?:https?|file|blob):\/*[^\s)@]*\/([^/\s)?#]*)(?:[?#][^\s):]*)?/g, "$1"))
    .join("\n").slice(0, 1000);

  function send(report) {
    const cfg = window.COSTING_CONFIG || {};
    if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) return false;
    try {
      fetch(cfg.supabaseUrl.replace(/\/+$/, "") + "/rest/v1/client_errors", {
        method: "POST",
        keepalive: true,
        headers: { apikey: cfg.supabaseAnonKey, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify(report),
      }).catch(() => {});
    } catch { /* never let a report break the page */ }
    return true;
  }
  function flush() { while (waiting.length && send(waiting[0])) waiting.shift(); }

  function report(message, name, source, line, col, stack) {
    const raw = String(message || "").trim();
    if (!raw || sent >= MAX) return;
    if (NOISE.test(raw) || NOISE.test(String(source || "")) || NOISE.test(String(stack || ""))) return;
    const msg = cleanMessage(raw, name);
    const file = fileOf(source).slice(0, 120);
    const key = `${msg}|${file}:${line || 0}`;
    if (seen.has(key)) return;
    seen.add(key);
    sent++;
    waiting.push({
      message: msg,
      source: file,
      line: Math.max(0, line | 0),
      col: Math.max(0, col | 0),
      stack: whereOnly(stack),
      page: location.pathname.slice(0, 120),
      lang: (document.documentElement.lang || "").slice(0, 10),
      browser: browserName(navigator.userAgent || ""),
      width: Math.max(0, Math.round(window.innerWidth || 0)),
    });
    flush();
  }

  window.addEventListener("error", e => {
    if (!e || (!e.message && !e.error)) return;   // a missing image or file isn't a script error
    const err = e.error;
    report(e.message || (err && err.message), err && err.name, e.filename, e.lineno, e.colno, err && err.stack);
  });
  window.addEventListener("unhandledrejection", e => {
    const r = e && e.reason;
    if (r && r.message) report(`${r.name || "Error"}: ${r.message}`, r.name, "", 0, 0, r.stack);
    else report("Error", "Error", "", 0, 0, "");   // a rejection with no error in it: its value could be anything
  });
  window.addEventListener("load", flush);

  window.CommisErrors = { report, browserName, cleanMessage };
})();
