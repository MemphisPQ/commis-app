const test = require("node:test");
const assert = require("node:assert");
const Invoices = require("../public/invoices.js");
const Units = require("../public/units.js");

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

// Made up, in the layout of Hector Larivée's own PDF, with its accents drawn apart the way the PDF gives them.
const hectorPdf = [
  ".", "INV16O00010100", "1234560001", "Hector Lariv \u0301ee", "1 rue Test", "MONTREAL, QC H0H 0H0", "Facture / Invoice", "# 00123456",
  "Vendu `a / Bill to:", "RESTO TEST", "1 rue Test", "No client / Customer: A0000", "Date:06/11/26", "Conditions:7 JOURS", "Date due:13/11/26",
  "Item", "#", "Comm.", "Ord.", "Exp.", "Ship.", "Description", "Origine", "Origin", "Prix", "Price", "Total",
  "0631011Bo\u02C6\u0131te d\u2019unit \u0301e$.00$.00",
  "* * * Unit \u0301e * * *",
  "0068311Aneth Dill1UN UNMEX$2.25$2.25",
  "0778622Ciboulettes4UN CLMEX$8.25$16.50",
  "0072555Persil1UN UNMEX$1.00$5.00",
  "0197311Limes5/9UN 1LBMEX$7.30$7.30",
  "0196311Citrons138/140UNUSA$55.00$55.00",
  "0374211Oignons Jaunes Extra Larges50LB CSQC$26.60$26.60",
  "0114311", " \u0301", "Echalotes S \u0301ech \u0301ees Larges10LB CS", "QC$26.60$26.60",
  "0828811Pistache", " \u0301", "Ecaill \u0301ee Enti`ere2KG CSUSA$138.30$138.30",
  "0267411Ma", " \u0308", "\u0131s En Grains Surgel \u0301e6/2KG CSCAN$47.95$47.95",
  "0100010Pas Livr \u0301e1UN UNQC$9.00$.00",
  "01111105Dix Command \u0301es1UN UNQC$2.00$10.00",
  "Instructions sp \u0301eciales / Special Instructions:", "LIVRAISON PAR L\u2019ARRI", "`", "ERE,", "PRENDRE CL", " \u0301", "E DANS KEYBOX",
  "Sous-total / Sub-total$335.50", "T.P.S. / G.S.T. R000000000$.00", "T.V.Q. / Q.S.T. 0000000000$.00", "Total1010Total$335.50",
  "Page 1 of 1",
].join("\n");

test("Hector's own invoice: every row, its accents put back, split rows joined, the subtotal adding up", () => {
  const r = Invoices.read(hectorPdf);
  assert.strictEqual(r.supplier, "Hector Larivée");
  assert.strictEqual(r.date, "2026-11-06", "day first: the due date is a week later");
  assert.strictEqual(r.subtotal, 335.5);
  assert.strictEqual(r.missed, 0);
  assert.deepStrictEqual(r.lines.map((l) => [l.item, l.format, l.code, l.qty, l.price, l.total]), [
    ["Aneth Dill", "1UN", "00683", 1, 2.25, 2.25],
    ["Ciboulettes", "4UN", "07786", 2, 8.25, 16.5],
    ["Persil", "1UN", "00725", 5, 1, 5],
    ["Limes", "5/9UN 1LB", "01973", 1, 7.3, 7.3],
    ["Citrons", "138/140UN", "01963", 1, 55, 55],
    ["Oignons Jaunes Extra Larges", "50LB", "03742", 1, 26.6, 26.6],
    ["Échalotes Séchées Larges", "10LB", "01143", 1, 26.6, 26.6],
    ["Pistache Écaillée Entière", "2KG", "08288", 1, 138.3, 138.3],
    ["Maïs En Grains Surgelé", "6/2KG", "02674", 1, 47.95, 47.95],
    ["Dix Commandés", "1UN", "01111", 5, 2, 10],
  ]);
});

test("Hector's own invoice: how each row is sold, and what one price buys", () => {
  const lines = Invoices.read(hectorPdf).lines, by = (name) => lines.find((l) => l.item === name);
  assert.strictEqual(by("Aneth Dill").sold, "unit");
  assert.strictEqual(by("Ciboulettes").sold, "bag");
  assert.strictEqual(by("Oignons Jaunes Extra Larges").sold, "case");
  const pack = (name) => Invoices.packOf(by(name), Units);
  assert.deepStrictEqual(pack("Aneth Dill"), { qty: 1, unit: "unit" });
  assert.deepStrictEqual(pack("Ciboulettes"), { qty: 4, unit: "unit" });
  assert.deepStrictEqual(pack("Oignons Jaunes Extra Larges"), { qty: 50, unit: "lb" });
  assert.deepStrictEqual(pack("Maïs En Grains Surgelé"), { qty: 12, unit: "kg" }, "6 bags of 2 kg");
  assert.deepStrictEqual(pack("Citrons"), { qty: 139, unit: "unit" }, "a case of 138 to 140, not 138 × 140");
  assert.deepStrictEqual(pack("Limes"), { qty: 7, unit: "unit" }, "a bag of 5 to 9");
  assert.strictEqual(Invoices.lineKey(by("Aneth Dill")), "Aneth Dill 1UN");
});

