/* People in an account: every role against the database's own rules. Part 20 runs on a real Postgres (PGlite, in memory), as the
 * role the app signs in with, so what each person can and can't do is proved, not assumed. Made-up data only.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const schema = fs.readFileSync(path.join(__dirname, "..", "supabase", "schema.sql"), "utf8");
const partsUpTo11 = () => schema.slice(0, schema.search(/^-- 11\. /m));
const part = (n) => new RegExp(`^-- ${n}\\. [\\s\\S]*?(?=^-- ${n + 1}\\. |(?![\\s\\S]))`, "m").exec(schema)[0];

const P = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const OWNER = P(1), ADMIN = P(2), COOK = P(3), COUNTER = P(4), BARTENDER = P(5), STRANGER = P(6), BAR_ADMIN = P(7), UNCONFIRMED = P(8);
const emails = { [OWNER]: "owner@x.test", [ADMIN]: "admin@x.test", [COOK]: "cook@x.test", [COUNTER]: "counter@x.test", [BARTENDER]: "bartender@x.test", [STRANGER]: "stranger@x.test", [BAR_ADMIN]: "baradmin@x.test", [UNCONFIRMED]: "new@x.test" };
const ID = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const LIME = ID(1), LIME_PRICE = ID(2), SALAD = ID(3), SALAD_LINE = ID(4), SYRUP = ID(5), SYRUP_LINE = ID(6), GIN = ID(7), GIN_PRICE = ID(8), GIMLET = ID(9), GIMLET_LINE = ID(10), LIME_COUNT = ID(11), GIN_COUNT = ID(12), INVOICE = ID(13);

let db, next = 100;
const fresh = () => ID(next++);
async function as(uid, fn) {
  await db.exec(`set test.uid = '${uid}'; set role authenticated;`);
  try { return await fn(); } finally { await db.exec("reset role; reset test.uid;"); }
}
const run = (uid, sql) => as(uid, () => db.exec(sql));
const rows = (uid, sql) => as(uid, async () => (await db.query(sql)).rows);
const ids = async (uid, table, where = "true") => (await rows(uid, `select id from public.${table} where ${where}`)).map((r) => r.id);
/** How many rows a write really touched: the database doesn't call a refused update an error, it just finds nothing to change. */
const changed = (uid, sql) => as(uid, async () => (await db.query(sql)).affectedRows);

