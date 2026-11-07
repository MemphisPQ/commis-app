const test = require("node:test");
const assert = require("node:assert/strict");
const Units = require("../public/units.js");
const Costing = require("../public/costing.js");

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("a dish has the same measures as a prep, and they cost the same whichever way a recipe uses it", () => {
  const data = {
    ingredients: [{ id: "beef", name: "Beef", base: "kg", yield: 1 }],
    offers: [{ id: "o", ingredient_id: "beef", supplier: "X", pack_cost: 20, pack_qty: 1, pack_unit: "kg" }],
    recipes: [
      { id: "dish", name: "Stew", kind: "dish", yield_qty: 10, yield_unit: "portion", alt_qty: 2, alt_unit: "kg", measures: [{ qty: 3, unit: "L" }] },
      { id: "byKg", name: "Plate A", kind: "dish", yield_qty: 1, yield_unit: "portion" }, { id: "byL", name: "Plate B", kind: "dish", yield_qty: 1, yield_unit: "portion" },
    ],
    lines: [{ id: "a", recipe_id: "dish", ingredient_id: "beef", qty: 2, unit: "kg" },
      { id: "b", recipe_id: "byKg", sub_recipe_id: "dish", qty: 0.4, unit: "kg" }, { id: "c", recipe_id: "byL", sub_recipe_id: "dish", qty: 0.6, unit: "L" }],
    counts: [], price_history: [],
  };
  assert.deepEqual(Costing.recipeMeasures(data.recipes[0]), [{ qty: 10, unit: "portion" }, { qty: 2, unit: "kg" }, { qty: 3, unit: "L" }]);
  const c = Costing.create(data);
  close(c.summary("dish").perPortion, 4);
  close(c.summary("byKg").perPortion, 8, 1e-6);   // 0.4 of its 2 kg is 2 of its 10 portions
  close(c.summary("byL").perPortion, 8, 1e-6);
  // A portion's size gives the rest, for a dish as for a prep.
  assert.deepEqual(Costing.withPortionSize([{ qty: 1, unit: "portion" }], 0.35), [{ qty: 1, unit: "portion" }, { qty: 0.35, unit: "kg" }]);
});

test("unit spellings from the Master Data sheet", () => {
  for (const s of ["kg", "Kg", "kgs"]) assert.equal(Units.parseUnit(s), "kg");
  for (const s of ["lbs", "Lbs", "lb"]) assert.equal(Units.parseUnit(s), "lb");
  for (const s of ["unit", "un.", "unites", "unite", "u", "Un.", "ea", "pqt.", "CS"]) assert.equal(Units.parseUnit(s), "unit", s);
  for (const s of ["b", "bunch", "bunches", "Botte"]) assert.equal(Units.parseUnit(s), "bunch", s);
  for (const s of ["L", "l"]) assert.equal(Units.parseUnit(s), "L");
  assert.equal(Units.parseUnit("284g"), null);
  assert.ok(Units.isVague("case") && !Units.isVague("kg"));
});

test("sizes hidden in text", () => {
  close(Units.parseSize("284g").qty, 0.284);
  close(Units.parseSize("3,78L/Un").qty, 3.78);
  close(Units.parseSize("57 ml").qty, 0.057);
  close(Units.parseSize("OIGNON JAUNE 50LB").qty, 50 * 0.45359237);
  assert.equal(Units.parseSize("Oignons, Jaune"), null);
});

test("pounds become kilos", () => {
  close(Units.convert(50, "lb", "kg"), 22.6796185);
  close(Units.convert(250, "g", "kg"), 0.25);
  assert.equal(Units.convert(1, "kg", "L"), null);
});

