/* Barback: a bar's own records in the same account. Made-up data only. The database's rules run on a real Postgres (PGlite, in
 * memory) as the role the app signs in with, and the store runs against a stand-in for Supabase, so both are proved, not assumed.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Units = require("../public/units.js");
const Costing = require("../public/costing.js");
const Barback = require("../public/barback.js");

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

/* ---------- measures ---------- */
test("a bar's measures turn into litres, and the kitchen's lists don't offer them", () => {
  close(Units.convert(2, "floz", "L"), 0.059147);
  close(Units.convert(1, "barspoon", "ml"), 5);
  close(Units.convert(1, "dash", "ml"), 0.92);
  assert.equal(Units.parseUnit("oz"), "oz", "an invoice's oz stays a weight");
  assert.deepEqual(Units.choicesFor("L"), ["L", "ml"]);
  const app = read("public/app.js");
  assert.match(app, /const KITCHEN_PACKS = Object\.keys\(Units\.UNITS\)\.filter\(\(u\) => !Units\.UNITS\[u\]\.bar\)/);
});

/* ---------- bottles and cocktails ---------- */
const gin = { id: "gin", name: "Gin", base: "L", yield: 1, measures: Barback.withBottleSize({}, 750), preferred_offer_id: "o1" };
const barData = () => ({
  ingredients: [gin, { id: "lime", name: "Limes", base: "unit", yield: 1 }, { id: "sugar", name: "Sugar", base: "kg", yield: 1 }],
  offers: [{ id: "o1", ingredient_id: "gin", pack_cost: 34.5, pack_qty: 750, pack_unit: "ml" }, { id: "o2", ingredient_id: "lime", pack_cost: 27, pack_qty: 54, pack_unit: "unit" }, { id: "o3", ingredient_id: "sugar", pack_cost: 30, pack_qty: 20, pack_unit: "kg" }],
  recipes: [{ id: "syrup", name: "Syrup", kind: "prep", yield_qty: 1.5, yield_unit: "L" }, { id: "gimlet", name: "Gimlet", kind: "dish", yield_qty: 1, yield_unit: "portion", multiplier: Barback.MULTIPLIER, menu_price: 14 }],
  lines: [
    { id: "s1", recipe_id: "syrup", pos: 1, ingredient_id: "sugar", qty: 1, unit: "kg" },
    { id: "l1", recipe_id: "gimlet", pos: 1, ingredient_id: "gin", qty: 2, unit: "floz" },
    { id: "l2", recipe_id: "gimlet", pos: 2, ingredient_id: "lime", qty: 0.5, unit: "unit" },
    { id: "l3", recipe_id: "gimlet", pos: 3, sub_recipe_id: "syrup", qty: 0.75, unit: "floz" },
  ],
});

test("a cocktail costs out in ounces, with the kitchen's lime and syrup alongside the bar's gin", () => {
  const s = Costing.create(barData()).summary("gimlet");
  assert.deepEqual(s.problems, []);
  close(s.lines[0].cost, 46 * 0.059147);        // $46.00 a litre, 2 oz
  close(s.lines[1].cost, 0.25);
  close(s.lines[2].cost, 1 * 0.75 * 0.0295735); // $1.50 of sugar makes 1.5 L, so $1.00 a litre
  close(s.suggested, s.perPortion * 5);
  close(s.foodCost, s.perPortion / 14);
});

test("a kitchen price moves the cocktail", () => {
  const d = barData(), before = Costing.create(d).summary("gimlet").perPortion;
  d.offers[1].pack_cost = 54;
  close(Costing.create(d).summary("gimlet").perPortion - before, 0.25);
});

test("a bottle with a size is counted in bottles, and a price can be for a case of them", () => {
  const c = Costing.create(barData());
  assert.ok(c.countChoices(gin, false).includes("bottle"));
  close(c.itemAmount(gin, 3.4, "bottle"), 2.55);
  close(c.packAmount(6, "bottle", gin), 4.5);
  assert.ok(!c.countChoices({ id: "x", base: "L", yield: 1 }, false).includes("bottle"), "no size, no bottles");
});

