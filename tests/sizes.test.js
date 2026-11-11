/* An item's own sizes: boxes inside boxes, with the names the supplier or the kitchen uses. Made-up prices only. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Costing = require("../public/costing.js");
const Barback = require("../public/barback.js");

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
// Frozen pastry: a case of 24 packs, each 454 g, each 15 sheets. Priced per kg, bought by the case.
const pastry = () => ({ id: "p", name: "Puff pastry", base: "kg", yield: 1, preferred_offer_id: "o",
  measures: [{ per: "case", qty: 24, unit: "pack" }, { per: "pack", qty: 454, unit: "g" }, { per: "pack", qty: 15, unit: "sheet" }] });
const data = (item = pastry(), lines = [{ id: "l", recipe_id: "r", pos: 1, ingredient_id: "p", qty: 2, unit: "sheet" }]) => ({
  ingredients: [item], offers: [{ id: "o", ingredient_id: "p", pack_cost: 96, pack_qty: 1, pack_unit: "case" }],
  recipes: [{ id: "r", name: "Tart", kind: "dish", yield_qty: 1, yield_unit: "portion", multiplier: 4 }], lines,
});

test("each size comes to a weight, through the others, either way round", () => {
  const p = pastry();
  assert.deepEqual(Costing.sizeIn(p, "case"), { qty: 10896, unit: "g" });
  assert.deepEqual(Costing.sizeIn(p, "pack"), { qty: 454, unit: "g" });
  close(Costing.sizeIn(p, "sheet").qty, 454 / 15);
  assert.deepEqual(Costing.sizeNames(p), ["case", "pack", "sheet"]);
});

test("a price per case is a price per kg", () => {
  const c = Costing.create(data());
  close(c.defaultOffer("p").price, 96 / 10.896);
  close(c.packAmount(1, "case", pastry()), 10.896);
});

test("a recipe can use sheets, and they cost their share of the case", () => {
  close(Costing.create(data()).recipeCost("r").total, (2 * 454) / 15 / 1000 * (96 / 10.896));
});

test("the count can be in cases, packs or sheets", () => {
  const c = Costing.create(data());
  assert.deepEqual(c.countChoices(pastry(), false), ["kg", "case", "pack", "sheet"]);
  close(c.itemAmount(pastry(), 3, "pack"), 1.362);
  close(c.itemAmount(pastry(), 1.5, "case"), 16.344);
});

test("an item priced per unit (per pack) works the same way", () => {
  const p = { ...pastry(), base: "unit", measures: [{ per: "case", qty: 24, unit: "unit" }, { per: "unit", qty: 15, unit: "sheet" }] };
  const c = Costing.create(data(p));
  close(c.defaultOffer("p").price, 4);           // $96 for 24 packs
  close(c.recipeCost("r").total, (2 / 15) * 4);   // 2 sheets of a $4 pack
});

test("sizes that lead nowhere, go round in circles or reuse a unit's name come to nothing", () => {
  const nowhere = { base: "kg", measures: [{ per: "case", qty: 24, unit: "pack" }] };
  assert.equal(Costing.sizeIn(nowhere, "case"), null);
  assert.deepEqual(Costing.sizeNames(nowhere), []);
  const circle = { base: "kg", measures: [{ per: "a", qty: 2, unit: "b" }, { per: "b", qty: 3, unit: "a" }] };
  assert.equal(Costing.sizeIn(circle, "a"), null);
  assert.equal(Costing.sizeIn(pastry(), "kg"), null, "a real unit isn't a size");
});

test("sizes stay apart from the item's other measures and from a bottle's size", () => {
  const p = { ...pastry(), measures: [...pastry().measures, { qty: 0.454, unit: "kg" }, { qty: 1, unit: "portion" }] };
  assert.deepEqual(Costing.savedMeasures(p), [{ qty: 0.454, unit: "kg" }, { qty: 1, unit: "portion" }]);
  const can = { measures: [{ per: "flat", qty: 24, unit: "can" }, { per: "can", qty: 355, unit: "ml" }] };
  const sized = Barback.withBottleSize(can, 750);
  assert.equal(Barback.bottleMl({ measures: sized }), 750);
  assert.deepEqual(sized.filter((m) => m.per), can.measures, "a bottle's size doesn't wipe the item's sizes");
  assert.equal(Barback.bottleMl(can), null, "and a size in ml isn't taken for a bottle");
});

test("the item page keeps the sizes when its other measures are saved, and renaming one carries over", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  assert.match(app, /const all = \[\.\.\.list, \.\.\.\(i\.measures \|\| \[\]\)\.filter\(\(m\) => m && m\.per\)\];/);
  assert.match(app, /for \(const l of data\.lines\.filter\(\(x\) => x\.ingredient_id === i\.id && x\.unit === old\)\) await patch\("lines", l\.id, \{ unit: newName \}\);/);
  assert.match(app, /units = \[\.\.\.units, \.\.\.Costing\.sizeNames\(ing\)/, "recipe lines offer them");
});