function sample() {
  const ingredients = [
    { id: "lettuce", name: "Laitue, Mesclun", base: "kg", yield: 1, preferred_offer_id: "hector" },
    { id: "salt", name: "Sel", base: "kg", yield: 1 },
    { id: "celeriac", name: "Celeriac", base: "unit", yield: 1, each_kg: 0.8 },
    { id: "char", name: "Omble, Filets", base: "kg", yield: 0.7 },
  ];
  const offers = [
    { id: "canam", ingredient_id: "lettuce", supplier: "Can-Am", pack_cost: 15.5, pack_qty: 3, pack_unit: "lb" },
    { id: "hector", ingredient_id: "lettuce", supplier: "Hector Larivée", pack_cost: 14, pack_qty: 1, pack_unit: "kg" },
    { id: "salt1", ingredient_id: "salt", supplier: "Multiplus", pack_cost: 30, pack_qty: 25, pack_unit: "kg" },
    { id: "cel1", ingredient_id: "celeriac", supplier: "", pack_cost: 4.7, pack_qty: 1, pack_unit: "unit" },
    { id: "char1", ingredient_id: "char", supplier: "La Mer", pack_cost: 28.19, pack_qty: 1, pack_unit: "kg" },
  ];
  const recipes = [
    { id: "sauce", name: "Sauce", kind: "prep", yield_qty: 10, yield_unit: "portion" },
    { id: "purée", name: "Purée", kind: "prep", yield_qty: 2, yield_unit: "kg" },
    { id: "dish", name: "Salade", kind: "dish", yield_qty: 1, yield_unit: "portion", menu_price: 18, multiplier: 4, ack_cost: 3 },
  ];
  const lines = [
    { id: "s1", recipe_id: "sauce", pos: 1, ingredient_id: "salt", qty: 100, unit: "g" },
    { id: "p1", recipe_id: "purée", pos: 1, ingredient_id: "celeriac", qty: 2, unit: "kg" },
    { id: "d1", recipe_id: "dish", pos: 1, ingredient_id: "lettuce", qty: 60, unit: "g" },
    { id: "d2", recipe_id: "dish", pos: 2, ingredient_id: "lettuce", qty: 60, unit: "g", offer_id: "canam" },
    { id: "d3", recipe_id: "dish", pos: 3, sub_recipe_id: "sauce", qty: 1, unit: "portion" },
    { id: "d4", recipe_id: "dish", pos: 4, sub_recipe_id: "purée", qty: 100, unit: "g" },
    { id: "d5", recipe_id: "dish", pos: 5, ingredient_id: "char", qty: 55, unit: "g" },
  ];
  return { ingredients, offers, recipes, lines };
}

test("each supplier's price, in $/kg, with yield", () => {
  const c = Costing.create(sample());
  const prices = Object.fromEntries(c.offersFor("lettuce").map((x) => [x.offer.supplier, x.price]));
  close(prices["Can-Am"], 15.5 / (3 * 0.45359237));
  close(prices["Hector Larivée"], 14);
  close(c.offersFor("char")[0].price, 28.19 / 0.7);
});

test("a recipe uses the preferred supplier unless a line picks another", () => {
  const c = Costing.create(sample());
  const rows = c.recipeCost("dish").lines;
  assert.equal(rows[0].offer.supplier, "Hector Larivée");
  assert.equal(rows[1].offer.supplier, "Can-Am");
  close(rows[0].cost, 0.06 * 14);
});

test("without a preferred supplier, the cheapest one is used", () => {
  const d = sample();
  d.ingredients[0].preferred_offer_id = null;
  const c = Costing.create(d);
  assert.equal(c.defaultOffer("lettuce").offer.supplier, "Can-Am");
});

test("preps by the portion and by the kilo, and weight per unit", () => {
  const c = Costing.create(sample());
  close(c.recipeCost("sauce").perYield, (0.1 * 1.2) / 10);
  // 2 kg of celeriac at 0.8 kg each = 2.5 celeriac at $4.70, makes 2 kg of purée
  close(c.recipeCost("purée").perYield, (2.5 * 4.7) / 2);
  const rows = c.recipeCost("dish").lines;
  close(rows[3].cost, 0.1 * ((2.5 * 4.7) / 2));
});

test("dish summary: x4 price, food cost and change since last seen", () => {
  const c = Costing.create(sample());
  const s = c.summary("dish");
  const expected = 0.06 * 14 + 0.06 * (15.5 / 1.360776) + 0.012 + 0.1 * 5.875 + 0.055 * (28.19 / 0.7);
  close(s.perPortion, expected, 1e-4);
  close(s.suggested, expected * 4, 1e-4);
  close(s.foodCost, expected / 18, 1e-4);
  assert.equal(s.over, expected / 18 > 0.25);
  close(s.change, expected - 3, 1e-4);
  assert.deepEqual(s.problems, []);
});