before(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create schema auth;
    create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant usage on schema public to anon, authenticated;
  `);
  for (const [id, email] of Object.entries(emails)) await db.query("insert into auth.users values ($1, $2, $3)", [id, email, id === UNCONFIRMED ? null : new Date().toISOString()]);
  await db.exec(partsUpTo11() + part(16) + part(17) + part(18) + part(19) + part(20));

  // The restaurant, as its owner made it.
  await run(OWNER, `
    insert into public.ingredients (id, name, base, project) values ('${LIME}', 'Limes', 'unit', 'kitchen'), ('${GIN}', 'Gin', 'L', 'barback');
    insert into public.offers (id, ingredient_id, pack_cost, pack_qty, pack_unit, project) values ('${LIME_PRICE}', '${LIME}', 27, 54, 'unit', 'kitchen'), ('${GIN_PRICE}', '${GIN}', 34.5, 750, 'ml', 'barback');
    insert into public.recipes (id, name, kind, project) values ('${SALAD}', 'Salad', 'dish', 'kitchen'), ('${SYRUP}', 'Syrup', 'prep', 'kitchen'), ('${GIMLET}', 'Gimlet', 'dish', 'barback');
    insert into public.lines (id, recipe_id, pos, ingredient_id, qty, unit, project) values
      ('${SALAD_LINE}', '${SALAD}', 1, '${LIME}', 1, 'unit', 'kitchen'), ('${SYRUP_LINE}', '${SYRUP}', 1, '${LIME}', 1, 'unit', 'kitchen'), ('${GIMLET_LINE}', '${GIMLET}', 1, '${GIN}', 2, 'floz', 'barback');
    insert into public.counts (id, month, ingredient_id, qty, project) values ('${LIME_COUNT}', '2026-11', '${LIME}', 5, 'kitchen'), ('${GIN_COUNT}', '2026-11', '${GIN}', 3, 'barback');
    insert into public.saved_invoices (id, supplier, date, total, project) values ('${INVOICE}', 'Made-up', '2026-11-01', 100, 'kitchen');
    insert into public.settings (user_id, data) values ('${OWNER}', '{"categories": {}}');
    insert into public.settings_private (user_id, data) values ('${OWNER}', '{"stockMonths": {"2026-11": {"sales": 9000}}}');
  `);
  // Everyone invited by the owner, and joined.
  const invite = (mail, role, kitchen, barback, count) => `insert into public.members (account_id, email, role, kitchen, barback, can_count, account_name) values ('${OWNER}', '${mail}', '${role}', ${kitchen}, ${barback}, ${count}, 'Chez Test');`;
  await run(OWNER, invite(emails[ADMIN], "admin", true, true, false) + invite(emails[COOK], "employee", true, false, false) + invite(emails[COUNTER], "employee", true, false, true) + invite(emails[BARTENDER], "employee", false, true, false) + invite(emails[BAR_ADMIN], "admin", false, true, false));
  for (const u of [ADMIN, COOK, COUNTER, BARTENDER, BAR_ADMIN]) await run(u, `select public.accept_invite('${OWNER}')`);
});
after(() => db && db.close());

/* ---------- getting in ---------- */
test("a stranger sees nothing of the restaurant and can't write into it", async () => {
  for (const t of ["ingredients", "offers", "recipes", "lines", "counts", "saved_invoices"]) assert.deepEqual(await ids(STRANGER, t), [], t);
  assert.deepEqual(await rows(STRANGER, "select * from public.settings"), []);
  assert.deepEqual(await rows(STRANGER, "select * from public.members"), []);
  await assert.rejects(run(STRANGER, `insert into public.recipes (id, user_id, name, kind) values ('${fresh()}', '${OWNER}', 'X', 'dish')`), /row-level security/);
});

test("a stranger can't let themselves in", async () => {
  await assert.rejects(run(STRANGER, `insert into public.members (account_id, email, role) values ('${OWNER}', '${emails[STRANGER]}', 'admin')`), /row-level security/);
  await assert.rejects(run(STRANGER, `select public.accept_invite('${OWNER}')`), /no longer there/);
  assert.deepEqual(await ids(STRANGER, "ingredients"), []);
});

test("an invitation only works for the person it was sent to, once their email is confirmed", async () => {
  const other = "invited@x.test";
  await run(OWNER, `insert into public.members (account_id, email) values ('${OWNER}', '${other}')`);
  await assert.rejects(run(STRANGER, `select public.accept_invite('${OWNER}')`), /no longer there/);
  await run(OWNER, `insert into public.members (account_id, email) values ('${OWNER}', '${emails[UNCONFIRMED]}')`);
  await assert.rejects(run(UNCONFIRMED, `select public.accept_invite('${OWNER}')`), /Confirm your email/);
  assert.deepEqual(await rows(UNCONFIRMED, "select account_id from public.members"), [], "and can't even see it yet");
  await run(OWNER, `delete from public.members where email in ('${other}', '${emails[UNCONFIRMED]}')`);
});

test("nobody can join someone to an account by writing the row themselves, administrators included", async () => {
  await assert.rejects(run(ADMIN, `insert into public.members (account_id, email, user_id) values ('${OWNER}', 'x@x.test', '${STRANGER}')`), /permission denied/);
  await assert.rejects(run(OWNER, `update public.members set user_id = '${STRANGER}' where email = '${emails[COOK]}'`), /permission denied/);
  await assert.rejects(run(OWNER, `update public.members set accepted_at = now() where email = '${emails[COOK]}'`), /permission denied/);
});

test("an invitation can be turned down", async () => {
  await run(OWNER, `insert into public.members (account_id, email) values ('${OWNER}', '${emails[STRANGER]}')`);
  const seen = await rows(STRANGER, "select account_id, role from public.members");
  assert.equal(seen.length, 1);
  await run(STRANGER, `delete from public.members where account_id = '${OWNER}' and email = '${emails[STRANGER]}'`);
  assert.deepEqual(await rows(OWNER, `select email from public.members where email = '${emails[STRANGER]}'`), []);
});

/* ---------- who manages people ---------- */
test("the owner and administrators manage people; employees can't", async () => {
  await run(ADMIN, `insert into public.members (account_id, email) values ('${OWNER}', 'temp@x.test')`);
  assert.equal(await changed(ADMIN, `update public.members set can_count = true where account_id = '${OWNER}' and email = 'temp@x.test'`), 1);
  assert.equal(await changed(ADMIN, `delete from public.members where account_id = '${OWNER}' and email = 'temp@x.test'`), 1);
  await assert.rejects(run(COOK, `insert into public.members (account_id, email) values ('${OWNER}', 'temp@x.test')`), /row-level security/);
  assert.equal(await changed(COOK, `update public.members set role = 'admin' where email = '${emails[COOK]}'`), 0, "can't promote themselves");
  assert.equal(await changed(COOK, `update public.members set can_count = true where email = '${emails[COOK]}'`), 0);
  assert.equal(await changed(COOK, `delete from public.members where email = '${emails[COUNTER]}'`), 0, "can't remove anyone else");
  assert.equal((await rows(COOK, "select email from public.members")).length, 1, "sees only their own row");
});

test("someone can leave", async () => {
  await run(OWNER, `insert into public.members (account_id, email) values ('${OWNER}', '${emails[STRANGER]}')`);
  await run(STRANGER, `select public.accept_invite('${OWNER}')`);
  assert.equal((await ids(STRANGER, "ingredients")).length > 0, true);
  await run(STRANGER, `delete from public.members where account_id = '${OWNER}' and user_id = '${STRANGER}'`);
  assert.deepEqual(await ids(STRANGER, "ingredients"), [], "and sees nothing after");
});

/* ---------- an employee ---------- */
test("an employee sees prices and recipes on their side, but not the other side, invoices or typed sales", async () => {
  assert.deepEqual(await ids(COOK, "ingredients"), [LIME]);
  assert.deepEqual(await ids(COOK, "offers"), [LIME_PRICE]);
  assert.deepEqual((await ids(COOK, "recipes")).sort(), [SALAD, SYRUP].sort());
  assert.deepEqual(await ids(COOK, "saved_invoices"), []);
  assert.deepEqual(await rows(COOK, "select data from public.settings_private"), []);
  assert.equal((await rows(COOK, "select data from public.settings")).length, 1, "the sections are there to read");
});

test("an employee can't change a price, an item or someone else's recipe", async () => {
  assert.equal(await changed(COOK, `update public.offers set pack_cost = 1 where id = '${LIME_PRICE}'`), 0);
  assert.equal(await changed(COOK, `delete from public.offers where id = '${LIME_PRICE}'`), 0);
  assert.equal(await changed(COOK, `update public.ingredients set name = 'X', yield = 0.5 where id = '${LIME}'`), 0);
  assert.equal(await changed(COOK, `delete from public.ingredients where id = '${LIME}'`), 0);
  assert.equal(await changed(COOK, `update public.recipes set name = 'X' where id = '${SALAD}'`), 0);
  assert.equal(await changed(COOK, `delete from public.recipes where id = '${SALAD}'`), 0);
  assert.equal(await changed(COOK, `update public.lines set qty = 9 where id = '${SALAD_LINE}'`), 0);
  assert.equal(await changed(COOK, `delete from public.lines where id = '${SALAD_LINE}'`), 0);
  await assert.rejects(run(COOK, `insert into public.offers (id, user_id, ingredient_id, pack_cost, pack_qty, project) values ('${fresh()}', '${OWNER}', '${LIME}', 1, 1, 'kitchen')`), /row-level security/);
  await assert.rejects(run(COOK, `insert into public.lines (id, user_id, recipe_id, pos, ingredient_id, project) values ('${fresh()}', '${OWNER}', '${SALAD}', 2, '${LIME}', 'kitchen')`), /row-level security/);
  assert.equal(await changed(COOK, `update public.settings set data = '{}' where user_id = '${OWNER}'`), 0);
  assert.equal((await rows(OWNER, `select data from public.settings where user_id = '${OWNER}'`))[0].data.categories != null, true, "settings untouched");
});

test("an employee makes their own recipe, and changes and deletes only that", async () => {
  const mine = fresh(), line = fresh();
  await run(COOK, `insert into public.recipes (id, user_id, name, kind, project, created_by) values ('${mine}', '${OWNER}', 'Cook special', 'dish', 'kitchen', '${COOK}');
    insert into public.lines (id, user_id, recipe_id, pos, ingredient_id, qty, unit, project) values ('${line}', '${OWNER}', '${mine}', 1, '${LIME}', 2, 'unit', 'kitchen');`);
  assert.equal(await changed(COOK, `update public.recipes set name = 'Cook special 2' where id = '${mine}'`), 1);
  assert.equal(await changed(COOK, `update public.lines set qty = 3 where id = '${line}'`), 1);
  assert.equal(await changed(COUNTER, `update public.recipes set name = 'Mine now' where id = '${mine}'`), 0, "another employee can't touch it");
  assert.equal(await changed(ADMIN, `update public.recipes set menu = 'Fall' where id = '${mine}'`), 1, "an administrator can");
  assert.ok((await ids(OWNER, "recipes")).includes(mine), "it's in the restaurant's account");
  await assert.rejects(run(COOK, `insert into public.recipes (id, user_id, name, kind, project, created_by) values ('${fresh()}', '${OWNER}', 'As someone else', 'dish', 'kitchen', '${ADMIN}')`), /row-level security/);
  await assert.rejects(run(COOK, `update public.recipes set created_by = '${ADMIN}' where id = '${mine}'`), /row-level security/);
  await assert.rejects(run(COOK, `insert into public.recipes (id, user_id, name, kind, project, created_by) values ('${fresh()}', '${OWNER}', 'Other side', 'dish', 'barback', '${COOK}')`), /row-level security/);
  assert.equal(await changed(COOK, `delete from public.lines where id = '${line}'`), 1);
  assert.equal(await changed(COOK, `delete from public.recipes where id = '${mine}'`), 1);
});

test("an employee adds an item with an estimated price, flagged until an administrator has checked it", async () => {
  const item = fresh(), price = fresh(), hist = fresh();
  await run(COOK, `insert into public.ingredients (id, user_id, name, base, project, created_by, needs_check) values ('${item}', '${OWNER}', 'Yuzu', 'kg', 'kitchen', '${COOK}', true);
    insert into public.offers (id, user_id, ingredient_id, pack_cost, pack_qty, pack_unit, project) values ('${price}', '${OWNER}', '${item}', 20, 1, 'kg', 'kitchen');
    insert into public.price_history (id, user_id, ingredient_id, offer_id, pack_cost, pack_qty, project) values ('${hist}', '${OWNER}', '${item}', '${price}', 20, 1, 'kitchen');`);
  assert.equal(await changed(COOK, `update public.offers set pack_cost = 25 where id = '${price}'`), 1, "they can correct their estimate");
  await assert.rejects(run(COOK, `update public.ingredients set needs_check = false where id = '${item}'`), /row-level security/, "but can't clear the flag");
  await assert.rejects(run(COOK, `insert into public.ingredients (id, user_id, name, base, project, created_by, needs_check) values ('${fresh()}', '${OWNER}', 'No flag', 'kg', 'kitchen', '${COOK}', false)`), /row-level security/);
  await assert.rejects(run(COOK, `insert into public.ingredients (id, user_id, name, base, project, created_by, needs_check, locked_price) values ('${fresh()}', '${OWNER}', 'Locked', 'kg', 'kitchen', '${COOK}', true, 1)`), /row-level security/);
  assert.equal(await changed(COUNTER, `update public.offers set pack_cost = 1 where id = '${price}'`), 0, "another employee can't");
  // The administrator double checks it: from then on it's a price like any other.
  assert.equal(await changed(ADMIN, `update public.ingredients set needs_check = false, review = '' where id = '${item}'`), 1);
  assert.equal(await changed(COOK, `update public.offers set pack_cost = 1 where id = '${price}'`), 0);
  assert.equal(await changed(COOK, `update public.ingredients set name = 'X' where id = '${item}'`), 0);
  assert.equal(await changed(COOK, `delete from public.ingredients where id = '${item}'`), 0);
});

test("an employee's estimate can't be hung on someone else's item", async () => {
  await assert.rejects(run(COOK, `insert into public.offers (id, user_id, ingredient_id, pack_cost, pack_qty, project) values ('${fresh()}', '${OWNER}', '${LIME}', 1, 1, 'kitchen')`), /row-level security/);
});

/* ---------- counting ---------- */
test("only an employee with inventory access can count", async () => {
  assert.equal(await changed(COOK, `update public.counts set qty = 9 where id = '${LIME_COUNT}'`), 0);
  await assert.rejects(run(COOK, `insert into public.counts (id, user_id, month, ingredient_id, qty, project) values ('${fresh()}', '${OWNER}', '2026-12', '${LIME}', 1, 'kitchen')`), /row-level security/);
  assert.equal(await changed(COUNTER, `update public.counts set qty = 6 where id = '${LIME_COUNT}'`), 1);
  const made = fresh();
  await run(COUNTER, `insert into public.counts (id, user_id, month, ingredient_id, qty, project) values ('${made}', '${OWNER}', '2026-12', '${LIME}', 1, 'kitchen')`);
  assert.equal(await changed(COUNTER, `delete from public.counts where id = '${made}'`), 1);
});

test("inventory access covers counting and nothing else, and only on their side", async () => {
  assert.equal(await changed(COUNTER, `update public.offers set pack_cost = 1 where id = '${LIME_PRICE}'`), 0);
  assert.equal(await changed(COUNTER, `update public.counts set qty = 9 where id = '${GIN_COUNT}'`), 0, "Barback's count isn't theirs");
});

test("only an administrator closes or reopens a month", async () => {
  const closed = fresh();
  const insert = (id) => `insert into public.closed_months (id, user_id, month, project) values ('${id}', '${OWNER}', '2026-10', 'kitchen')`;
  await assert.rejects(run(COUNTER, insert(fresh())), /row-level security/);
  await run(ADMIN, insert(closed));
  assert.equal(await changed(COUNTER, `update public.closed_months set reopened_at = now() where id = '${closed}'`), 0);
  await assert.rejects(run(ADMIN, `update public.closed_months set total = 1 where id = '${closed}'`), /permission denied/, "a saved month still can't be edited");
  assert.equal(await changed(ADMIN, `update public.closed_months set reopened_at = now() where id = '${closed}'`), 1);
  assert.deepEqual(await rows(COOK, `select id from public.closed_months where id = '${closed}'`), [{ id: closed }], "employees can read it");
});

/* ---------- Commis, Barback or both ---------- */
test("Barback only: sees the kitchen's items and preps its cocktails use, but not its dishes or count", async () => {
  const items = await ids(BARTENDER, "ingredients"), prices = await ids(BARTENDER, "offers");
  for (const id of [LIME, GIN]) assert.ok(items.includes(id));
  for (const id of [LIME_PRICE, GIN_PRICE]) assert.ok(prices.includes(id));
  assert.deepEqual((await ids(BARTENDER, "recipes")).sort(), [SYRUP, GIMLET].sort(), "no Salad");
  assert.deepEqual((await ids(BARTENDER, "lines")).sort(), [SYRUP_LINE, GIMLET_LINE].sort(), "no Salad line");
  assert.deepEqual(await ids(BARTENDER, "counts"), [GIN_COUNT]);
});

test("Barback only: a cocktail of their own can use a kitchen item, and they can't change the kitchen", async () => {
  const mine = fresh(), line = fresh();
  await run(BARTENDER, `insert into public.recipes (id, user_id, name, kind, project, created_by) values ('${mine}', '${OWNER}', 'Lime rickey', 'dish', 'barback', '${BARTENDER}');
    insert into public.lines (id, user_id, recipe_id, pos, ingredient_id, qty, unit, project) values ('${line}', '${OWNER}', '${mine}', 1, '${LIME}', 1, 'unit', 'barback');`);
  assert.equal(await changed(BARTENDER, `update public.offers set pack_cost = 1 where id = '${LIME_PRICE}'`), 0);
  await assert.rejects(run(BARTENDER, `insert into public.recipes (id, user_id, name, kind, project, created_by) values ('${fresh()}', '${OWNER}', 'A dish', 'dish', 'kitchen', '${BARTENDER}')`), /row-level security/);
  await run(BARTENDER, `delete from public.lines where id = '${line}'; delete from public.recipes where id = '${mine}';`);
});

test("Commis only: sees nothing of Barback", async () => {
  assert.ok(!(await ids(COOK, "ingredients")).includes(GIN));
  assert.ok(!(await ids(COOK, "recipes")).includes(GIMLET));
  assert.ok(!(await ids(COOK, "lines")).includes(GIMLET_LINE));
  assert.ok(!(await ids(COOK, "counts")).includes(GIN_COUNT));
});

test("an administrator of one side changes that side only", async () => {
  assert.equal(await changed(BAR_ADMIN, `update public.offers set pack_cost = 35 where id = '${GIN_PRICE}'`), 1);
  assert.equal(await changed(BAR_ADMIN, `update public.offers set pack_cost = 1 where id = '${LIME_PRICE}'`), 0, "can read the kitchen's, not change it");
  assert.equal(await changed(BAR_ADMIN, `update public.ingredients set name = 'X' where id = '${LIME}'`), 0);
});

/* ---------- administrators ---------- */
test("an administrator changes prices, sees invoices and typed sales, and works in the restaurant's account", async () => {
  assert.equal(await changed(ADMIN, `update public.offers set pack_cost = 28 where id = '${LIME_PRICE}'`), 1);
  assert.deepEqual(await ids(ADMIN, "saved_invoices"), [INVOICE]);
  assert.equal((await rows(ADMIN, "select data from public.settings_private"))[0].data.stockMonths["2026-11"].sales, 9000);
  assert.equal(await changed(ADMIN, `update public.settings set data = '{"categories": {"x": 1}}' where user_id = '${OWNER}'`), 1);
});

/* ---------- my own stuff ---------- */
test("my own account stays mine: joining a restaurant shows them nothing of it, and I keep it", async () => {
  const own = fresh();
  await run(COOK, `insert into public.recipes (id, name, kind) values ('${own}', 'My own recipe', 'dish')`);
  assert.deepEqual(await rows(COOK, `select user_id, project from public.recipes where id = '${own}'`), [{ user_id: COOK, project: "kitchen" }]);
  assert.deepEqual(await rows(OWNER, `select id from public.recipes where id = '${own}'`), [], "the restaurant's owner can't see it");
  assert.deepEqual(await rows(ADMIN, `select id from public.recipes where id = '${own}'`), [], "nor an administrator");
  assert.equal(await changed(COOK, `update public.recipes set name = 'Still mine' where id = '${own}'`), 1);
  await run(COOK, `delete from public.members where account_id = '${OWNER}' and user_id = '${COOK}'`);
  assert.deepEqual(await rows(COOK, `select name from public.recipes where id = '${own}'`), [{ name: "Still mine" }], "leaving keeps it");
  assert.deepEqual(await ids(COOK, "offers"), [], "and the restaurant's prices are gone from view");
  // Back in, for the other tests.
  await run(OWNER, `insert into public.members (account_id, email, role, kitchen, barback, can_count) values ('${OWNER}', '${emails[COOK]}', 'employee', true, false, false)`);
  await run(COOK, `select public.accept_invite('${OWNER}')`);
});

test("a recipe an employee made stays with the restaurant when they go", async () => {
  await run(OWNER, `insert into public.members (account_id, email) values ('${OWNER}', '${emails[STRANGER]}')`);
  await run(STRANGER, `select public.accept_invite('${OWNER}')`);
  const made = fresh();
  await run(STRANGER, `insert into public.recipes (id, user_id, name, kind, project, created_by) values ('${made}', '${OWNER}', 'Left behind', 'dish', 'kitchen', '${STRANGER}')`);
  await run(STRANGER, `delete from public.members where account_id = '${OWNER}' and user_id = '${STRANGER}'`);
  assert.deepEqual(await ids(OWNER, "recipes", `id = '${made}'`), [made]);
  assert.equal(await changed(STRANGER, `update public.recipes set name = 'Took it' where id = '${made}'`), 0, "and they can no longer change it");
  assert.equal(await changed(OWNER, `delete from public.recipes where id = '${made}'`), 1);
});

test("part 20 can be pasted again, and the anonymous key gets nowhere", async () => {
  await db.exec(part(20));
  assert.deepEqual(await ids(ADMIN, "saved_invoices"), [INVOICE]);
  await db.exec("set role anon;");
  try { await assert.rejects(db.query("select * from public.members"), /permission denied/); await assert.rejects(db.query(`select public.my_accounts('any', 'read')`), /permission denied/); await assert.rejects(db.query(`select public.accept_invite('${OWNER}')`), /permission denied/); }
  finally { await db.exec("reset role;"); }
});
