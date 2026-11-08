/* People in an account, from the store's side: which account every request names, and the month's typed sales kept apart.
 * store.js runs on its own against a stand-in for Supabase's web address. Made-up data only.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ME = "00000000-0000-4000-8000-00000000000a", RESTAURANT = "00000000-0000-4000-8000-00000000000b";
const jwt = (sub) => `x.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.x`;

function storeWith({ settings = {}, kept = null, members = [] } = {}) {
  const calls = [], saved = {};
  const fetch = async (url, opts = {}) => {
    const u = new URL(url), table = u.pathname.split("/").pop(), method = opts.method || "GET";
    calls.push({ method, table, query: decodeURIComponent(u.search), body: opts.body ? JSON.parse(opts.body) : undefined });
    const answer = (body) => ({ ok: true, status: 200, json: async () => body });
    if (method !== "GET") { saved[table] = JSON.parse(opts.body); return answer(null); }
    if (table === "members") return answer(members);
    if (table === "settings") return answer([{ data: settings }]);
    if (table === "settings_private") return answer(kept ? [{ data: kept }] : []);
    return answer([]);
  };
  const ctx = { fetch, URL, atob: (s) => Buffer.from(s, "base64").toString("binary"), escape, decodeURIComponent, console,
    Auth: { token: async () => jwt(ME), signedIn: () => true, email: () => "me@x.test" }, localStorage: { getItem: () => null, setItem() {} },
    window: { COSTING_CONFIG: { supabaseUrl: "https://x.test", supabaseAnonKey: "k", site: { edition: "commis", barback: true, teams: true } } } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "public", "store.js"), "utf8") + "\nthis.Store = Store;", ctx);
  return { Store: ctx.Store, calls, saved };
}
const plain = (x) => JSON.parse(JSON.stringify(x));

test("every read names the account showing: mine, or the restaurant's once I've switched to it", async () => {
  const { Store, calls } = storeWith({ members: [{ account_id: RESTAURANT, user_id: ME, email: "me@x.test", role: "employee" }] });
  const s = Store.current();
  await s.loadTeam();
  assert.equal(Store.account(), ME);
  await s.loadAll();
  const reads = calls.filter((c) => c.method === "GET" && !["members"].includes(c.table) && !/limit=1(&|$)/.test(c.query));
  assert.ok(reads.length > 0 && reads.every((c) => c.query.includes(`user_id=eq.${ME}`)), "my own");
  Store.setAccount(RESTAURANT);
  calls.length = 0;
  await s.loadAll();
  await s.insert("recipes", [{ id: "r", name: "X" }]);
  assert.ok(calls.filter((c) => c.method === "GET" && !/limit=1(&|$)/.test(c.query)).every((c) => c.query.includes(`user_id=eq.${RESTAURANT}`)));
  assert.equal(calls.find((c) => c.method === "POST").body[0].user_id, RESTAURANT, "and what's written goes in their account");
});

test("an account I've left, or never joined, falls back to my own", async () => {
  const { Store } = storeWith({ members: [] });
  Store.setAccount(RESTAURANT);
  await Store.current().loadTeam();
  assert.equal(Store.account(), ME);
});

test("an invitation waiting for my email is told apart from an account I've joined", async () => {
  const { Store } = storeWith({ members: [{ account_id: RESTAURANT, user_id: null, email: "me@x.test", role: "employee" }, { account_id: "other", user_id: null, email: "someone@x.test" }] });
  const team = await Store.current().loadTeam();
  assert.equal(team.joined.length, 0);
  assert.deepEqual(plain(team.invited.map((m) => m.account_id)), [RESTAURANT]);
});

test("the month's typed sales are saved apart, where only administrators can read them", async () => {
  const { Store, saved } = storeWith();
  const s = Store.current();
  await s.loadTeam();
  await s.saveSettings({ categories: { x: 1 }, stockMonths: { "2026-11": { sales: 9000 } }, barback: { stockMonths: { "2026-11": { sales: 300 } }, categories: { y: 1 } } });
  assert.deepEqual(plain(saved.settings.data), { categories: { x: 1 }, barback: { categories: { y: 1 } } });
  assert.deepEqual(plain(saved.settings_private.data), { stockMonths: { "2026-11": { sales: 9000 } }, barback: { stockMonths: { "2026-11": { sales: 300 } } } });
});

test("bringing in whole sheets is for the account's owner, in their own account", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  assert.match(app, /\$\{SITE\.commis \|\| BAR \|\| ACCOUNT \? "" : `<section class="card">\s+<h2>Import your sheets<\/h2>/);
  assert.match(app, /async "import-file"\(el\) \{\s+const file = el\.files && el\.files\[0\];\s+if \(!file\) return;\s+if \(ACCOUNT\) \{ toast\(/);
});

test("reading puts them back together; a month typed on an older page after the move wins over the moved copy", async () => {
  const { Store } = storeWith({
    settings: { categories: { x: 1 }, stockMonths: { "2026-11": { sales: 9500 } } },
    kept: { stockMonths: { "2026-10": { sales: 8000 }, "2026-11": { sales: 9000 } }, barback: { stockMonths: { "2026-11": { sales: 300 } } } },
  });
  const s = Store.current();
  await s.loadTeam();
  const kitchen = plain(await s.getSettings());
  assert.deepEqual(kitchen.stockMonths, { "2026-10": { sales: 8000 }, "2026-11": { sales: 9500 } });
  Store.setProject("barback");
  assert.deepEqual(plain(await s.getSettings()).stockMonths, { "2026-11": { sales: 300 } });
});