test("a bottle's size lives in its measures and leaves anything else there alone", () => {
  assert.equal(Barback.bottleMl(gin), 750);
  assert.equal(Barback.bottleMl({ base: "L" }), null);
  const other = { qty: 1, unit: "portion" };
  assert.deepEqual(Barback.withBottleSize({ measures: [{ qty: 0.75, unit: "L" }, { qty: 1, unit: "bottle" }, other] }, 1000), [{ qty: 1, unit: "L" }, { qty: 1, unit: "bottle" }, other]);
  assert.deepEqual(Barback.withBottleSize({ measures: [{ qty: 0.75, unit: "L" }, { qty: 1, unit: "bottle" }, other] }, null), [other]);
  assert.equal(Barback.withBottleSize({ measures: [{ qty: 0.75, unit: "L" }, { qty: 1, unit: "bottle" }] }, null), null);
});

test("only a pack the size of one bottle sets a bottle's size", () => {
  assert.equal(Barback.sizeFromPack(750, "ml"), 750);
  assert.equal(Barback.sizeFromPack(1.14, "L"), 1140);
  assert.equal(Barback.sizeFromPack(4.5, "L"), null, "a case");
  assert.equal(Barback.sizeFromPack(58, "L"), null, "a keg");
  assert.equal(Barback.sizeFromPack(6, "unit"), null);
});

test("what a bottle and an ounce cost", () => {
  const p = Barback.pours(46, 750);
  close(p.bottle, 34.5);
  close(p.oz, 46 * 0.0295735);
  assert.equal(Barback.pours(46, null).bottle, null);
});

/* ---------- the count: full bottles counted, opened ones weighed ---------- */
test("full bottles and a weighed opened one add up", () => {
  assert.equal(Barback.hybridCount(3, "840", 480, 1190).qty, 3.507);   // 360 g of 710 g left
  assert.equal(Barback.hybridCount(3, "", 480, 1190).qty, 3);
  assert.equal(Barback.hybridCount(null, "840", 480, 1190).qty, 0.507, "no full ones");
});

test("two opened bottles can go on the scale, typed with a plus", () => {
  assert.equal(Barback.hybridCount(3, "840+700", 480, 1190).qty, 3.817);
  assert.equal(Barback.hybridCount(3, "840 + 700", 480, 1190).qty, 3.817);
  assert.equal(Barback.hybridCount(0, "840,5", 480, 1190).qty, 0.508);
});

test("a pourer's few grams don't matter, but a wrong number is caught", () => {
  assert.equal(Barback.openBottles("1200", 480, 1190).bottles, 1, "a little over full is full");
  assert.equal(Barback.openBottles("470", 480, 1190).bottles, 0, "a little under empty is empty");
  assert.match(Barback.openBottles("5000", 480, 1190).problem, /heavier than a full bottle/);
  assert.match(Barback.openBottles("100", 480, 1190).problem, /lighter than an empty bottle/);
  assert.match(Barback.openBottles("abc", 480, 1190).problem, /grams/);
  assert.match(Barback.openBottles("840+", 480, 1190).problem, /grams/);
  assert.match(Barback.openBottles("840", null, 1190).problem, /empty and full weights/);
});

test("weighing needs both weights, with full the heavier", () => {
  assert.ok(Barback.canWeigh({ empty_g: 480, full_g: 1190 }));
  assert.ok(!Barback.canWeigh({ empty_g: 480 }));
  assert.ok(!Barback.canWeigh({ full_g: 1190 }));
  assert.ok(!Barback.canWeigh({ empty_g: 1190, full_g: 480 }));
});

