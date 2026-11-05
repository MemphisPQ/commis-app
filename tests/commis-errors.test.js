/* Commis's anonymous error reports: sites/commis/pages/errors.js and supabase/client_errors.sql.
 * The reporter runs for real in a small stand-in for a browser window. The table runs for real on a real Postgres
 * (PGlite, in memory), as the limited roles a visitor gets, so its rules are proved here rather than assumed.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
const SRC = read("sites", "commis", "pages", "errors.js");
const SB = "https://commis.supabase.test";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

/** The reporter in a stand-in window, with a restaurant signed in and private data around it. */
function page({ config = true, href = "https://commisapp.ca/?x=secret#/recipes/My%20secret%20dish", fetchThrows = false } = {}) {
  const listeners = {};
  const calls = [];
  const url = new URL(href);
  const win = {
    addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); },
    innerWidth: 393,
    COSTING_CONFIG: config ? { supabaseUrl: SB + "/", supabaseAnonKey: "anon-key" } : undefined,
  };
  const sandbox = {
    window: win, location: url, URL,
    document: { documentElement: { lang: "fr" } },
    navigator: { userAgent: IPHONE },
    fetch: (u, opts) => { if (fetchThrows) throw new Error("no network"); calls.push({ url: u, opts, body: JSON.parse(opts.body) }); return Promise.resolve({ ok: true }); },
    localStorage: { "costing.session": JSON.stringify({ access_token: "tok-secret", user: { email: "chef@resto.test" } }) },
    console,
  };
  vm.runInNewContext(SRC, sandbox, { filename: "errors.js" });
  const fire = (type, ev) => (listeners[type] || []).forEach((fn) => fn(ev));
  const stackOf = (first) => `${first}\n    at fillSheet (https://commisapp.ca/sheetfill.js?v=2:112:9)\n    at https://commisapp.ca/app.js:900:3`;
  return {
    win, calls, fire,
    fail: (message, err = {}) => fire("error", { message, filename: "https://commisapp.ca/app.js?v=2", lineno: 120, colno: 7, error: { name: "TypeError", stack: stackOf(message), ...err } }),
    reject: (reason) => fire("unhandledrejection", { reason }),
    setConfig: () => { win.COSTING_CONFIG = { supabaseUrl: SB, supabaseAnonKey: "anon-key" }; },
  };
}

test("an error sends one short report to Commis's own table, with the public key only", () => {
  const p = page();
  p.fail("Uncaught TypeError: Cannot read properties of undefined (reading 'price')");
  assert.equal(p.calls.length, 1);
  const { url, opts, body } = p.calls[0];
  assert.equal(url, SB + "/rest/v1/client_errors");
  assert.equal(opts.method, "POST");
  assert.equal(opts.keepalive, true);
  assert.equal(opts.headers.apikey, "anon-key");
  assert.equal(opts.headers.Authorization, undefined, "never the restaurant's login");
  assert.equal(opts.headers.Prefer, "return=minimal", "it never reads anything back");
  assert.deepEqual(JSON.parse(JSON.stringify(body)), {
    message: "TypeError: Cannot read properties of undefined (reading 'price')",
    source: "app.js",
    line: 120,
    col: 7,
    stack: "at fillSheet (sheetfill.js:112:9)\nat app.js:900:3",
    page: "/",
    lang: "fr",
    browser: "Safari 17 on iOS 17.5",
    width: 393,
  });
});

