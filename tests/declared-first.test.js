/*
 * No name is used in a function before that same function declares it with const or let. Doing that throws
 * ("Cannot access 'say' before initialization") the moment the line runs: it once stopped every menu folder, to a
 * .zip and to Drive, because menuFiles set m.say = say a line above its own `const say`.
 *
 * A rough check by lines, not a parser: for each indented const/let, the lines above it at the same indentation, back
 * to the start of its block. Object keys ({ say: … }), property reads (x.say), strings and arrow parameters
 * ((say) => …) don't count.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const strip = (l) => l.replace(/\\./g, "").replace(/`[^`]*`|"[^"]*"|'[^']*'/g, '""').replace(/\/[^/\n]+\/[gimsuy]*/g, "/r/").replace(/\/\/.*$/, "");

function usedBeforeDeclared(source) {
  const L = source.split(/\r?\n/), ind = (l) => l.match(/^ */)[0].length, out = [];
  L.forEach((line, i) => {
    const m = /^(\s+)(?:const|let)\s+(.+?)\s*=(?!=)/.exec(line);
    if (!m || m[1].length < 4) return;
    const names = m[2].replace(/[{}[\]]/g, " ").split(/[\s,]+/).map((n) => n.split(":").pop().trim()).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
    const d = m[1].length;
    let j = i - 1;
    while (j >= 0 && (L[j].trim() === "" || ind(L[j]) >= d)) j--;
    for (const n of names) {
      const e = n.replace(/\$/g, "\\$");
      const use = new RegExp(`(^|[^.\\w$])${e}(?![\\w$]|\\s*:(?!:))`);
      const param = new RegExp(`\\(([^()]*[^.\\w$])?${e}([^\\w$][^()]*)?\\)\\s*=>|(^|[^.\\w$])${e}\\s*=>`);
      for (let k = j + 1; k < i; k++) {
        if (ind(L[k]) !== d) continue;
        const s = strip(L[k]);
        if (use.test(s) && !param.test(s)) out.push(`line ${k + 1} uses ${n}, declared on line ${i + 1}: ${L[k].trim().slice(0, 100)}`);
      }
    }
  });
  return out;
}

test("the check finds the menu folder's old mistake", () => {
  const old = [
    "  async function menuFiles(name, picks) {",
    "    const m = menuModel(name), files = [];",
    "    m.say = say; // the bar's words in Barback's files",
    "    const say = (t) => toast(t);",
    "    return files;",
    "  }",
  ].join("\n");
  assert.equal(usedBeforeDeclared(old).length, 1);
  assert.match(usedBeforeDeclared(old)[0], /uses say/);
});

test("and lets through what isn't that: arrow parameters, object keys, property reads", () => {
  const fine = [
    "  function f(m) {",
    "    const priced = m.dishes.filter((d) => d.foodCost != null);",
    "    const avg = priced.reduce((s, d) => s + d.foodCost, 0);",
    "    if (!m) return { lines: [], total: null };",
    "    m.total = 1;",
    "    const d = settings.drive, lines = [], total = 0;",
    "  }",
  ].join("\n");
  assert.deepEqual(usedBeforeDeclared(fine), []);
});

test("nothing in the app's scripts uses a name before declaring it", () => {
  const dir = path.join(__dirname, "..", "public");
  const found = fs.readdirSync(dir).filter((f) => f.endsWith(".js"))
    .flatMap((f) => usedBeforeDeclared(fs.readFileSync(path.join(dir, f), "utf8")).map((x) => `${f} ${x}`));
  assert.deepEqual(found, []);
});

test("the menu's folder: m.say is the bar's words, and how far it is has a name of its own", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const body = /async function menuFiles\(name, picks\) \{([\s\S]*?)\n {2}\}\n/.exec(app)[1];
  assert.match(app, /\n {2}const say = \(s\) => \(BAR \? Barback\.say\(s\) : s\);/, "the app-wide say");
  assert.match(body, /m\.say = say;/);
  assert.doesNotMatch(body, /(const|let)\s+say\b/, "no second say inside menuFiles");
  assert.doesNotMatch(body, /[^.\w]say\(/, "progress goes through tell");
  assert.match(body, /const tell = \(t\) => toast\(t\);/);
});