test("problems are reported, not hidden", () => {
  const d = sample();
  d.lines.push({ id: "x", recipe_id: "dish", pos: 9, ingredient_id: "salt", qty: 2, unit: "unit" });
  d.lines.push({ id: "y", recipe_id: "sauce", pos: 9, sub_recipe_id: "sauce", qty: 1, unit: "portion" });
  const c = Costing.create(d);
  const s = c.summary("dish");
  assert.ok(s.problems.some((p) => p.includes("Can't turn unit into kg")));
  assert.ok(c.recipeCost("sauce").problems.includes("This prep uses itself"));
});

test("a prepped item made from a prep costs what the prep costs today", () => {
  const d = sample();
  // "Sauce" bought-style item: Master Data says $5 for a batch of 2 kg; it's really the prep "purée".
  d.ingredients.push({ id: "puree-item", name: "Purée, celeriac", base: "kg", yield: 1, preferred_offer_id: "pi1", prep_id: "purée" });
  d.offers.push({ id: "pi1", ingredient_id: "puree-item", supplier: "", pack_cost: 5, pack_qty: 2, pack_unit: "kg" });
  d.lines.push({ id: "d9", recipe_id: "dish", pos: 9, ingredient_id: "puree-item", qty: 0.1, unit: "kg" });
  let c = Costing.create(d);
  const batch = 2.5 * 4.7; // the prep's batch
  close(c.defaultOffer("puree-item").price, batch / 2);
  assert.equal(c.defaultOffer("puree-item").offer.supplier, "Made in-house");
  // Celeriac goes up: the item follows, and so does the dish using it.
  d.offers.find((o) => o.id === "cel1").pack_cost = 6;
  c = Costing.create(d);
  close(c.defaultOffer("puree-item").price, (2.5 * 6) / 2);
  assert.ok(c.usedBy("purée").includes("dish"));
  // A prep that uses its own item doesn't loop: the item falls back to its own price there.
  d.lines.push({ id: "p9", recipe_id: "purée", pos: 9, ingredient_id: "puree-item", qty: 0.1, unit: "kg" });
  c = Costing.create(d);
  assert.ok(isFinite(c.recipeCost("dish").total));
});

test("a prep counted in portions can also be used by weight, through its batch weight", () => {
  const d = sample();
  const sauce = d.recipes.find((r) => r.id === "sauce"); // makes 10 portions
  sauce.alt_qty = 0.5; sauce.alt_unit = "kg";           // and the batch weighs 500 g
  d.lines.push({ id: "w1", recipe_id: "dish", pos: 10, sub_recipe_id: "sauce", qty: 100, unit: "g" });
  const c = Costing.create(d);
  const per = c.recipeCost("sauce").perYield;
  const row = c.recipeCost("dish").lines.find((r) => r.line.id === "w1");
  close(row.cost, per * 2); // 100 g of a 500 g batch = 2 of its 10 portions
  // An item made from it, priced per kg, uses the true weight: batch cost / 0.5 kg.
  d.ingredients.push({ id: "si", name: "Sauce, maison", base: "kg", yield: 1, prep_id: "sauce" });
  const c2 = Costing.create(d);
  close(c2.defaultOffer("si").price, c2.recipeCost("sauce").total / 0.5);
});

test("used by follows preps up to the dishes", () => {
  const c = Costing.create(sample());
  assert.deepEqual(c.usedBy("salt").sort(), ["dish", "sauce"]);
});