/* ---------- wording ---------- */
test("the kitchen's words become the bar's, whole words only", () => {
  assert.equal(Barback.say("+ New dish"), "+ New cocktail");
  assert.equal(Barback.say("Dishes and preps"), "Cocktails and preps");
  assert.equal(Barback.say("Food cost 22%"), "Pour cost 22%");
  assert.equal(Barback.say("Target: cost × multiplier (×4 by default, a 25% food cost)."), "Target: cost × multiplier (×5 by default, a 20% pour cost).");
  assert.equal(Barback.say("Cost / portion"), "Cost / drink");
  assert.equal(Barback.say("Inventory: November"), "Count: November");
  assert.equal(Barback.say("+ New ingredient"), "+ New bottle");
  assert.equal(Barback.say("Radish seafood portions"), "Radish seafood drinks", "inside a word stays");
  assert.equal(Barback.say("Add its ingredients below"), "Add its ingredients below", "what goes in a cocktail is still an ingredient");
});

test("a bar starts with its own sections, and they all count toward the pour cost", () => {
  const { categories: c } = Barback.firstSettings();
  assert.ok(c.ingredients.includes("Gin") && c.dishes.includes("Classics"));
  for (const s of [...c.ingredients, c.prepSection]) assert.equal(c.groups[s], "food", s);
});

/* ---------- the store: one set of records at a time ---------- */
const TABLE_NAMES = ["ingredients", "offers", "price_history", "recipes", "lines", "counts", "closed_months", "saved_invoices"];

/** store.js on its own, with a stand-in for Supabase's web address. `columns: false`: part 19 hasn't been run. */
function storeWith({ barback = true, columns = true, rows = {}, settings = {} } = {}) {
  const db = Object.fromEntries(TABLE_NAMES.map((t) => [t, (rows[t] || []).map((r) => ({ ...r }))]));
  const calls = [];
  let saved = settings;
  const fetch = async (url, opts = {}) => {
    const u = new URL(url), table = u.pathname.split("/").pop(), method = opts.method || "GET", q = u.searchParams;
    calls.push({ method, table, query: u.search, body: opts.body ? JSON.parse(opts.body) : undefined });
    const answer = (status, body) => ({ ok: status < 300, status, statusText: String(status), json: async () => body });
    if (table === "settings") {
      if (method === "GET") return answer(200, [{ data: saved }]);
      saved = JSON.parse(opts.body).data;
      return answer(201, null);
    }
    if (!columns && /project|empty_g|full_bottles/.test(q.get("select") || "")) return answer(400, { message: "column does not exist" });
    if (method === "GET") {
      const from = +(q.get("offset") || 0);
      return answer(200, q.get("limit") === "1" ? db[table].slice(0, 1) : db[table].slice(from, from + 1000));
    }
    if (method === "POST") {
      for (const r of [].concat(JSON.parse(opts.body))) {
        if (!columns && ("project" in r || "empty_g" in r || "full_bottles" in r)) return answer(400, { message: "column does not exist" });
        const at = db[table].findIndex((x) => x.id === r.id);
        if (at >= 0) db[table][at] = { ...db[table][at], ...r }; else db[table].push(r);
      }
      return answer(201, null);
    }
    if (method === "PATCH") {
      const id = q.get("id").replace("eq.", ""), row = db[table].find((x) => x.id === id);
      Object.assign(row, JSON.parse(opts.body));
      return answer(200, null);
    }
    if (method === "DELETE") {
      const only = q.get("project");
      db[table] = db[table].filter((r) => (only ? (r.project || "kitchen") !== only.replace("eq.", "") : false));
      return answer(200, null);
    }
    throw new Error("not expected: " + method);
  };
  const site = barback ? { edition: "commis", barback: true } : { edition: "commis" };
  const ctx = { fetch, URL, atob, console, Auth: { token: async () => "t", signedIn: () => true }, localStorage: { getItem: () => null, setItem() {} },
    window: { COSTING_CONFIG: { supabaseUrl: "https://x.test", supabaseAnonKey: "k", site } } };
  vm.createContext(ctx);
  vm.runInContext(read("public/store.js") + "\nthis.Store = Store;", ctx);
  return { Store: ctx.Store, db: () => db, calls, saved: () => saved };
}
const A_ROW = { id: "a", name: "Limes", project: "kitchen" }, B_ROW = { id: "b", name: "Gin", project: "barback" };

