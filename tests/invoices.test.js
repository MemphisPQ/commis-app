const test = require("node:test");
const assert = require("node:assert");
const Invoices = require("../public/invoices.js");

// Hector Larivée order emails: items off the order guide come split over lines by a "Non-order guide" tag
// (or a "No substitutes selected" note), and the address above the table starts with a number too.
const hector = [
  "Thank you for order TEST01",
  "Hector Larivée <hello@example.com>Thu, Oct 22, 2026 at 8:49 PM",
  "A0000 TEST KITCHEN",
  "12 Rue Exemple, Montréal, QC H0H 0H0, Canada",
  "QtyItemUnitItem codePack unit priceAmount",
  "1Eggs Liquid Whites Frozen 12/1KG CS",
  "Non-order guide",
  "Case04735CA$79.95CA$79.95",
  "1Egg Yolks Liquid Plain Frozen 12/1KG CSCase04740CA$87.25CA$87.25",
  "No substitutes selected",
  "2Onions Medium 5LB UN",
  "Non-order guide",
  "Unit01168CA$4.60CA$9.20",
  "1\uF341 Eggs Large Bulk 15/12UN CSCase04744CA$61.55CA$61.55",
  "Subtotal (5 units)CA$237.95",
  "TotalCA$237.95",
].join("\n");

test("Hector: split lines are read, the address isn't, and the subtotal adds up", () => {
  const r = Invoices.read(hector);
  assert.strictEqual(r.supplier, "Hector Larivée");
  assert.strictEqual(r.date, "2026-10-22");
  assert.deepStrictEqual(r.lines.map((l) => [l.qty, l.item, l.code, l.price, l.total]), [
    [1, "Eggs Liquid Whites Frozen 12/1KG", "04735", 79.95, 79.95],
    [1, "Egg Yolks Liquid Plain Frozen 12/1KG", "04740", 87.25, 87.25],
    [2, "Onions Medium 5LB", "01168", 4.6, 9.2],
    [1, "Eggs Large Bulk 15/12UN", "04744", 61.55, 61.55],
  ]);
  assert.strictEqual(r.missed, 0);
});

test("Hector: a line that can't be read shows up as a gap against the subtotal", () => {
  const r = Invoices.read(hector.replace("Unit01168CA$4.60CA$9.20", "Unit01168 see store"));
  assert.strictEqual(r.lines.length, 3);
  assert.strictEqual(r.missed, 9.2);
});

test("Chez Nino: a name over two lines with its numbers on a third, and the subtotal check", () => {
  const r = Invoices.read([
    "Chez Nino", "DATE 15/10/2026", "PRODUITSDESCRIPTIONQTÉTAUXMONTANT",
    "Ciboulette61.8511.10", "Carotte nantaise orange (sac - ", "25lbs)", "156.0056.00", " ", "TOTAL PARTIEL67.10",
  ].join("\n"));
  assert.deepStrictEqual(r.lines.map((l) => [l.item, l.qty, l.price, l.total]), [["Ciboulette", 6, 1.85, 11.1], ["Carotte nantaise orange (sac - 25lbs)", 1, 56, 56]]);
  assert.strictEqual(r.missed, 0);
});

test("Can-Am: a brand pushing the total onto the next line; the subtotal sits below its label", () => {
  const r = Invoices.read([
    "Can-Am", "2026-05-29",
    "Rhubarbe10 lbRHU LO1  CACA1.000 38.5038.50 0 ",
    "Surgelé Jus de lime avec pulpe1LF JUS F496  UNUN6.000 10.50", "PERRICONE FARMS63.00 0 ",
    "Sous-total : ", "Taxe fédérale (121220438) : ", "Total facture : ", "101.50 ", "0.00 ", "101.50 ",
  ].join("\n"));
  assert.deepStrictEqual(r.lines.map((l) => [l.qty, l.uom, l.price, l.total]), [[1, "CA", 38.5, 38.5], [6, "UN", 10.5, 63]]);
  assert.strictEqual(r.subtotal, 101.5);
  assert.strictEqual(r.missed, 0);
});

test("billing words: a case is a pack, a unit is one piece, per lb is by weight", () => {
  assert.deepStrictEqual(Invoices.billedAs({ uom: "CA" }), { word: "case", weighed: false, pack: true });
  assert.deepStrictEqual(Invoices.billedAs({ uom: "UN" }), { word: "unit", weighed: false, pack: false });
  assert.deepStrictEqual(Invoices.billedAs({ uom: "LV", price: 2 }), { word: "lb", weighed: true, pack: false });
  assert.deepStrictEqual(Invoices.billedAs({ uom: "PK", sold: "bag" }), { word: "bag", weighed: false, pack: true });
});

test("packs in gallons, and words run together on an invoice", () => {
  const Units = require("../public/units.js");
  assert.deepStrictEqual(Invoices.packOf({ uom: "CA", item: "VINAIGRE DE RIZ 4x1GALLON" }, Units), { qty: 15.142, unit: "L" });
  assert.deepStrictEqual(Invoices.packOf({ uom: "CA", item: "Pommes Gala 3 lb" }, Units), { qty: 3, unit: "lb" });
  assert.ok(Invoices.words("16 x 1.5 kPoulet Entier Attaché").has("poulet"));
});