test("Hector's order emails still read as before, and a size range there costs out the same way", () => {
  const email = ["Thank you for order TEST01", "Hector Larivée <hello@example.com>Thu, Oct 22, 2026 at 8:49 PM", "QtyItemUnitItem codePriceTotal",
    "1Limes 5/9UN 1LB CLBag01973CA$7.30CA$7.30", "1Eggs Large Bulk 15/12UN CSCase00111CA$90.00CA$90.00", "Subtotal (2 units)CA$97.30"].join("\n");
  const r = Invoices.read(email);
  assert.strictEqual(r.missed, 0);
  assert.deepStrictEqual(Invoices.packOf(r.lines[0], Units), { qty: 7, unit: "unit" });
  assert.deepStrictEqual(Invoices.packOf(r.lines[1], Units), { qty: 180, unit: "unit" }, "15 flats of 12 still multiply");
});

test("the same supplier, item and pack under another name updates the price you have, not a second one", () => {
  const offers = [
    { id: "case", supplier: "Hector Larivée", supplier_item: "Limes 48/54UN", pack_qty: 51, pack_unit: "unit" },
    { id: "dill", supplier: "Hector Larivée", supplier_item: "Dill 1UN", pack_qty: 1, pack_unit: "unit" },
    { id: "other", supplier: "Can-Am", supplier_item: "Aneth 1 un", pack_qty: 1, pack_unit: "unit" },
    { id: "blank", supplier: "Hector Larivée", supplier_item: "", pack_qty: 3, pack_unit: "kg" },
  ];
  const line = (item, format, packQty, packUnit, offerId) => ({ item, format, packQty, packUnit, offerId });
  const pick = (l, supplier = "Hector Larivée", preferred) => (Invoices.offerFor(l, supplier, offers, preferred) || {}).id;
  assert.strictEqual(pick(line("Aneth Dill", "1UN", 1, "unit")), "dill", "the invoice's French name, the email's English one");
  assert.strictEqual(pick(line("Limes", "48/54UN", 51, "unit")), "case", "the same description");
  assert.strictEqual(pick(line("Limes", "5/9UN 1LB", 7, "unit")), undefined, "another pack is another price");
  assert.strictEqual(pick(line("Quelque Chose", "2KG", 2, "kg", "blank")), "blank", "a price with no description yet takes it on");
  assert.strictEqual(pick(line("Quelque Chose", "2KG", 2, "kg", "dill")), undefined, "one with its own description and another pack doesn't");
  assert.strictEqual(pick(line("Aneth", "1UN", 1, "unit"), "Chez Nino"), undefined, "another supplier is another price");
  const two = [{ id: "a", supplier: "X", supplier_item: "A", pack_qty: 1, pack_unit: "kg" }, { id: "b", supplier: "X", supplier_item: "B", pack_qty: 1, pack_unit: "kg" }];
  assert.strictEqual(Invoices.offerFor(line("C", "", 1, "kg"), "X", two, "b").id, "b", "with two the same, the ticked one");
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

// Made up, in the layout of Boulangerie Guillaume's cash-register invoice: the taxes come first in the text, then the items, then the
// header. Rows run together: product number | name | quantity | price | discount | amount.
const guillaume = (date) => [
  "", "", "TPS: 000000000rt0001$1.00", "TVQ: ", "0000000000tq0001", "$2.00", "Total$1375.00",
  "No produitArticlesQtéPrixRabaisMontant",
  "100001Miche Test12$5.00$0.00$60.00",
  "100002Baguette 23$2.00$0.00$6.00",
  "100003Pain Test10$4.00$4.00$36.00",
  "100004Gâteau Test1$1,250.00$0.00$1,250.00",
  "100005Échantillon2$3.00$6.00$0.00",
  "100099LIVRAISON 20,00$1$20.00$0.00$20.00",
  "29$10.00$1,372.00",
  "Paiement sur ", "compte 0000000", "($1375.00)", "Merci! Thank You!     ",
  "Numéro:", "Date:", date, "0000000000000", "Empl:", "Caisse:", "Test", "1",
  "Vendu à :Resto Test", "1 rue Test", "Montréal, Quebec", "H0H 0H0", "Livrer à : ",
  "Boulangerie Guillaume", "1 boul Test", "Montreal, Qc  H0H0H0", "www.guillau.me", "000-000-0000", "Facture",
].join("\n");

test("Boulangerie Guillaume: every row, the quantity off the end of the name, the delivery fee, the subtotal adding up", () => {
  const r = Invoices.read(guillaume("03/04/2026"));
  assert.strictEqual(r.supplier, "Boulangerie Guillaume");
  assert.strictEqual(r.date, "2026-03-04", "month first");
  assert.deepStrictEqual(r.lines.map((l) => [l.code, l.item, l.qty, l.uom, l.price, l.total]), [
    ["100001", "Miche Test", 12, "UN", 5, 60],
    ["100002", "Baguette 2", 3, "UN", 2, 6],
    ["100003", "Pain Test", 10, "UN", 3.6, 36],
    ["100004", "Gâteau Test", 1, "UN", 1250, 1250],
    ["100099", "LIVRAISON 20,00$", 1, "UN", 20, 20],
  ], "a name ending in a number keeps it; a discount comes off the price; something free isn't a line");
  assert.strictEqual(r.subtotal, 1372);
  assert.strictEqual(r.missed, 0);
  assert.deepStrictEqual(Invoices.packOf(r.lines[0], Units), { qty: 1, unit: "unit" });
});

test("Boulangerie Guillaume: a date that can't be month first is day first", () => {
  assert.strictEqual(Invoices.read(guillaume("25/04/2026")).date, "2026-04-25");
});
