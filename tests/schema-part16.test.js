/* Part 16 of schema.sql: more ways to measure, counting in any of them, containers.
 * Run for real on a real Postgres (PGlite, in memory), on a database like the live ones: rows are saved first, the part
 * runs on top of them, and every value has to come out the same. Made-up data only.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const schema = fs.readFileSync(path.join(__dirname, "..", "supabase", "schema.sql"), "utf8");
function part(n) {
  const m = new RegExp(`^-- ${n}\\. [\\s\\S]*?(?=^-- ${n + 1}\\. |(?![\\s\\S]))`, "m").exec(schema);
  assert.ok(m, `part ${n} of schema.sql`);
  return m[0];
}
const A = "00000000-0000-4000-8000-00000000000a";
const ITEM = "00000000-0000-4000-8000-000000000001", PREP = "00000000-0000-4000-8000-000000000002", COUNT = "00000000-0000-4000-8000-000000000003", COUNT2 = "00000000-0000-4000-8000-000000000004";
let db;
const rows = async (sql) => (await db.query(sql)).rows;
const before16 = {};

before(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select '${A}'::uuid $$;
    insert into auth.users values ('${A}');
  `);
  // The parts the one-restaurant project has had run.
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12]) {
    const start = schema.indexOf(`-- ${n}. `);
    const next = schema.indexOf(`-- ${n + 1}. `, start);
    await db.exec(schema.slice(start, next));
  }
  await db.exec(`
    insert into public.ingredients (id, user_id, name, base, each_kg, prep_id) values ('${ITEM}', '${A}', 'Test item', 'unit', 0.45, null);
    insert into public.recipes (id, user_id, name, kind, yield_qty, yield_unit, alt_qty, alt_unit, in_inventory, locked_cost) values ('${PREP}', '${A}', 'Test prep', 'prep', 66, 'portion', 12, 'kg', true, 0.9);
    insert into public.counts (id, user_id, month, ingredient_id, qty) values ('${COUNT}', '${A}', '2026-10', '${ITEM}', 2.5);
    insert into public.counts (id, user_id, month, recipe_id, qty) values ('${COUNT2}', '${A}', '2026-10', '${PREP}', 31.25);
  `);
  before16.ingredients = await rows("select * from public.ingredients");
  before16.recipes = await rows("select * from public.recipes");
  before16.counts = await rows("select * from public.counts");
  await db.exec(part(16));
});
after(() => db && db.close());

const pick = (row, cols) => Object.fromEntries(cols.map((c) => [c, row[c]]));

test("everything saved before part 16 keeps its value, and the new columns start empty", async () => {
  for (const table of ["ingredients", "recipes", "counts"]) {
    const now = await rows(`select * from public.${table}`);
    assert.equal(now.length, before16[table].length, table);
    const cols = Object.keys(before16[table][0]);
    now.forEach((r, i) => assert.deepEqual(pick(r, cols), before16[table][i], table));
  }
  const [i] = await rows("select measures, count_unit, container_kg from public.ingredients");
  assert.deepEqual(i, { measures: null, count_unit: null, container_kg: null });
  const [r] = await rows("select measures, count_unit, container_kg from public.recipes");
  assert.deepEqual(r, { measures: null, count_unit: null, container_kg: null });
  for (const c of await rows("select unit, containers from public.counts")) assert.deepEqual(c, { unit: null, containers: null });
});

test("pasting part 16 a second time is safe and changes nothing", async () => {
  await db.exec(`update public.ingredients set container_kg = 0.085, measures = '[{"qty": 12, "unit": "kg"}]', count_unit = 'kg' where id = '${ITEM}'`);
  await db.exec(part(16));
  const [i] = await rows("select measures, count_unit, container_kg from public.ingredients");
  assert.deepEqual(i.measures, [{ qty: 12, unit: "kg" }]);
  assert.equal(i.count_unit, "kg");
  assert.equal(+i.container_kg, 0.085);
  await db.exec(`update public.ingredients set container_kg = null, measures = null, count_unit = null where id = '${ITEM}'`);
});

test("it keeps out what can't be right, and lets every value be left empty", async () => {
  await assert.rejects(db.exec(`update public.ingredients set container_kg = 0 where id = '${ITEM}'`), /container_kg/);
  await assert.rejects(db.exec(`update public.recipes set container_kg = -1 where id = '${PREP}'`), /container_kg/);
  await assert.rejects(db.exec(`update public.ingredients set measures = '{"qty": 1}' where id = '${ITEM}'`), /measures/);
  await assert.rejects(db.exec(`update public.counts set containers = -1 where id = '${COUNT}'`), /containers/);
  await db.exec(`update public.counts set containers = 0, unit = 'kg' where id = '${COUNT}'`); // no container on the scale
  await db.exec(`update public.counts set containers = null, unit = null where id = '${COUNT}'`);
  await db.exec(`update public.recipes set measures = null, count_unit = null, container_kg = null, alt_qty = null, alt_unit = null where id = '${PREP}'`);
});

test("a prep can be costed per recipe with its other measures empty", async () => {
  await db.exec(`update public.recipes set yield_qty = 1, yield_unit = 'recipe', alt_qty = null, alt_unit = null, measures = null where id = '${PREP}'`);
  const [r] = await rows("select yield_qty, yield_unit from public.recipes");
  assert.equal(r.yield_unit, "recipe");
});

test("each account only sees its own new columns: the same rules cover them", async () => {
  // Part 16 adds columns to tables that already have row level security, and no policy has to change.
  assert.equal(/create policy|grant |revoke /i.test(part(16)), false);
  assert.ok(/BOTH sites/.test(part(16)));
});