test("an item priced per portion: pack in portions, used by the portion, by the unit or by weight", () => {
  assert.equal(Units.parseUnit("portions"), "portion");
  assert.ok(!Units.isVague("portion"));
  const d = sample();
  d.ingredients.push({ id: "confit", name: "Confit, Tomates", base: "portion", yield: 1 });
  d.offers.push({ id: "c30", ingredient_id: "confit", supplier: "", pack_cost: 32.1, pack_qty: 30, pack_unit: "portion" });
  d.lines.push({ id: "pp1", recipe_id: "dish", pos: 11, ingredient_id: "confit", qty: 2, unit: "portion" });
  let c = Costing.create(d);
  close(c.defaultOffer("confit").price, 1.07);
  close(c.recipeCost("dish").lines.find((r) => r.line.id === "pp1").cost, 2.14);
  // A portion is one piece: lines still in "unit" (from before) cost the same, and a unit-priced item can be bought in portions.
  d.lines.push({ id: "pp2", recipe_id: "dish", pos: 12, ingredient_id: "confit", qty: 2, unit: "unit" });
  d.offers.push({ id: "cel30", ingredient_id: "celeriac", supplier: "X", pack_cost: 30, pack_qty: 10, pack_unit: "portion" });
  c = Costing.create(d);
  close(c.recipeCost("dish").lines.find((r) => r.line.id === "pp2").cost, 2.14);
  close(c.offersFor("celeriac").find((x) => x.offer.id === "cel30").price, 3);
  // By weight only once a portion's weight is known.
  d.lines.push({ id: "pp3", recipe_id: "dish", pos: 13, ingredient_id: "confit", qty: 0.12, unit: "kg" });
  c = Costing.create(d);
  assert.equal(c.recipeCost("dish").lines.find((r) => r.line.id === "pp3").cost, 0);
  assert.match(c.recipeCost("dish").lines.find((r) => r.line.id === "pp3").problem, /weight per portion/);
  d.ingredients.find((i) => i.id === "confit").each_kg = 0.06;
  c = Costing.create(d);
  close(c.recipeCost("dish").lines.find((r) => r.line.id === "pp3").cost, 2.14); // 120 g = 2 portions of 60 g
});

test("a prepped item priced per portion, made from a prep that makes portions", () => {
  const d = sample(); // "sauce" makes 10 portions
  d.ingredients.push({ id: "sp", name: "Sauce, portions", base: "portion", yield: 1, prep_id: "sauce" });
  const c = Costing.create(d);
  close(c.defaultOffer("sp").price, c.recipeCost("sauce").total / 10);
});

test("a locked prepped item keeps its price; a locked prep keeps its cost", () => {
  const d = sample();
  d.ingredients.push({ id: "sp", name: "Sauce, portions", base: "portion", yield: 1, prep_id: "sauce", locked_price: 0.5, locked_at: "2026-10-01" });
  d.lines.push({ id: "lk", recipe_id: "dish", pos: 20, ingredient_id: "sp", qty: 2, unit: "portion" });
  let c = Costing.create(d);
  const def = c.defaultOffer("sp");
  assert.equal(def.price, 0.5);
  assert.ok(def.offer.locked);
  close(def.live, c.recipeCost("sauce").total / 10);               // today's price is still known
  close(c.recipeCost("dish").lines.find((r) => r.line.id === "lk").cost, 1);
  close(c.offerPrice(def.offer, d.ingredients.find((i) => i.id === "sp")), 0.5); // its pack gives back the locked price
  // The sauce's salt triples: the locked item doesn't move, today's price does.
  d.offers.find((o) => o.id === "salt1").pack_cost *= 3;
  c = Costing.create(d);
  assert.equal(c.defaultOffer("sp").price, 0.5);
  close(c.defaultOffer("sp").live, c.recipeCost("sauce").total / 10);
  close(c.defaultOffer("sp").live, (0.1 * 3.6) / 10);
  // A locked prep: everything using it sees the locked cost; today's is kept aside.
  d.recipes.find((r) => r.id === "sauce").locked_cost = 0.75;
  c = Costing.create(d);
  const rc = c.recipeCost("sauce");
  assert.equal(rc.perYield, 0.75);
  assert.equal(rc.total, 7.5);
  close(rc.live.perYield, 0.036);
  const sub = c.recipeCost("dish").lines.find((r) => r.line.sub_recipe_id === "sauce");
  close(sub.cost, (sub.line.qty || 1) * 0.75);
});

