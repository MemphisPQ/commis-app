/* A dish on several menus: kept in its one Menu box, one per line, so nothing changes in the database. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
// The two helpers on their own, run as written in app.js.
const grab = (name) => new RegExp(`const ${name} = [^\\n]+;`).exec(app)[0];
const ctx = {};
vm.createContext(ctx);
vm.runInContext(`${grab("menusOf")}\n${grab("menuText")}\nthis.menusOf = menusOf; this.menuText = menuText;`, ctx);
const plain = (x) => JSON.parse(JSON.stringify(x));

test("a dish's menus are its Menu box, one per line; one menu is saved as it always was", () => {
  assert.deepEqual(plain(ctx.menusOf({ menu: "Noel 2026" })), ["Noel 2026"]);
  assert.deepEqual(plain(ctx.menusOf({ menu: "Noel 2026\nBrunch" })), ["Noel 2026", "Brunch"]);
  assert.deepEqual(plain(ctx.menusOf({ menu: " Noel 2026 \n\nBrunch\nNoel 2026" })), ["Noel 2026", "Brunch"], "tidied, each once");
  assert.deepEqual(plain(ctx.menusOf({ menu: "" })), []);
  assert.deepEqual(plain(ctx.menusOf({})), []);
  assert.equal(ctx.menuText(["Noel 2026"]), "Noel 2026");
  assert.equal(ctx.menuText(["Noel 2026", " Brunch ", "", "Brunch"]), "Noel 2026\nBrunch");
});

test("every place a menu is read goes through the list", () => {
  assert.match(app, /const menuDishList = \(name\) => data\.recipes\.filter\(\(r\) => r\.kind === "dish" && menusOf\(r\)\.includes\(name\)\)/, "a menu's page and folder");
  assert.match(app, /\(tr\.dataset\.group \|\| ""\)\.split\("\\n"\)\.includes\(g\)/, "the Dishes list's menu filter");
  assert.match(app, /\$\("#dl-menus"\)\.innerHTML = uniq\(allMenus\(\)\)/, "the suggestions");
  assert.doesNotMatch(app, /\(r\.menu \|\| ""\)\.trim\(\) ===/, "nothing compares the whole box to one menu");
});

test("grouped by menu, a dish on two menus shows under both, with boxes of its own each time", () => {
  assert.match(app, /list\.flatMap\(\(r\) => \(menusOf\(r\)\.length \? menusOf\(r\) : \[NO_MENU\]\)\.map\(\(group\) => \(\{ r, group \}\)\)\)/);
  assert.match(app, /data-k="dmenu-\$\{esc\(r\.id\)\}\$\{again\}"/);
});

test("from the list, menus are typed with commas; a menu that has a comma in its name stays whole", () => {
  assert.match(app, /const typed = String\(el\.value \|\| ""\), whole = allMenus\(\)\.find\(\(m\) => fold\(m\) === fold\(typed\.trim\(\)\)\);/);
  assert.match(app, /menuText\(whole \? \[whole\] : typed\.split\(","\)\.map\(menuSpelling\)\)/);
});

test("an employee can put their own dish on menus and take it off", () => {
  assert.match(app, /const OWN_RECIPE = new Set\(\["recipe-field", "dish-cat", "dish-menu", "menu-add", "menu-remove",/);
});