test("each side sees its own rows, and the other side's are there to read", async () => {
  const { Store } = storeWith({ rows: { ingredients: [A_ROW, B_ROW, { id: "old", name: "Before part 19" }] } });
  const kitchen = await Store.current().loadAll();
  assert.deepEqual([...kitchen.ingredients].map((r) => r.id), ["a", "old"], "no project is the kitchen's");
  assert.deepEqual([...Store.borrowed().ingredients].map((r) => r.id), ["b"]);
  Store.setProject("barback");
  const bar = await Store.current().loadAll();
  assert.deepEqual([...bar.ingredients].map((r) => r.id), ["b"]);
  assert.deepEqual([...Store.borrowed().ingredients].map((r) => r.id), ["a", "old"]);
});

test("what's written lands in the side that's showing", async () => {
  const { Store, db } = storeWith();
  Store.setProject("barback");
  const s = Store.current();
  await s.loadAll();
  await s.insert("ingredients", Store.shape("ingredients", { id: "g", name: "Gin", base: "L", empty_g: 480, full_g: 1190 }));
  await s.upsert("counts", [Store.shape("counts", { id: "c", month: "2026-11", ingredient_id: "g", qty: 3.5, unit: "bottle", full_bottles: 3, open_g: "840" })]);
  assert.equal(db().ingredients[0].project, "barback");
  assert.equal(db().ingredients[0].full_g, 1190);
  assert.equal(db().counts[0].project, "barback");
  assert.equal(db().counts[0].open_g, "840");
  Store.setProject("kitchen");
  await s.insert("ingredients", { id: "k", name: "Limes" });
  assert.equal(db().ingredients[1].project, "kitchen");
});

test("replacing one side's records leaves the other's alone", async () => {
  const { Store, db, calls } = storeWith({ rows: { ingredients: [A_ROW, B_ROW] } });
  Store.setProject("barback");
  const s = Store.current();
  await s.loadAll();
  await s.replaceAll({ ingredients: [{ id: "new", name: "Rum" }], offers: [], price_history: [], recipes: [], lines: [], counts: [] });
  assert.ok(calls.filter((c) => c.method === "DELETE").every((c) => c.query.includes("project=eq.barback")));
  assert.deepEqual(db().ingredients.map((r) => [r.id, r.project]), [["a", "kitchen"], ["new", "barback"]]);
});

test("settings: Barback's sit inside the one row, and neither side loses the other's", async () => {
  const { Store, saved } = storeWith({ settings: { drive: { sheet: "kitchen sheet" } } });
  const s = Store.current();
  await s.loadAll();
  assert.deepEqual(JSON.parse(JSON.stringify(await s.getSettings())), { drive: { sheet: "kitchen sheet" } });
  Store.setProject("barback");
  assert.deepEqual(JSON.parse(JSON.stringify(await s.getSettings())), {});
  await s.saveSettings({ drive: { sheet: "bar sheet" } });
  assert.deepEqual(JSON.parse(JSON.stringify(saved())), { drive: { sheet: "kitchen sheet" }, barback: { drive: { sheet: "bar sheet" } } });
  Store.setProject("kitchen");
  const kitchen = await s.getSettings();
  assert.equal(kitchen.barback, undefined, "the kitchen's screens never see it");
  await s.saveSettings({ ...kitchen, lastBackup: "2026-11-07" });
  assert.deepEqual(JSON.parse(JSON.stringify(saved())), { drive: { sheet: "kitchen sheet" }, lastBackup: "2026-11-07", barback: { drive: { sheet: "bar sheet" } } });
});