test("nothing of the restaurant's goes out: not its login, the address, or names in an error's words", () => {
  const p = page();
  // the app's own messages can name a recipe, a prep or a supplier: their words are never sent
  p.fail("Uncaught Error: “Sauce secrète” has too many ingredients", { name: "Error", stack: "Error: “Sauce secrète” has too many ingredients\n    at x (https://commisapp.ca/sheetfill.js:115:3)" });
  p.reject(Object.assign(new Error("The costing template has no “Marge de Marie” tab."), { name: "Error" }));
  p.fail("Uncaught DOMException: chef@resto.test", { name: "DOMException", stack: "" });
  // even the browser's own errors can quote what they choked on
  p.fail(`Uncaught SyntaxError: Unexpected token 'S', "Sauce secrète 12.50" is not valid JSON`, { name: "SyntaxError", stack: `SyntaxError: Unexpected token 'S', "Sauce secrète 12.50" is not valid JSON\n    at parse (https://commisapp.ca/store.js:9:1)` });
  p.fail("Uncaught TypeError: 'Sauce: secrète, 12.50 $ / kg (Marie)' is not a function");
  p.reject("Sauce secrète");   // a rejection that isn't an error at all
  const sent = JSON.stringify(p.calls.map((c) => c.body));
  for (const secret of ["Sauce", "secrète", "Marge", "Marie", "12.50", "chef@resto.test", "tok-secret", "secret", "recipes", "commisapp.ca", "x="]) {
    assert.ok(!sent.includes(secret), `the reports must not include ${secret}: ${sent}`);
  }
  assert.equal(p.calls[0].body.message, "Error (message not sent)");
  assert.equal(p.calls[0].body.source, "app.js", "where it happened is still there");
  const syntax = p.calls.map((c) => c.body.message).find((m) => m.startsWith("SyntaxError"));
  assert.equal(syntax, `SyntaxError: Unexpected token 'S', "…" is not valid JSON`);
});

test("long numbers and email addresses are cut from the browser's own errors too", () => {
  const { cleanMessage } = page().win.CommisErrors;
  assert.equal(cleanMessage("TypeError: bad value 5141234567 for chef@resto.test"), "TypeError: bad value … for …");
  assert.equal(cleanMessage("ReferenceError: price is not defined"), "ReferenceError: price is not defined");
  assert.equal(cleanMessage("Something else entirely"), "Error (message not sent)");
  assert.equal(cleanMessage("QuotaExceededError: storage is full of Marie's recipes"), "QuotaExceededError (message not sent)");
  assert.ok(cleanMessage("TypeError: " + "x".repeat(900)).length <= 300, "fits the table");
});

test("each error is sent once, and a visit sends at most 5", () => {
  const p = page();
  p.fail("TypeError: same thing"); p.fail("TypeError: same thing"); p.fail("TypeError: same thing");
  assert.equal(p.calls.length, 1);
  for (let i = 0; i < 10; i++) p.fire("error", { message: "TypeError: different", filename: "app.js", lineno: i + 1, colno: 1, error: { name: "TypeError", stack: "" } });
  assert.equal(p.calls.length, 5);
});

test("a lost connection, other sites' errors and missing images aren't reported", () => {
  const p = page();
  p.reject(Object.assign(new TypeError("Failed to fetch")));
  p.reject(Object.assign(new TypeError("Load failed")));
  p.fire("error", { message: "Script error." });
  p.fail("TypeError: oops", { stack: "at x (chrome-extension://abcdef/content.js:1:1)" });
  p.fire("error", { message: "ResizeObserver loop completed with undelivered notifications." });
  p.fire("error", {});   // a missing image: no message, no error
  assert.equal(p.calls.length, 0);
});

test("an error before the settings load waits, and reporting can't break the page", () => {
  const p = page({ config: false });
  p.fail("TypeError: too early");
  assert.equal(p.calls.length, 0);
  p.setConfig();
  p.fire("load", {});
  assert.equal(p.calls.length, 1);
  assert.doesNotThrow(() => page({ fetchThrows: true }).fail("TypeError: with no network at all"));
  assert.doesNotThrow(() => page({ config: false }).fail("TypeError: and no settings at all"));
});

