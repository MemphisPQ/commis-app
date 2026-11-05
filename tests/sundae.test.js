const test = require("node:test");
const assert = require("node:assert/strict");
const Sundae = require("../public/sundae.js");

// Exactly what Sundae Atelier's "Send to Kitchen Costing" puts after #/import/ (its tests decode the same format).
const SENT = { v: 1, id: "3f1c-saved", name: "Crème glacée café", recipe: "Vanilla Ice Cream", temp: "-14°C", batch: 2.5,
  rows: [["Full fat milk", 1505.3], ["35% cream", 452.5], ["Skimmed powdered milk", 82.5], ["Dextrose", 202.5], ["Sugar", 155],
    ["Neutral ingredient for cream", 12.5], ["70% coating", 40, "Dark chocolate (70%)"], ["Sugar", 20]] };

test("a link from the calculator reads back as the recipe, accents and all", () => {
  const code = Sundae.encode(SENT);
  assert.match(code, /^[A-Za-z0-9_-]+$/);
  const r = Sundae.decode(code);
  assert.equal(r.id, "3f1c-saved");
  assert.equal(r.name, "Crème glacée café");
  assert.equal(r.recipe, "Vanilla Ice Cream");
  assert.equal(r.temp, "-14°C");
  assert.equal(r.batch, 2.5);
  assert.deepEqual(r.rows.find((x) => x.name === "70% coating"), { name: "70% coating", grams: 40, label: "Dark chocolate (70%)" });
  assert.deepEqual(r.rows.find((x) => x.name === "Full fat milk"), { name: "Full fat milk", grams: 1505.3, label: "Full fat milk" });
  assert.equal(r.rows.filter((x) => x.name === "Sugar").length, 1, "the same ingredient twice is one line");
  assert.equal(r.rows.find((x) => x.name === "Sugar").grams, 175);
});

test("a broken or foreign link says so in plain words", () => {
  assert.throws(() => Sundae.decode("not*base64"), /isn't a recipe from Sundae Atelier/);
  assert.throws(() => Sundae.decode(Sundae.encode(SENT).slice(0, 40)), /isn't a recipe from Sundae Atelier/);
  assert.throws(() => Sundae.decode(Sundae.encode({ ...SENT, v: 2 })), /newer or older calculator/);
  assert.throws(() => Sundae.decode(Sundae.encode({ ...SENT, name: " " })), /no name/);
  assert.throws(() => Sundae.decode(Sundae.encode({ ...SENT, batch: 0 })), /batch weight/);
  assert.throws(() => Sundae.decode(Sundae.encode({ ...SENT, rows: [] })), /no ingredients/);
  assert.throws(() => Sundae.decode(Sundae.encode({ ...SENT, rows: [["Milk", "lots"]] })), /broken/);
});

const ing = (id, name, base = "kg", extra = {}) => ({ id, name, base, yield: 1, ...extra });
const DATA = {
  ingredients: [ing("milk", "Lait, 3.25%"), ing("milk2", "Lait 2%", "L"), ing("cream", "Creme 35", "L"), ing("cook", "Creme, Cooking 35%"),
    ing("smp", "Poudre Lait, Skim"), ing("dex", "Sucre, Dextrose"), ing("sugar", "Sucre (Bruno)"), ing("brown", "Sucre, brun", "L"),
    ing("choc", "Chocolat 70%"), ing("salt1", "Sel"), ing("salt2", "Salt"), ing("blue", "Congeler bleuets", "unit"), ing("yolk", "Oeuf, Yolks, FRZ"),
    ing("lemon", "Congeler jus citron"), ing("water", "L'eau")],
  recipes: [{ id: "fill", name: "Blueberry Filling", kind: "prep", yield_unit: "portion" }, { id: "inv", name: "Sucre Inverse, Recipe 1", kind: "prep" }],
};
const pick = (n) => { const m = Sundae.match(n, DATA); return m && m.id; };

test("calculator names are matched to your items by meaning, not by spelling", () => {
  assert.equal(pick("Full fat milk"), "milk");
  assert.equal(pick("35% cream"), "cream", "Creme 35, not the cooking cream");
  assert.equal(pick("Skimmed powdered milk"), "smp");
  assert.equal(pick("Dextrose"), "dex");
  assert.equal(pick("Sugar"), "sugar", "plain sugar, not brown sugar or dextrose");
  assert.equal(pick("70% coating"), "choc");
  assert.equal(pick("Egg yolk"), "yolk");
  assert.equal(pick("Lemon juice"), "lemon");
  assert.equal(pick("Water"), "water");
  assert.equal(pick("Blueberry"), "blue", "an ingredient wins a tie with a prep");
});

test("no guess when it would be a coin toss or the wrong product", () => {
  assert.equal(pick("Salt"), null, "two items called Sel and Salt: you pick once");
  assert.equal(pick("Skimmed milk"), null, "skim milk isn't skim milk powder");
  assert.equal(pick("Neutral ingredient for cream"), null);
  assert.equal(pick("Strawberry"), null);
});

test("a prep of your own can be the match: inverted sugar made in-house", () => {
  assert.deepEqual(Sundae.match("Inverted sugar", DATA), { kind: "prep", id: "inv", score: 0.5 });
  const bought = { ...DATA, ingredients: DATA.ingredients.concat([ing("invsug", "Sucre, Inverse")]) };
  assert.equal(Sundae.match("Inverted sugar", bought).id, "invsug", "a closer item wins");
});

test("grams become a line by weight, or millilitres for items priced per litre", () => {
  assert.deepEqual(Sundae.lineFor(1505.33, "Full fat milk", DATA.ingredients[0]), { qty: 1505.3, unit: "g" });
  assert.deepEqual(Sundae.lineFor(1030, "Full fat milk", DATA.ingredients[1]), { qty: 1000, unit: "ml", density: 1.03 });
  assert.deepEqual(Sundae.lineFor(452.5, "35% cream", DATA.ingredients[2]), { qty: 452.5, unit: "ml", density: 1 });
  assert.equal(Sundae.density("Maple syrup"), 1.32);
  assert.equal(Sundae.density("Honey"), 1.42);
  assert.equal(Sundae.density("40% alc. vodka"), 0.95);
  assert.equal(Sundae.density("Tea infusion"), 1);
  assert.deepEqual(Sundae.lineFor(80, "Blueberry", DATA.ingredients[11]), { qty: 80, unit: "g" }, "pieces by weight, through 1 unit weighs");
  assert.deepEqual(Sundae.lineFor(40, "Inverted sugar", { id: "p", kind: "prep", yield_unit: "kg" }), { qty: 40, unit: "g" });
});