test("until part 19 has been run, the kitchen carries on and Barback stays hidden", async () => {
  const { Store, db } = storeWith({ columns: false, rows: { ingredients: [{ id: "old", name: "Limes" }] } });
  Store.setProject("barback"); // someone who was last in Barback
  const s = Store.current();
  const data = await s.loadAll();
  assert.equal(Store.barbackReady(), false);
  assert.equal(Store.project(), "kitchen");
  assert.equal(data.ingredients.length, 1);
  await s.insert("ingredients", Store.shape("ingredients", { id: "new", name: "Sugar" }));
  await s.insert("counts", Store.shape("counts", { id: "c", month: "2026-11", ingredient_id: "new", qty: 1 }));
  assert.equal(db().ingredients.length, 2, "saved without Barback's columns");
  assert.ok(!("project" in db().ingredients[1]) && !("empty_g" in db().ingredients[1]));
});

test("a site without Barback asks for nothing new and writes nothing new", async () => {
  const { Store, calls, db, saved } = storeWith({ barback: false, rows: { ingredients: [{ id: "old", name: "Limes" }] }, settings: { keep: 1 } });
  const s = Store.current();
  const data = await s.loadAll();
  assert.equal(data.ingredients.length, 1);
  assert.equal(Store.barbackReady(), false);
  assert.ok(!calls.some((c) => /project|empty_g|full_bottles/.test(decodeURIComponent(c.query))), "no extra requests");
  await s.insert("ingredients", Store.shape("ingredients", { id: "new", name: "Sugar" }));
  assert.ok(!("project" in db().ingredients[1]) && !("empty_g" in db().ingredients[1]));
  await s.saveSettings({ ...(await s.getSettings()), more: 2 });
  assert.deepEqual(JSON.parse(JSON.stringify(saved())), { keep: 1, more: 2 });
});