test("a prepped item counted by the recipe: one recipe is one batch", () => {
  assert.equal(Units.parseUnit("recette"), "recipe");
  assert.equal(Units.amountIn(2, "unit", "recipe"), 2);        // the old "recette" items were units: 1 for 1
  assert.equal(Units.amountIn(2, "portion", "recipe"), null);  // a portion is not a recipe
  const d = sample(); // "sauce" makes 10 portions
  d.ingredients.push({ id: "sr", name: "Sauce, recette", base: "recipe", yield: 1, prep_id: "sauce" });
  d.lines.push({ id: "r1", recipe_id: "dish", pos: 30, ingredient_id: "sr", qty: 0.5, unit: "recipe" });
  let c = Costing.create(d);
  const batch = c.recipeCost("sauce").total;
  close(c.defaultOffer("sr").price, batch);                         // price per recipe = the batch
  close(c.recipeCost("dish").lines.find((r) => r.line.id === "r1").cost, batch / 2);
  // A prep used by the recipe in a dish: the whole batch.
  d.lines.push({ id: "r2", recipe_id: "dish", pos: 31, sub_recipe_id: "sauce", qty: 1, unit: "recipe" });
  c = Costing.create(d);
  close(c.recipeCost("dish").lines.find((r) => r.line.id === "r2").cost, batch);
  // A prep that makes "1 recipe" and gives 10 portions: dishes can still use it by the portion.
  const s = d.recipes.find((r) => r.id === "sauce");
  Object.assign(s, { yield_qty: 1, yield_unit: "recipe", alt_qty: 10, alt_unit: "portion" });
  c = Costing.create(d);
  close(c.recipeCost("dish").lines.find((r) => r.line.sub_recipe_id === "sauce" && r.line.unit === "portion").cost, batch / 10);
});

test("herbs and greens by the bunch: a bunch is one unit, never a portion or a recipe", () => {
  assert.equal(Units.amountIn(3, "unit", "bunch"), 3);   // the old "unit" lines and packs keep their value
  assert.equal(Units.amountIn(1, "dozen", "bunch"), 12);
  assert.equal(Units.amountIn(1, "bunch", "portion"), null);
  const d = sample();
  d.ingredients.push({ id: "persil", name: "Persil", base: "bunch", yield: 1, each_kg: 0.06 });
  d.offers.push({ id: "p1", ingredient_id: "persil", supplier: "Can-Am", pack_cost: 19.8, pack_qty: 12, pack_unit: "bunch" });
  d.lines.push({ id: "b1", recipe_id: "dish", pos: 40, ingredient_id: "persil", qty: 0.5, unit: "bunch" });
  d.lines.push({ id: "b2", recipe_id: "dish", pos: 41, ingredient_id: "persil", qty: 1, unit: "unit" });
  d.lines.push({ id: "b3", recipe_id: "dish", pos: 42, ingredient_id: "persil", qty: 30, unit: "g" });
  const c = Costing.create(d);
  close(c.defaultOffer("persil").price, 1.65);
  const cost = (id) => c.recipeCost("dish").lines.find((r) => r.line.id === id).cost;
  close(cost("b1"), 0.825);
  close(cost("b2"), 1.65);
  close(cost("b3"), 0.825); // 30 g of a 60 g bunch
});

test("a yield on one recipe line: the same item trimmed differently in that recipe", () => {
  // Carrots: $10 for 10 kg, 80% usable in general, so $1.25 per usable kg.
  const data = {
    ingredients: [{ id: "car", name: "Carottes", base: "kg", yield: 0.8, preferred_offer_id: "o1" }],
    offers: [{ id: "o1", ingredient_id: "car", pack_cost: 10, pack_qty: 10, pack_unit: "kg" }],
    recipes: [{ id: "a", name: "Usual", kind: "prep", yield_qty: 1, yield_unit: "kg" }, { id: "b", name: "Peeled deep", kind: "prep", yield_qty: 1, yield_unit: "kg" }],
    lines: [
      { id: "l1", recipe_id: "a", ingredient_id: "car", qty: 1, unit: "kg" },
      { id: "l2", recipe_id: "b", ingredient_id: "car", qty: 1, unit: "kg", yield: 0.5 },
    ],
  };
  const c = Costing.create(data);
  close(c.recipeCost("a").total, 1.25);
  // Only half usable here: $2 per usable kg in this recipe, the item itself unchanged.
  const b = c.recipeCost("b");
  close(b.total, 2);
  close(b.lines[0].unitPrice, 2);
  assert.equal(b.lines[0].lineYield, 0.5);
  close(c.defaultOffer("car").price, 1.25);
});

/* ---------- more ways to measure ---------- */

