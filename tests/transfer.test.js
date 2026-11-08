/* Bringing recipes and items from one account into another. Made-up data only. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const Transfer = require("../public/transfer.js");
const Costing = require("../public/costing.js");

const ids = () => { let n = 0; return () => `new-${++n}`; };
const mine = () => ({
  ingredients: [
    { id: "lime", name: "Limes", base: "unit", yield: 1, preferred_offer_id: "o-lime", created_by: "me", user_id: "me", project: "kitchen", review: "", needs_check: false, in_inventory: true },
    { id: "yuzu", name: "Yuzu", base: "kg", yield: 1, preferred_offer_id: "o-yuzu", created_by: "me", user_id: "me", project: "kitchen", locked_price: 30, locked_at: "2026-11-01", review: "Old note", in_inventory: true },
    { id: "curd-item", name: "Yuzu curd (made)", base: "kg", yield: 1, prep_id: "curd", user_id: "me", project: "kitchen" },
  ],
  offers: [
    { id: "o-lime", ingredient_id: "lime", supplier: "My shop", pack_cost: 10, pack_qty: 10, pack_unit: "unit", user_id: "me" },
    { id: "o-yuzu", ingredient_id: "yuzu", supplier: "My shop", pack_cost: 40, pack_qty: 1, pack_unit: "kg", user_id: "me" },
    { id: "o-yuzu-2", ingredient_id: "yuzu", supplier: "Other", pack_cost: 45, pack_qty: 1, pack_unit: "kg", user_id: "me" },
  ],
  recipes: [
    { id: "tart", name: "Yuzu tart", kind: "dish", yield_qty: 1, yield_unit: "portion", menu_price: 15, multiplier: 4, ack_cost: 9, card_doc_id: "doc", created_by: "me", user_id: "me", project: "kitchen" },
    { id: "curd", name: "Yuzu curd", kind: "prep", yield_qty: 1, yield_unit: "kg", created_by: "me", project: "kitchen" },
    { id: "dough", name: "Sweet dough", kind: "prep", yield_qty: 1, yield_unit: "kg", project: "kitchen" },
  ],
  lines: [
    { id: "l1", recipe_id: "tart", pos: 1, ingredient_id: "lime", qty: 1, unit: "unit", offer_id: "o-lime" },
    { id: "l2", recipe_id: "tart", pos: 2, sub_recipe_id: "curd", qty: 0.1, unit: "kg" },
    { id: "l3", recipe_id: "tart", pos: 3, sub_recipe_id: "dough", qty: 0.2, unit: "kg" },
    { id: "l4", recipe_id: "curd", pos: 1, ingredient_id: "yuzu", qty: 0.5, unit: "kg", offer_id: "o-yuzu-2" },
  ],
});
const restaurant = () => ({
  ingredients: [{ id: "r-lime", name: "limes", base: "unit" }],
  offers: [],
  recipes: [{ id: "r-dough", name: "Sweet Dough", kind: "prep" }, { id: "r-tart", name: "Yuzu tart", kind: "dish" }],
  lines: [],
});

test("a recipe brings its preps and items; what the account already has is used instead, by name", () => {
  const p = Transfer.plan({ source: mine(), target: restaurant(), picked: { recipes: ["tart"] }, newId: ids() });
  assert.deepEqual(p.recipes.map((r) => r.name), ["Yuzu tart (imported)", "Yuzu curd"]);
  assert.deepEqual(p.matchedItems, ["Limes"]);
  assert.deepEqual(p.matchedPreps, ["Sweet dough"], "capitals don't matter");
  assert.deepEqual(p.ingredients.map((i) => i.name), ["Yuzu"]);
  const tart = p.recipes[0], lines = p.lines.filter((l) => l.recipe_id === tart.id);
  assert.equal(lines.find((l) => l.pos === 1).ingredient_id, "r-lime");
  assert.equal(lines.find((l) => l.pos === 1).offer_id, undefined, "the restaurant's own limes, at its own price");
  assert.equal(lines.find((l) => l.pos === 3).sub_recipe_id, "r-dough");
  assert.equal(lines.find((l) => l.pos === 2).sub_recipe_id, p.recipes[1].id);
});

test("a name that's taken gets marked, so nothing is overwritten", () => {
  const p = Transfer.plan({ source: mine(), target: restaurant(), picked: { recipes: ["tart"] }, newId: ids() });
  assert.deepEqual(p.renamed, [{ from: "Yuzu tart", to: "Yuzu tart (imported)" }]);
  const again = Transfer.plan({ source: mine(), target: { ...restaurant(), recipes: [...restaurant().recipes, { id: "x", name: "Yuzu tart (imported)", kind: "dish" }] }, picked: { recipes: ["tart"] }, newId: ids() });
  assert.equal(again.recipes[0].name, "Yuzu tart (imported 2)");
});

test("a picked prep is copied even when one of that name is there; only a needed one is shared", () => {
  const p = Transfer.plan({ source: mine(), target: restaurant(), picked: { recipes: ["dough"] }, newId: ids() });
  assert.deepEqual(p.recipes.map((r) => r.name), ["Sweet dough (imported)"]);
});

test("nothing of whose it was comes along: new ids, no owner, no side, no old checks or cards", () => {
  const p = Transfer.plan({ source: mine(), target: restaurant(), picked: { recipes: ["tart"] }, newId: ids() });
  for (const row of [...p.recipes, ...p.ingredients, ...p.offers, ...p.lines]) {
    for (const k of ["user_id", "project", "created_by", "created_at"]) assert.ok(!(k in row), `${k} left on ${row.id}`);
    assert.match(row.id, /^new-/);
  }
  assert.equal(p.recipes[0].ack_cost, null);
  assert.equal(p.recipes[0].card_doc_id, null);
  assert.equal(p.ingredients[0].review, "");
});

test("an item comes with its prices, and the one it used stays the one it uses", () => {
  const p = Transfer.plan({ source: mine(), target: restaurant(), picked: { recipes: ["tart"] }, newId: ids() });
  const yuzu = p.ingredients[0];
  assert.deepEqual(p.offers.filter((o) => o.ingredient_id === yuzu.id).map((o) => o.pack_cost), [40, 45]);
  const pref = p.later.find((l) => l.id === yuzu.id).changes.preferred_offer_id;
  assert.equal(p.offers.find((o) => o.id === pref).pack_cost, 40);
  const curdLine = p.lines.find((l) => l.recipe_id === p.recipes[1].id);
  assert.equal(p.offers.find((o) => o.id === curdLine.offer_id).pack_cost, 45, "a line that picked another supplier keeps it");
});

test("brought in by an employee: new items are estimates, flagged, off the count and unlocked", () => {
  const p = Transfer.plan({ source: mine(), target: restaurant(), picked: { recipes: ["tart"] }, newId: ids(), estimate: true, note: "Estimated price from cook" });
  const yuzu = p.ingredients[0];
  assert.equal(yuzu.needs_check, true);
  assert.equal(yuzu.review, "Estimated price from cook");
  assert.equal(yuzu.in_inventory, false);
  assert.equal(yuzu.locked_price, null);
  assert.equal(p.offers.length, 2, "their price comes as the estimate");
});

test("an item made from a prep brings the prep, except for someone who can't link prices", () => {
  const admin = Transfer.plan({ source: mine(), target: restaurant(), picked: { items: ["curd-item"] }, newId: ids() });
  const link = admin.later.find((l) => l.id === admin.ingredients[0].id);
  assert.equal(admin.recipes.find((r) => r.id === link.changes.prep_id).name, "Yuzu curd");
  const employee = Transfer.plan({ source: mine(), target: restaurant(), picked: { items: ["curd-item"] }, newId: ids(), estimate: true });
  assert.equal(employee.recipes.length, 0);
  assert.equal(employee.later.length, 0);
});

test("what's brought in costs out the same as where it came from", () => {
  const src = mine(), p = Transfer.plan({ source: src, target: { ingredients: [], offers: [], recipes: [], lines: [] }, picked: { recipes: ["tart"] }, newId: ids() });
  for (const l of p.later) Object.assign(p.ingredients.find((i) => i.id === l.id), l.changes);
  const before = Costing.create(src).recipeCost("tart").total;
  const after = Costing.create(p).recipeCost(p.recipes.find((r) => r.name === "Yuzu tart").id).total;
  assert.ok(Math.abs(before - after) < 1e-9, `${before} != ${after}`);
});

test("who can bring from where: always your own account; out of a restaurant only as its administrator", () => {
  const joined = [{ account_id: "rest-a", role: "employee", account_name: "A" }, { account_id: "rest-b", role: "admin", account_name: "B" }];
  assert.deepEqual(Transfer.sources(joined, "me", "me"), [{ id: "rest-b", name: "B" }], "in my own: only B");
  assert.deepEqual(Transfer.sources(joined, "me", "rest-a"), [{ id: "me", own: true }, { id: "rest-b", name: "B" }], "in A: mine, and B");
  assert.deepEqual(Transfer.sources(joined, "me", "rest-b"), [{ id: "me", own: true }], "in B: mine only, A isn't mine to take from");
  assert.deepEqual(Transfer.sources([], "me", "me"), []);
});
