/* Sort by, inside each section of the Dishes list and on a menu's page. Made-up dishes only. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const fn = (name) => new RegExp(`\\n {2}function ${name}\\([\\s\\S]*?\\n {2}\\}\\n`).exec(app)[0];
const line = (name) => new RegExp(`\\n {2}const ${name} = [^\\n]+;`).exec(app)[0];

// The dishes: [name, category, cost per portion, menu price]
const dishes = [
  ["Tarte", "Dessert", 2, 10], ["Agnolotti", "Plats", 6, 20], ["Soupe", "Entrée", 1.5, null], ["Bavette", "Plats", 9, 30], ["Pain", "", 0.5, 4],
].map(([name, category, per, price], k) => ({ id: "d" + k, name, category, per, price }));
const stored = {};
const ctx = {
  readJSON: (k, d) => (k in stored ? JSON.parse(stored[k]) : d),
  fold: (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(),
  settings: {},
  coster: { summary: (id) => { const d = dishes.find((x) => x.id === id); return { perPortion: d.per, menuPrice: d.price, foodCost: d.price ? d.per / d.price : null }; } },
};
vm.createContext(ctx);
vm.runInContext([
  `const byName = (a, b) => a.name.localeCompare(b.name, "fr", { sensitivity: "base" });`,
  line("DISH_CATS"), line("dishCatList"), line("NO_CAT"), line("dishCat"), line("catRank"), line("catOrder"),
  line("DISH_SORT"), line("SORT_LABELS"), fn("dishSort"), fn("dishSorter"),
  "this.dishSort = dishSort; this.dishSorter = dishSorter; this.SORT_LABELS = SORT_LABELS;",
].join("\n"), ctx);
const names = (by, rev = false) => dishes.slice().sort(ctx.dishSorter({ by, rev })).map((d) => d.name);

test("names A to Z, and Z to A turned around", () => {
  assert.deepEqual(names("name"), ["Agnolotti", "Bavette", "Pain", "Soupe", "Tarte"]);
  assert.deepEqual(names("name", true), ["Tarte", "Soupe", "Pain", "Bavette", "Agnolotti"]);
});

test("categories in menu order, dishes without one last, then by name", () => {
  assert.deepEqual(names("category"), ["Soupe", "Agnolotti", "Bavette", "Tarte", "Pain"]);
});

test("costs and prices highest first, lowest first turned around", () => {
  assert.deepEqual(names("cost"), ["Bavette", "Agnolotti", "Tarte", "Soupe", "Pain"]);
  assert.deepEqual(names("cost", true), ["Pain", "Soupe", "Tarte", "Agnolotti", "Bavette"]);
});

test("a dish without a menu price (so no food cost) goes last either way", () => {
  assert.deepEqual(names("price"), ["Bavette", "Agnolotti", "Tarte", "Pain", "Soupe"]);
  assert.deepEqual(names("price", true), ["Pain", "Tarte", "Agnolotti", "Bavette", "Soupe"]);
  // Food costs: Agnolotti 30%, Bavette 30%, Tarte 20%, Pain 12.5%: a tie goes by name.
  assert.deepEqual(names("fc"), ["Agnolotti", "Bavette", "Tarte", "Pain", "Soupe"]);
  assert.deepEqual(names("fc", true), ["Pain", "Tarte", "Agnolotti", "Bavette", "Soupe"]);
});

test("remembered for each page; a choice that isn't offered there falls back", () => {
  const all = Object.keys(ctx.SORT_LABELS), noCat = all.filter((k) => k !== "category");
  assert.deepEqual({ ...ctx.dishSort("dishes", noCat) }, { by: "name", rev: false }, "the Dishes list starts by name");
  assert.deepEqual({ ...ctx.dishSort("menu", all) }, { by: "category", rev: false }, "a menu's page starts in menu order");
  stored["costing.dishSort"] = JSON.stringify({ dishes: { by: "fc", rev: true }, menu: { by: "category", rev: true } });
  assert.deepEqual({ ...ctx.dishSort("dishes", noCat) }, { by: "fc", rev: true });
  assert.deepEqual({ ...ctx.dishSort("menu", all) }, { by: "category", rev: true });
  stored["costing.dishSort"] = JSON.stringify({ dishes: { by: "category", rev: true } });
  assert.deepEqual({ ...ctx.dishSort("dishes", noCat) }, { by: "name", rev: false }, "grouped by category, Category isn't a choice");
  assert.deepEqual({ ...ctx.dishSort("dishes", all) }, { by: "category", rev: true }, "grouped by menu, it is");
});

test("where it shows: the Dishes list's sections, a menu's page (on screen only), for everyone", () => {
  assert.match(app, /sortControl\("dishes", sortChoices, sortNow\)/);
  assert.match(app, /byMenuName\(a\.group, b\.group\) \|\| within\(a\.r, b\.r\)/, "inside each menu");
  assert.match(app, /\(isDish \? catOrder\(a\.r, b\.r\) : 0\) \|\| within\(a\.r, b\.r\)/, "inside each category");
  assert.match(app, /sortControl\("menu", sortChoices, sortNow\)/);
  assert.match(app, /<tbody>\$\{sorted\.map\(\(x\) => `<tr>/, "the menu's table");
  assert.match(app, /const menuDishList = \(name\) => [^\n]+\.sort\(byCat\);/, "the menu's files keep menu order");
  assert.match(app, /const ALWAYS_OK = new Set\(\[[^\]]*"dish-sort", "dish-sort-dir"/, "employees can sort too");
});