test("what's saved before measures existed keeps every number: no measures, the same rules as ever", () => {
  const d = sample();
  // An item priced per unit with no prep behind it: a portion or a recipe still counts as one unit.
  d.ingredients.push({ id: "old", name: "Old", base: "unit", yield: 1, measures: null, container_kg: null, count_unit: null });
  d.offers.push({ id: "old1", ingredient_id: "old", supplier: "", pack_cost: 8, pack_qty: 2, pack_unit: "unit" });
  d.lines.push({ id: "o1", recipe_id: "dish", pos: 50, ingredient_id: "old", qty: 3, unit: "portion" });
  d.lines.push({ id: "o2", recipe_id: "dish", pos: 51, ingredient_id: "old", qty: 1, unit: "recipe" });
  const c = Costing.create(d);
  const cost = (id) => c.recipeCost("dish").lines.find((r) => r.line.id === id).cost;
  close(cost("o1"), 12);
  close(cost("o2"), 4);
  // The weight of one piece still does what it did, and an item with nothing to go on is only counted in its own unit.
  assert.equal(c.itemAmount(d.ingredients.find((i) => i.id === "celeriac"), 1.6, "kg"), 2);
  assert.deepEqual(c.countChoices(d.ingredients.find((i) => i.id === "salt"), false), ["kg"]);
  assert.deepEqual(c.countChoices(d.ingredients.find((i) => i.id === "celeriac"), false), ["unit", "kg"]);
});

test("empty measures are fine, whatever shape they come in", () => {
  const d = sample();
  const salt = d.ingredients.find((i) => i.id === "salt");
  for (const empty of [null, undefined, [], [{}], [{ qty: "", unit: "kg" }], [{ qty: 0, unit: "kg" }], [{ qty: 2 }], "nonsense"]) {
    salt.measures = empty;
    const c = Costing.create(d);
    assert.deepEqual(Costing.savedMeasures(salt), []);
    close(c.defaultOffer("salt").price, 1.2);
    assert.deepEqual(c.countChoices(salt, false), ["kg"]);
  }
});

test("a prep can say all three: 1 recipe = a weight = portions, and a line can use any of them", () => {
  const d = sample();
  // It makes "1 recipe", which could only hold a weight or portions before.
  Object.assign(d.recipes.find((r) => r.id === "sauce"), { yield_qty: 1, yield_unit: "recipe", alt_qty: 2, alt_unit: "kg", measures: [{ qty: 10, unit: "portion" }] });
  d.lines.push({ id: "m1", recipe_id: "dish", pos: 60, sub_recipe_id: "sauce", qty: 1, unit: "kg" });
  d.lines.push({ id: "m2", recipe_id: "dish", pos: 61, sub_recipe_id: "sauce", qty: 2, unit: "portion" });
  d.lines.push({ id: "m3", recipe_id: "dish", pos: 62, sub_recipe_id: "sauce", qty: 0.5, unit: "recipe" });
  const c = Costing.create(d), batch = c.recipeCost("sauce").total;
  const cost = (id) => c.recipeCost("dish").lines.find((r) => r.line.id === id).cost;
  close(cost("m1"), batch / 2);
  close(cost("m2"), batch / 5);
  close(cost("m3"), batch / 2);
  assert.deepEqual(Costing.recipeMeasures(d.recipes.find((r) => r.id === "sauce")).map((m) => m.unit), ["kg", "portion"]);
  assert.deepEqual(c.countChoices(d.recipes.find((r) => r.id === "sauce"), true), ["recipe", "kg", "portion"]);
});

test("moving what a prep's cost is per changes nothing that uses it", () => {
  const per = (r) => {
    const d = sample();
    Object.assign(d.recipes.find((x) => x.id === "sauce"), r);
    d.lines.push({ id: "w1", recipe_id: "dish", pos: 70, sub_recipe_id: "sauce", qty: 100, unit: "g" }, { id: "w2", recipe_id: "dish", pos: 71, sub_recipe_id: "sauce", qty: 2, unit: "portion" });
    const c = Costing.create(d);
    return { batch: c.recipeCost("sauce").total, w1: c.recipeCost("dish").lines.find((x) => x.line.id === "w1").cost, w2: c.recipeCost("dish").lines.find((x) => x.line.id === "w2").cost };
  };
  const portions = per({ yield_qty: 10, yield_unit: "portion", alt_qty: 0.5, alt_unit: "kg" });
  const byWeight = per({ yield_qty: 0.5, yield_unit: "kg", alt_qty: 10, alt_unit: "portion" });
  const byRecipe = per({ yield_qty: 1, yield_unit: "recipe", alt_qty: 0.5, alt_unit: "kg", measures: [{ qty: 10, unit: "portion" }] });
  for (const other of [byWeight, byRecipe]) for (const k of ["batch", "w1", "w2"]) close(other[k], portions[k]);
});

