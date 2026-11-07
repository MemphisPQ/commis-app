const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "..", "public", "style.css"), "utf8");

test("a recipe's lines move by dragging their dots, or with the arrow keys on them", () => {
  assert.match(app, /data-drag-line="\$\{esc\(l\.id\)\}"/);
  assert.match(app, /data-line="\$\{esc\(l\.id\)\}"/);
  assert.doesNotMatch(app, /data-act="move-line"|"move-line"/, "no arrows left");
  assert.match(app, /aria-label="Move \$\{esc\(lineName\(l\)\)\}: drag it, or press the up and down arrow keys"/);
  for (const ev of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) assert.ok(app.includes(`main.addEventListener("${ev}"`), ev);
  assert.match(app, /e\.key === "ArrowUp" \? -1 : 1/);
  assert.match(css, /\.drag-handle \{[^}]*touch-action: none/, "a finger on the dots doesn't scroll the page");
});

test("a recipe's lines never scroll sideways: a card per line when the table wouldn't fit, and long buttons wrap", () => {
  assert.match(app, /window\.innerWidth <= 760 \|\| box\.scrollWidth > box\.clientWidth \+ 1/, "measured, not guessed");
  assert.match(app, /function afterRender\(\) \{\s+fitLines\(\);/, "after every redraw");
  assert.match(app, /attributeFilter: \["data-size", "data-dyslexia"\]/, "and when the text size changes");
  assert.match(app, /window\.addEventListener\("resize", \(\) => \{ cancelAnimationFrame\(fitting\)/, "and the window");
  assert.match(css, /\.lines--recipe\.lines--stack tbody tr:not\(\.addrow\) \{ display: grid/);
  assert.doesNotMatch(css, /@media \(max-width: 760px\) \{[^}]*\.lines--recipe thead/, "the cards follow the class, not only the phone width");
  assert.match(css, /\.alert \.btn, \.crumbs \.btn \{[^}]*white-space: normal/, "a Merge button with a long name wraps");
});

test("the price columns say Target, since each dish has its own multiplier", () => {
  assert.doesNotMatch(app, /×4 price/);
  assert.equal(app.split('<th class=num>Target</th>').length - 1, 1, "the Dishes list");
  assert.equal(app.split('<th class="num">Target</th>').length - 1, 1, "Price changes");
});

test("dishes have the same measures as preps, and the Type box still switches between them", () => {
  assert.match(app, /\n\s*\$\{measureBoxes\("recipe", r\.id, Costing\.recipeMeasures\(r\), \{ costPer: r\.yield_unit \}\)\}/, "on every recipe page");
  assert.doesNotMatch(app, /data-k="r-yield"/, "the measures replaced Makes");
  assert.match(app, /data-k="r-kind" data-act="recipe-field" data-field="kind"/);
  assert.match(app, /!isDish \|\| parseNum\(r\.locked_cost\) != null/, "a locked prep turned into a dish can still be unlocked");
});
