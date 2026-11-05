const test = require("node:test");
const assert = require("node:assert/strict");
const XLSX = require("xlsx");
const mammoth = require("mammoth");
const fs = require("node:fs");
const path = require("node:path");
const JSZip = require("jszip");
const MenuFile = require("../public/menufile.js");

const MENU = {
  name: "Noel 2026", date: "2026-11-02",
  dishes: [
    { name: "Tourtière", category: "Plats", price: 28, cost: 7.4, foodCost: 7.4 / 28, target: 29.6, allergens: "Contains gluten, milk. May contain sesame.",
      contents: [{ name: "Porc, Haché", amount: "180 g" }, { name: "Pâte brisée", amount: "1 portion" }] },
    { name: "Bûche <érable> & \"crème\"", category: "Dessert", price: null, cost: 3.1, foodCost: null, target: 12.4, allergens: "",
      contents: [{ name: "Sirop d'érable", amount: "40 ml" }] },
  ],
  preps: [{ name: "Pâte brisée", makes: "12 Portions", usedIn: ["Tourtière"] }],
};

test("the menu list workbook opens, with its three tabs, numbers as numbers and the text as typed", async () => {
  const wb = XLSX.read(await MenuFile.menuXlsx(MENU), { cellNF: true });
  assert.deepEqual(wb.SheetNames, ["Kitchen", "Front of house", "Preps"]);
  const k = XLSX.utils.sheet_to_json(wb.Sheets.Kitchen, { header: 1, defval: null });
  assert.equal(k[0][0], "Noel 2026");
  assert.deepEqual(k[2], ["Category", "Dish", "Menu price", "Cost / portion", "Food cost", "Target price", "Allergens", "What's in it"]);
  assert.deepEqual(k[3].slice(0, 6), ["Plats", "Tourtière", 28, 7.4, 7.4 / 28, 29.6]);
  assert.equal(k[3][6], "Contains gluten, milk. May contain sesame.");
  assert.equal(k[3][7], "180 g Porc, Haché · 1 portion Pâte brisée");
  assert.equal(k[4][6], null, "no allergen info: the cell stays empty");
  assert.equal(k[4][1], "Bûche <érable> & \"crème\"");
  assert.equal(k[4][2], null, "no menu price: the cell stays empty");
  assert.equal(wb.Sheets.Kitchen.C4.z, "\"$\"#,##0.00");
  assert.equal(wb.Sheets.Kitchen.E4.z, "0%");
  const f = XLSX.utils.sheet_to_json(wb.Sheets["Front of house"], { header: 1, defval: null });
  assert.deepEqual(f[3], ["Plats", "Tourtière", 28, "Contains gluten, milk. May contain sesame.", "Porc, Haché · Pâte brisée"]);
  const p = XLSX.utils.sheet_to_json(wb.Sheets.Preps, { header: 1, defval: null });
  assert.deepEqual(p[3], ["Pâte brisée", "12 Portions", "Tourtière"]);
});

test("the menu lists to print open in Word: front of house without costs, kitchen with them and the preps", async () => {
  const front = (await mammoth.extractRawText({ buffer: await MenuFile.menuDocx(MENU, "front") })).value;
  assert.match(front, /Noel 2026/);
  assert.match(front, /Plats\s+Tourtière\s*\t?\$28\.00/);
  assert.match(front, /Porc, Haché · Pâte brisée\s+Allergens: Contains gluten, milk\. May contain sesame\./);
  assert.doesNotMatch(front, /Cost|food cost|180 g/);
  const kitchen = (await mammoth.extractRawText({ buffer: await MenuFile.menuDocx(MENU, "kitchen") })).value;
  assert.match(kitchen, /Cost \$7\.40 · food cost 26% · target \$29\.60\s+Allergens: Contains gluten, milk\. May contain sesame\./);
  assert.equal((kitchen.match(/Allergens:/g) || []).length, 1, "a dish with no allergen info has no allergen line");
  assert.match(kitchen, /180 g {2}Porc, Haché/);
  assert.match(kitchen, /Bûche <érable> & "crème"/);
  assert.match(kitchen, /Preps\s+Pâte brisée {2}makes 12 Portions\s+Used in: Tourtière/);
});

test("the menu item details come from the front-of-house template: one entry per dish, the hand-written lines left empty", async () => {
  const tpl = fs.readFileSync(path.join(__dirname, "../public/templates/menu-item-details.docx"));
  const out = await MenuFile.itemDetailsDocx(tpl, MENU);
  const text = (await mammoth.extractRawText({ buffer: out })).value.replace(/\n+/g, "\n");
  assert.match(text, /^Noel 2026\nMenu item details · 2 dishes · 2026-11-02\n/);
  assert.match(text, /Menu Item Entry 1\nItem Name: Tourtière\nPrice: \$28\.00\nIngredients: Porc, Haché · Pâte brisée\nAllergens: Contains gluten, milk\. May contain sesame\.\nSubstitutions: \nTasting Notes: \nOptional Pairings: \n/);
  assert.match(text, /Menu Item Entry 2\nItem Name: Bûche <érable> & "crème"\nPrice: \nIngredients: Sirop d'érable\nAllergens: \n/);
  assert.doesNotMatch(text, /Menu Item Entry 3|\[|Copy and paste|Template/);
  // The template's look stays: its fonts, styles and the heading of each entry.
  const zip = await JSZip.loadAsync(out);
  assert.ok(zip.file("word/fonts/Figtree-regular.ttf"));
  const doc = await zip.file("word/document.xml").async("string");
  assert.equal((doc.match(/<w:pStyle w:val="Heading1"\/>/g) || []).length, 2);
  // An entry stays on one page: every line but its last keeps with the next (2 entries of 9 lines).
  assert.equal((doc.match(/<w:keepNext\/>/g) || []).length, 16);
  const ids = doc.match(/w14:paraId="[^"]*"/g) || [], marks = doc.match(/<w:bookmarkStart [^>]*>/g) || [];
  assert.equal(new Set(ids).size, ids.length, "paragraph ids stay unique");
  assert.equal(new Set(marks).size, marks.length, "bookmarks stay unique");
});

test("a plain recipe card when there's no template", async () => {
  const card = { name: "Pâte brisée", readyIn: "1 hr", yieldText: "12 Portions", ingredients: ["500 g Farine", "250 g Beurre"], steps: ["Mix", "Rest"], notes: ["Keeps 3 days"] };
  const text = (await mammoth.extractRawText({ buffer: await MenuFile.cardDocx(card) })).value;
  assert.match(text, /RECIPE “Pâte brisée”/);
  assert.match(text, /Ready in 1 hr {3}· {3}Yield: 12 Portions/);
  assert.match(text, /• 500 g Farine\s+• 250 g Beurre/);
  assert.match(text, /1\. Mix\s+2\. Rest/);
  assert.match(text, /Notes\s+Keeps 3 days/);
});

test("file names are safe everywhere", () => {
  assert.equal(MenuFile.fileName('Menu 2026/02: "Winter"?'), "Menu 2026-02- -Winter-");
  assert.equal(MenuFile.fileName("  "), "untitled");
});