test("an item made from a prep is measured through the batch its price is for", () => {
  const d = sample();
  Object.assign(d.recipes.find((r) => r.id === "sauce"), { yield_qty: 100, yield_unit: "portion", alt_qty: 5, alt_unit: "kg" });
  // Counted by the batch ("1 unit"), its price is one batch.
  d.ingredients.push({ id: "byunit", name: "By the unit", base: "unit", yield: 1, prep_id: "sauce", preferred_offer_id: "u1" });
  d.offers.push({ id: "u1", ingredient_id: "byunit", supplier: "", pack_cost: 3, pack_qty: 1, pack_unit: "unit" });
  // Counted by the kg, its pack size says how much a batch is.
  d.ingredients.push({ id: "bykg", name: "By the kg", base: "kg", yield: 1, prep_id: "sauce", preferred_offer_id: "k1" });
  d.offers.push({ id: "k1", ingredient_id: "bykg", supplier: "", pack_cost: 3, pack_qty: 4, pack_unit: "kg" });
  const c = Costing.create(d), batch = c.recipeCost("sauce").total;
  const u = d.ingredients.find((i) => i.id === "byunit"), k = d.ingredients.find((i) => i.id === "bykg");
  // 0.15 of a batch is 15 portions, or 750 g: the same value whichever is typed.
  close(c.itemAmount(u, 15, "portion"), 0.15);
  close(c.itemAmount(u, 0.75, "kg"), 0.15);
  close(c.itemAmount(u, 0.15, "recipe"), 0.15);
  close(c.defaultOffer("byunit").price * c.itemAmount(u, 15, "portion"), batch * 0.15);
  // The pack says 4 kg to a batch (the prep says 5): the price stays what it was, and a portion is still 1/100 of the batch.
  close(c.defaultOffer("bykg").price, batch / 4);
  close(c.itemAmount(k, 50, "portion"), 2);
  close(c.defaultOffer("bykg").price * c.itemAmount(k, 50, "portion"), batch / 2);
  assert.deepEqual(c.countChoices(u, false), ["unit", "kg", "portion", "recipe"]);
  assert.deepEqual(c.countChoices(k, false), ["kg", "portion", "recipe"]);
  // The item's own "1 unit weighs" says more about it than the prep does.
  u.each_kg = 2;
  close(Costing.create(d).itemAmount(u, 4, "kg"), 2);
});

test("an item's own measures: recipe, weight and portions, for lines, packs and the count", () => {
  const d = sample();
  // A prepped item with no prep behind it, priced by the kg, $30 for a 2.4 kg recipe.
  d.ingredients.push({ id: "own", name: "Own", base: "kg", yield: 1, measures: [{ qty: 2.4, unit: "kg" }, { qty: 20, unit: "portion" }] });
  d.offers.push({ id: "own1", ingredient_id: "own", supplier: "", pack_cost: 30, pack_qty: 1, pack_unit: "recipe" });
  d.lines.push({ id: "n1", recipe_id: "dish", pos: 80, ingredient_id: "own", qty: 2, unit: "portion" });
  const c = Costing.create(d), i = d.ingredients.find((x) => x.id === "own");
  close(c.defaultOffer("own").price, 12.5);
  close(c.recipeCost("dish").lines.find((r) => r.line.id === "n1").cost, 3);
  close(c.itemAmount(i, 1, "recipe"), 2.4);
  assert.deepEqual(c.countChoices(i, false), ["kg", "portion", "recipe"]);
  // Priced by the unit (one unit is one recipe, as ever) and told what a recipe weighs.
  const u = { id: "u", name: "U", base: "unit", yield: 1, measures: [{ qty: 2, unit: "kg" }, { qty: 10, unit: "portion" }] };
  d.ingredients.push(u);
  const c2 = Costing.create(d);
  close(c2.itemAmount(u, 1, "kg"), 0.5);
  close(c2.itemAmount(u, 5, "portion"), 0.5);
  // Only portions known: portions work, and a weight isn't invented.
  u.measures = [{ qty: 10, unit: "portion" }];
  const c3 = Costing.create(d);
  close(c3.itemAmount(u, 5, "portion"), 0.5);
  assert.equal(c3.itemAmount(u, 1, "kg"), null);
  assert.deepEqual(c3.countChoices(u, false), ["unit", "portion", "recipe"]);
});