test("it's in Commis's build, first of the scripts, and the one-restaurant site doesn't have it", () => {
  execFileSync(process.execPath, [path.join(root, "scripts", "build-commis.js")], { stdio: "ignore" });
  const built = read("dist", "commis", "index.html");
  const scripts = [...built.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(scripts[0], "errors.js");
  assert.ok(scripts.includes("config.js"));
  assert.ok(fs.existsSync(path.join(root, "dist", "commis", "errors.js")));
  assert.doesNotMatch(read("public", "index.html"), /errors\.js/);
  assert.ok(!fs.existsSync(path.join(root, "public", "errors.js")));
});

test("the privacy policy explains the reports, in English and French", () => {
  const en = read("sites", "commis", "pages", "privacy.html");
  const fr = read("sites", "commis", "pages", "confidentialite.html");
  assert.match(en, /<strong>Error reports:<\/strong> if Commis runs into an error/);
  assert.match(en, /It isn't linked to your account, and it contains nothing you've entered/);
  assert.match(en, /<strong>Error reports:<\/strong> deleted automatically after 60 days/);
  assert.match(en, /Supabase:<\/strong> accounts, data, invoices you send and error reports/);
  assert.match(fr, /<strong>Les rapports d'erreur :<\/strong> si Commis rencontre une erreur/);
  assert.match(fr, /Il n'est pas lié à votre compte et ne contient rien de ce que vous avez entré/);
  assert.match(fr, /<strong>Les rapports d'erreur :<\/strong> supprimés automatiquement après 60 jours/);
  assert.match(fr, /Supabase :<\/strong> comptes, données, factures envoyées et rapports d'erreur/);
});

/* ---------- the table, on a real Postgres, with no default rights: as Supabase's new projects give ---------- */

let db;
const asRole = async (role, sql) => {
  await db.exec(`set role ${role};`);
  try { return await db.query(sql); } finally { await db.exec("reset role;"); }
};
const REPORT = "insert into public.client_errors (message, source, line, col, stack, page, lang, browser, width) values ('TypeError: x', 'app.js', 1, 2, '', '/', 'fr', 'Safari 17 on iOS 17.5', 393)";

before(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  db = new PGlite();
  await db.exec("create role anon nologin; create role authenticated nologin; create role project_owner nologin nosuperuser; grant usage on schema public to anon, authenticated; grant all on schema public to project_owner;");
  const sql = read("supabase", "client_errors.sql");
  await db.exec("set role project_owner;");
  await db.exec(sql);
  await db.exec(sql);   // "safe to run more than once"
  await db.exec("reset role;");
});
after(async () => { if (db) await db.close(); });

test("a visitor can add a report, with all its steps running, and the server sets the time", async () => {
  await asRole("anon", REPORT);
  await asRole("authenticated", REPORT);
  const { rows } = await db.query("select count(*)::int as n, min(created_at) > now() - interval '1 minute' as fresh from public.client_errors");
  assert.equal(rows[0].n, 2);
  assert.equal(rows[0].fresh, true);
});

test("a visitor can't read, change or delete reports, or set the time or the number", async () => {
  for (const role of ["anon", "authenticated"]) {
    await assert.rejects(asRole(role, "select * from public.client_errors"), /permission denied/);
    await assert.rejects(asRole(role, "update public.client_errors set message = 'x'"), /permission denied/);
    await assert.rejects(asRole(role, "delete from public.client_errors"), /permission denied/);
    await assert.rejects(asRole(role, "insert into public.client_errors (message, created_at) values ('x', '2020-01-01')"), /permission denied/);
    await assert.rejects(asRole(role, "insert into public.client_errors (id, message) values (9, 'x')"), /non-DEFAULT value/);
  }
});

test("reports can't be empty or oversized", async () => {
  await assert.rejects(asRole("anon", "insert into public.client_errors (message) values ('')"), /check constraint/);
  await assert.rejects(asRole("anon", `insert into public.client_errors (message) values ('${"x".repeat(301)}')`), /check constraint/);
  await assert.rejects(asRole("anon", `insert into public.client_errors (message, stack) values ('x', '${"x".repeat(1001)}')`), /check constraint/);
});

test("the table tidies itself: nothing older than 60 days, and 5,000 reports at most", async () => {
  await db.exec("alter table public.client_errors disable trigger client_errors_stamp; alter table public.client_errors disable trigger client_errors_tidy;");
  await db.exec(`insert into public.client_errors (message, created_at) values ('old', now() - interval '61 days'), ('recent', now() - interval '59 days')`);
  await db.exec(`insert into public.client_errors (message, created_at) select 'bulk', now() - interval '1 day' from generate_series(1, 5100)`);
  await db.exec("alter table public.client_errors enable trigger client_errors_stamp; alter table public.client_errors enable trigger client_errors_tidy;");
  await asRole("anon", REPORT);   // any new report sets it off, even from a visitor with no rights of their own
  const { rows } = await db.query("select count(*)::int as n, count(*) filter (where message = 'old')::int as old from public.client_errors");
  assert.equal(rows[0].old, 0);
  assert.equal(rows[0].n, 5000);
  const newest = await db.query("select message from public.client_errors order by created_at desc, id desc limit 1");
  assert.equal(newest.rows[0].message, "TypeError: x", "the newest report is kept");
});