/* ---------- the screens: what must hold ---------- */
test("Barback can't change the kitchen's rows, and the kitchen looks after what Barback uses", () => {
  const app = read("public/app.js");
  assert.match(app, /async function patch\(table, id, changes\) \{\s+if \(fromKitchen\(table, id\)\) throw new Error/);
  assert.match(app, /const set = new Set\(\[\]\.concat\(ids\)\.filter\(\(id\) => !fromKitchen\(table, id\)\)\);/);
  assert.match(app, /\$\{used\.length \|\| inBar\.length \? `disabled/, "an item a cocktail uses can't be deleted");
  assert.match(app, /const inBar = barUses\("sub_recipe_id", r\.id\);\s+if \(inBar\.length\)/, "nor a prep");
  assert.match(app, /\.\.\.barLines\("ingredient_id", from\.id\)\]/, "a merge moves Barback's lines");
  assert.match(app, /\.\.\.barLines\("sub_recipe_id", from\.id\)\]/);
  assert.match(app, /if \(linked\) \{ toast\(`Barback's cocktails use/, "and an import won't pull items from under them");
});

test("switching waits for saves, and each side keeps its own deleted things and invoices in progress", () => {
  const app = read("public/app.js");
  assert.match(app, /for \(let k = 0; k < 100 && write\.busy; k\+\+\)/);
  assert.match(app, /TRASH = \(BAR \? "costing\.trash\.barback" : "costing\.trash"\) \+ whose/);
  assert.match(app, /INV_KEY = \(BAR \? "costing\.invoiceWork\.barback" : "costing\.invoiceWork"\) \+ whose/);
});

test("Commis has Barback and people in an account turned on", () => {
  assert.match(read("sites/commis/config.js"), /barback: true, teams: true/);
});

/* ---------- the database's rules ---------- */
const schema = read("supabase/schema.sql");
const partsUpTo11 = () => schema.slice(0, schema.search(/^-- 11\. /m));
const part = (n) => new RegExp(`^-- ${n}\\. [\\s\\S]*?(?=^-- ${n + 1}\\. |(?![\\s\\S]))`, "m").exec(schema)[0];
const A = "00000000-0000-4000-8000-00000000000a", B = "00000000-0000-4000-8000-00000000000b";
const ID = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let pg;
const as = async (uid, sql) => {
  await pg.exec(`set test.uid = '${uid}'; set role authenticated;`);
  try { return await pg.exec(sql); } finally { await pg.exec("reset role;"); }
};
const closeMonth = (id, month, project) => `insert into public.closed_months (id, month${project ? ", project" : ""}) values ('${id}', '${month}'${project ? `, '${project}'` : ""});`;

before(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  pg = new PGlite();
  await pg.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant usage on schema public to anon, authenticated;
    insert into auth.users values ('${A}'), ('${B}');
  `);
  await pg.exec(partsUpTo11() + part(16) + part(17) + part(18));
  // Rows from before part 19.
  await as(A, `insert into public.ingredients (id, name, base) values ('${ID(1)}', 'Limes', 'unit');`);
  await as(A, closeMonth(ID(50), "2026-09"));
  await pg.exec(part(19));
});
after(() => pg && pg.close());

test("what was there before part 19 is the kitchen's, untouched", async () => {
  const { rows } = await pg.query(`select name, project from public.ingredients where id = '${ID(1)}'`);
  assert.deepEqual(rows, [{ name: "Limes", project: "kitchen" }]);
  const closed = await pg.query(`select project from public.closed_months where id = '${ID(50)}'`);
  assert.equal(closed.rows[0].project, "kitchen");
});

test("a month closes once on each side, and only once on each", async () => {
  await as(A, closeMonth(ID(51), "2026-09", "barback"));
  await assert.rejects(as(A, closeMonth(ID(52), "2026-09", "barback")), /closed_months_one_standing/);
  await assert.rejects(as(A, closeMonth(ID(53), "2026-09")), /closed_months_one_standing/);
});

test("a saved month still can't be changed, on either side", async () => {
  await assert.rejects(as(A, `update public.closed_months set total = 1 where id = '${ID(51)}'`), /permission denied/);
  await assert.rejects(as(A, `delete from public.closed_months where id = '${ID(51)}'`), /permission denied/);
});

test("a cocktail's line can use a kitchen item, which then can't be deleted from under it", async () => {
  await as(A, `insert into public.recipes (id, name, kind, project) values ('${ID(2)}', 'Gimlet', 'dish', 'barback');
    insert into public.lines (id, recipe_id, pos, ingredient_id, qty, unit, project) values ('${ID(3)}', '${ID(2)}', 1, '${ID(1)}', 0.5, 'unit', 'barback');`);
  await assert.rejects(as(A, `delete from public.ingredients where id = '${ID(1)}'`), /foreign key/);
});

test("a bottle's weights and a count made of full and weighed bottles save", async () => {
  await as(A, `insert into public.ingredients (id, name, base, project, empty_g, full_g) values ('${ID(4)}', 'Gin', 'L', 'barback', 480, 1190);
    insert into public.counts (id, month, ingredient_id, qty, unit, full_bottles, open_g, project) values ('${ID(5)}', '2026-11', '${ID(4)}', 3.817, 'bottle', 3, '840+700', 'barback');`);
  const { rows } = await pg.query(`select full_bottles, open_g from public.counts where id = '${ID(5)}'`);
  assert.equal(+rows[0].full_bottles, 3);
  assert.equal(rows[0].open_g, "840+700");
});

test("only the two sides exist, and another account still sees nothing", async () => {
  await assert.rejects(as(A, `insert into public.ingredients (id, name, project) values ('${ID(6)}', 'X', 'other')`), /check/);
  const { rows } = await (async () => { await pg.exec(`set test.uid = '${B}'; set role authenticated;`); try { return await pg.query("select id from public.ingredients"); } finally { await pg.exec("reset role;"); } })();
  assert.equal(rows.length, 0);
});

test("part 19 can be pasted again", async () => {
  await pg.exec(part(19));
  await pg.exec(part(17) + part(19));
  const { rows } = await pg.query("select count(*)::int as n from public.closed_months");
  assert.ok(rows[0].n >= 2, "nothing lost");
  await assert.rejects(as(A, closeMonth(ID(54), "2026-09", "barback")), /closed_months_one_standing/);
});