test("any two of recipe weight, portions and portion size give the third", () => {
  const units = (l) => Object.fromEntries(l.map((m) => [m.unit, m.qty]));
  assert.deepEqual(units(Costing.withPortionSize([{ qty: 12, unit: "kg" }], 0.2)), { kg: 12, portion: 60 });
  assert.deepEqual(units(Costing.withPortionSize([{ qty: 20, unit: "portion" }], 0.12)), { portion: 20, kg: 2.4 });
  assert.deepEqual(units(Costing.withPortionSize([{ qty: 12, unit: "kg" }, { qty: 66, unit: "portion" }], 0.2)), { kg: 12, portion: 60 });
  assert.deepEqual(units(Costing.withPortionSize([], 0.12)), { kg: 0.12, portion: 1 });
  assert.deepEqual(units(Costing.withPortionSize([{ qty: 3, unit: "L" }], 0.25)), { L: 3, portion: 12 });
  const list = [{ qty: 12, unit: "kg" }];
  Costing.withPortionSize(list, 0.2);
  assert.deepEqual(list, [{ qty: 12, unit: "kg" }]); // the list it was given is left alone
});

test("a container comes off the scale's number", () => {
  assert.equal(Costing.netWeight(0.45, 1, 0.12), 0.33);
  assert.equal(Costing.netWeight(1.07, 2, 0.12), 0.83);
  assert.equal(Costing.netWeight(0.12, 1, 0.12), 0);      // an empty jar is nothing in stock
  assert.equal(Costing.netWeight(0.5, 0, 0.12), 0.5);     // no container on the scale
  assert.equal(Costing.netWeight(0.05, 1, 0.12), null);   // lighter than the jar: not a real reading
});

test("a measure taken away leaves nothing to guess with", () => {
  const d = sample();
  const prep = d.recipes.find((r) => r.id === "sauce");
  d.ingredients.push({ id: "li", name: "Linked", base: "unit", yield: 1, prep_id: "sauce" });
  Object.assign(prep, { yield_qty: 10, yield_unit: "portion", alt_qty: 2, alt_unit: "kg" });
  assert.ok(Costing.create(d).itemAmount(d.ingredients.find((i) => i.id === "li"), 1, "kg") > 0);
  Object.assign(prep, { alt_qty: null, alt_unit: null });
  const c = Costing.create(d);
  assert.equal(c.itemAmount(d.ingredients.find((i) => i.id === "li"), 1, "kg"), null);
  assert.equal(c.subAmount(1, "kg", prep), null);
  assert.ok(!c.countChoices(d.ingredients.find((i) => i.id === "li"), false).includes("kg"));
});

test("a price's history counts where each day ended up, not the steps of typing it in", () => {
  // The cost, then a pack of 1, 12, a typo of 127, then the real 27.2 kg: saved in that order, read back in any order.
  const a = { date: "2026-11-04", pack_cost: 190, pack_qty: 127, created_at: "2026-11-04T12:00:03Z" };
  const b = { date: "2026-11-04", pack_cost: 190, pack_qty: 27.2, created_at: "2026-11-04T12:00:04Z" };
  const c = { date: "2026-11-04", pack_cost: 190, pack_qty: 12, created_at: "2026-11-04T12:00:02Z" };
  const e = { date: "2026-11-04", pack_cost: 190, pack_qty: 1, created_at: "2026-11-04T12:00:01Z" };
  const old = { date: "2026-10-14", pack_cost: 7, pack_qty: 1, created_at: "2026-11-01T09:00:00Z" };
  assert.deepEqual(Costing.lastOfEachDay([a, b, c, old, e]), [old, b]);
  // Saved later but dated earlier (an old invoice): it stays in its own day.
  const late = { date: "2026-09-01", pack_cost: 5, pack_qty: 1, created_at: "2026-11-05T09:00:00Z" };
  assert.deepEqual(Costing.lastOfEachDay([b, late, old]), [late, old, b]);
  // This browser's own data has no times: the order it was saved in.
  const x = { date: "2026-11-04", pack_qty: 1 }, y = { date: "2026-11-04", pack_qty: 2 };
  assert.deepEqual(Costing.lastOfEachDay([x, y]), [y]);
  assert.deepEqual(Costing.lastOfEachDay([]), []);
});
