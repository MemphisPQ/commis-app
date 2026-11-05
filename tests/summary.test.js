/* The inventory's summary: groups, totals and the month's food cost. Made-up numbers. */
const test = require("node:test");
const assert = require("node:assert/strict");
const Summary = require("../public/summary.js");

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const row = (section, value, counted = true) => ({ section, value: counted ? value : 0, counted });

test("every section goes where a kitchen would put it, in French or English", () => {
  const expected = {
    Viande: "food", "Volaile": "food", Poisson: "food", Laitiere: "food", "Vegé": "food", Herbes: "food", Seches: "food", Epices: "food",
    Noix: "food", Graines: "food", "Misc.": "food", Autre: "food", Preppeds: "food", "No section": "food",
    "Mono Emporter": "takeout", "Mono Nettoyants": "cleaning", "Mono Cuisine": "kitchen",
    Vins: "alcohol", "Bières": "alcohol", Spiritueux: "alcohol", Beer: "alcohol", Bar: "alcohol", Cocktails: "alcohol",
    Boissons: "drinks", "Café": "drinks", "Soft drinks": "drinks", Coffee: "drinks", "Takeout": "takeout", "To go": "takeout", Emballages: "takeout",
    Cleaning: "cleaning", Entretien: "cleaning", "Salle à manger": "dining", "Dining room": "dining", Boutique: "retail", Merch: "retail",
  };
  for (const [section, group] of Object.entries(expected)) assert.equal(Summary.guessGroup(section), group, section);
});

test("the guess doesn't trip on words that only look alike", () => {
  for (const section of ["Vegetables", "Vinaigres", "Thon", "Barbecue", "Salades", "Tomates", "Sallé", "Baguettes", "Goto"]) {
    assert.equal(Summary.guessGroup(section), "food", section);
  }
});

test("your pick beats the guess, and a pick that doesn't exist is ignored", () => {
  assert.equal(Summary.groupOf("Mono Emporter", {}), "takeout");
  assert.equal(Summary.groupOf("Mono Emporter", { "Mono Emporter": "food" }), "food");
  assert.equal(Summary.groupOf("Seches", { Seches: "not-a-group" }), "food");
  assert.equal(Summary.groupOf("Seches", null), "food");
});

test("groups add up, keep to their kind of cost, and hide when empty", () => {
  const now = [row("Viande", 100), row("Viande", 50), row("Vegé", 25), row("Preppeds", 200), row("Mono Emporter", 30), row("Mono Nettoyants", 40), row("Mono Cuisine", 10)];
  const last = [row("Viande", 120), row("Vegé", 25), row("Preppeds", 150), row("Mono Emporter", 20), row("Mono Nettoyants", 80), row("Mono Cuisine", 5)];
  const s = Summary.build(now, last, {});
  assert.deepEqual(s.tiers.map((t) => t.label), ["Food cost", "Not food cost"]);
  const food = s.groups.find((g) => g.key === "food");
  close(food.now, 375);
  close(food.last, 295);
  close(food.change, 80);
  assert.deepEqual(food.sections.map((x) => x.name), ["Viande", "Vegé", "Preppeds"]);
  close(food.sections[0].now, 150);
  assert.equal(food.sections[0].items, 2);
  assert.deepEqual(s.groups.map((g) => g.key), ["food", "takeout", "kitchen", "cleaning"]);
  close(s.total.now, 455);
  close(s.total.last, 400);
  close(s.total.change, 55);
});

test("the groups always add up to the count's total, whatever the picks", () => {
  const now = [row("A", 1.1), row("B", 2.2), row("C", 3.3), row("Mono X", 4.4)], last = [row("A", 5), row("D", 6)];
  for (const saved of [{}, { A: "alcohol", B: "retail" }, { A: "cleaning", B: "cleaning", C: "cleaning", "Mono X": "cleaning" }]) {
    const s = Summary.build(now, last, saved);
    close(s.groups.reduce((t, g) => t + g.now, 0), 11);
    close(s.groups.reduce((t, g) => t + g.last, 0), 11);
    close(s.total.now, 11);
  }
});

