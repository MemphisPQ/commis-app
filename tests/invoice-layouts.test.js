const test = require("node:test");
const assert = require("node:assert");
const Invoices = require("../public/invoices.js");

// All made up: no real supplier's invoice, price or customer goes in the tests.
const qbFr = [
  "Page 1 of 1", "Ferme Exemple inc.", "1 rue Test", "Montréal QC  H0H 0H0",
  "FACTURE", "FACTURÉ À", "Resto Test", "Nº DE FACTURE123", "DATE04/05/2026", "MODALITÉSNet 30", "ÉCHÉANCE03/06/2026",
  "PRODUITSDESCRIPTIONQTÉTAUXMONTANT",
  "Radis rouge (bunch)13.503.50",
  "Chou rouge (lbs)2 un9.341.2511.68",
  "Carotte nantaise orange (sac -", "25lbs)", "156.0056.00",
  "Tomates 2813.503.50",
  "TOTAL PARTIEL74.68", "TPS @ 0%0.00", "TOTAL74.68", "SOLDE À PAYER", "$74.68",
].join("\n");
const qbEn = [
  "Pay by transfer:", "Page 1 of 1", "Green Test Farm Ltd.", "2 Test Road",
  "INVOICE", "BILL TO", "Test Bistro", "INVOICE2717", "DATE07/08/2026", "TERMSNet 30", "DUE DATE08/07/2026",
  "QTYACTIVITYDESCRIPTIONRATEAMOUNT",
  "2r-Te-Maitake/5LBSMaitake box of 5LBs85,29170,58",
  "1Basil bunch1 250,001 250,00",
  "Prices may change without notice", "SUBTOTAL1 420,58",
].join("\n");
const qbDated = [
  "Page 1 of 1", "Labo Exemple Inc. / Exemple Lab Inc.", "FACTURE", "FACTURÉ À", "Resto Test",
  "DATE", "D’EXPÉDITION", "2026-10-08", "DATE2026-10-07", "ÉCHÉANCE2026-10-21",
  "DATEACTIVITÉDESCRIPTIONQTÉTAUXMONTANT",
  "2026-10-08Lobster mushroomLobster Mushroom ( sauvage", "du Québec )", "518,0090,00",
  "TOTAL PARTIEL90,00", "TOTAL90,00",
].join("\n");

test("QuickBooks in French: any supplier, its name from the invoice, day-first date, numbers that run together", () => {
  const r = Invoices.read(qbFr);
  assert.strictEqual(r.supplier, "Ferme Exemple");
  assert.strictEqual(r.date, "2026-05-04");
  assert.deepStrictEqual(r.lines.map((l) => [l.item, l.qty, l.uom, l.price, l.total]), [
    ["Radis rouge (bunch)", 1, "UN", 3.5, 3.5],
    ["Chou rouge (lbs)", 9.34, "LB", 1.25, 11.68],
    ["Carotte nantaise orange (sac - 25lbs)", 1, "UN", 56, 56],
    ["Tomates 28", 1, "UN", 3.5, 3.5],
  ]);
  assert.strictEqual(r.subtotal, 74.68);
  assert.strictEqual(r.missed, 0);
});

test("QuickBooks in English: quantity first, comma decimals, month-first date from the due date, thousands", () => {
  const r = Invoices.read(qbEn);
  assert.strictEqual(r.supplier, "Green Test Farm");
  assert.strictEqual(r.date, "2026-07-08");
  assert.deepStrictEqual(r.lines.map((l) => [l.qty, l.price, l.total]), [[2, 85.29, 170.58], [1, 1250, 1250]]);
  assert.strictEqual(r.missed, 0);
});

test("QuickBooks with a date column: the date and the repeated product name come off, a name over two lines", () => {
  const r = Invoices.read(qbDated);
  assert.strictEqual(r.supplier, "Labo Exemple");
  assert.strictEqual(r.date, "2026-10-07");
  assert.deepStrictEqual(r.lines.map((l) => [l.item, l.qty, l.price, l.total]), [["Lobster Mushroom ( sauvage du Québec )", 5, 18, 90]]);
  assert.strictEqual(r.missed, 0);
});

test("a known supplier's name on someone else's QuickBooks invoice doesn't take it over", () => {
  const r = Invoices.read(qbFr.replace("Radis rouge (bunch)", "Truite de la mer"));
  assert.strictEqual(r.supplier, "Ferme Exemple");
  assert.strictEqual(r.lines[0].item, "Truite de la mer");
});

test("Chez Nino and Brin-Nature keep their names, so what's remembered for them still matches", () => {
  assert.strictEqual(Invoices.read(qbFr.replace("Ferme Exemple inc.", "Chez Nino")).supplier, "Chez Nino");
  assert.strictEqual(Invoices.read(qbEn.replace("Green Test Farm Ltd.", "Brin-Nature Inc.")).supplier, "BrinNature");
});

test("Pepper: any distributor's order email, its name from the sender", () => {
  const t = ["Thank you for order TEST02", "Fruits Exemple <hello+abc@messages.usepepper.com>Mon, Jul 6, 2026 at 8:49 PM", "QtyItemUnitItem codePack unit priceAmount",
    "2Onions Medium 5LB UNUnit01168CA$4.60CA$9.20", "Subtotal (2 units)CA$9.20", "TotalCA$9.20"].join("\n");
  const r = Invoices.read(t);
  assert.strictEqual(r.supplier, "Fruits Exemple");
  assert.strictEqual(r.date, "2026-07-06");
  assert.deepStrictEqual(r.lines.map((l) => [l.qty, l.price, l.total]), [[2, 4.6, 9.2]]);
  assert.strictEqual(r.missed, 0);
});

test("Amazon.ca: the English name, the price before tax, shipping isn't a line, the subtotal adds up", () => {
  const t = ["Invoice / Facture", "Amazon.com.ca ULC", "Invoice subtotal / Total partiel de la", "facture", "$26.42", "Invoice date / Date de facturation:", "22 February 2026",
    "Sous-total de", "l’article", "Test Gum, 200g / Gomme test,", "200 g", "ASIN: B000000000", "2$9.99$0.00$1.00$2.00$22.98",
    "Shipping charges / Frais d'expédition$2.99$0.00$0.15$0.30$3.44"].join("\n");
  const r = Invoices.read(t);
  assert.strictEqual(r.supplier, "Amazon.ca");
  assert.strictEqual(r.date, "2026-02-22");
  assert.deepStrictEqual(r.lines.map((l) => [l.item, l.qty, l.uom, l.price, l.total]), [["Test Gum, 200g", 2, "UN", 9.99, 19.98]]);
  assert.strictEqual(r.missed, 0);
});