test("a section picked into a drinks group makes the beverage line appear", () => {
  const s = Summary.build([row("Vins", 500), row("Viande", 100)], [], {});
  assert.deepEqual(s.tiers.map((t) => t.key), ["food", "beverage"]);
  assert.equal(s.tiers[1].groups[0].label, "Alcohol");
});

test("a section with nothing counted is called out, and one with last month only shows too", () => {
  const s = Summary.build([row("Viande", 100), row("Volaile", 0, false), row("Volaile", 0, false), row("Vegé", 5), row("Vegé", 0, false)], [row("Volaile", 900), row("Gone", 7)], {});
  assert.deepEqual(s.notCounted, ["Volaile"]);
  const food = s.groups.find((g) => g.key === "food");
  const volaile = food.sections.find((x) => x.name === "Volaile");
  assert.equal(volaile.items, 2);
  assert.equal(volaile.counted, 0);
  close(volaile.last, 900);
  close(volaile.change, -900);
  close(food.sections.find((x) => x.name === "Gone").last, 7);
  assert.equal(food.lastCounted, 2);
});

test("an empty month is fine", () => {
  const s = Summary.build([], [], {});
  assert.deepEqual(s.tiers, []);
  assert.equal(s.total.now, 0);
  assert.deepEqual(s.notCounted, []);
});

test("food cost: (last month's stock + purchases - this month's stock) / sales", () => {
  const f = Summary.foodCost({ open: 8000, purchases: 12000, close: 9000, sales: 40000 });
  assert.equal(f.used, 11000);
  close(f.pct, 0.275);
});

test("food cost: anything left blank just leaves what needs it empty", () => {
  assert.deepEqual(Summary.foodCost({ open: 8000, close: 9000 }), { used: null, pct: null });
  assert.deepEqual(Summary.foodCost({ open: 8000, close: 9000, sales: 100 }), { used: null, pct: null });
  assert.deepEqual(Summary.foodCost({ open: 8000, purchases: 1000, close: 8500 }), { used: 500, pct: null });
  assert.deepEqual(Summary.foodCost({ open: 8000, purchases: 1000, close: 8500, sales: 0 }), { used: 500, pct: null });
  assert.deepEqual(Summary.foodCost({ purchases: 1000, close: 8500, sales: 100 }), { used: null, pct: null });
  assert.deepEqual(Summary.foodCost({}), { used: null, pct: null });
  // Purchases of 0 is a number, not a blank.
  assert.equal(Summary.foodCost({ open: 100, purchases: 0, close: 60, sales: 80 }).pct, 0.5);
});

test("purchases and sales read the way people write big amounts", () => {
  const cases = { "12000": 12000, "12 000": 12000, "12,000": 12000, "1,234,567": 1234567, "12,000.50": 12000.5, "12.000,50": 12000.5, "12 000,50": 12000.5, "$12000": 12000, "$ 12 000": 12000,
    "12,5": 12.5, "12,50": 12.5, "12.5": 12.5, "0": 0, "0,75": 0.75, ".5": 0.5, "1800.": 1800 };
  for (const [text, value] of Object.entries(cases)) assert.equal(Summary.parseAmount(text), value, text);
  assert.equal(Summary.parseAmount("12\u00a0000"), 12000);
  for (const bad of ["abc", "12a", "-5", "1.2.3", "1,2,3", ",", "."]) assert.equal(Summary.parseAmount(bad), null, bad);
  for (const empty of ["", "   ", null, undefined]) assert.equal(Summary.parseAmount(empty), null);
});

test("only a section that looks forgotten is called out, not one that's never counted", () => {
  const now = [row("Viande", 100), row("Autre", 0, false), row("Volaile", 0, false)];
  // Volaile was counted last month and isn't now; Autre has never been counted.
  assert.deepEqual(Summary.build(now, [row("Viande", 90), row("Autre", 0, false), row("Volaile", 50)], {}).notCounted, ["Volaile"]);
  // No count last month to go by: anything with nothing counted.
  assert.deepEqual(Summary.build(now, [row("Viande", 0, false), row("Autre", 0, false), row("Volaile", 0, false)], {}).notCounted, ["Autre", "Volaile"]);
  assert.deepEqual(Summary.build(now, [], {}).notCounted, ["Autre", "Volaile"]);
});
