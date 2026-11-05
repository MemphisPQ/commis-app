/* The accessibility options: they're remembered, they reach the page, and every colour set is readable. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const css = fs.readFileSync(path.join(root, "public", "style.css"), "utf8");

/* ---------- reading the colour sets out of style.css ---------- */
// Every "selector { ... }" block whose selector starts with :root, and whether it sits under the dark-theme media rule.
function tokenBlocks() {
  const dark = [];
  const open = /@media \(prefers-color-scheme: dark\) \{/g;
  for (let m; (m = open.exec(css)); ) {
    let depth = 1, i = m.index + m[0].length;
    while (depth && i < css.length) { if (css[i] === "{") depth++; else if (css[i] === "}") depth--; i++; }
    dark.push([m.index, i]);
  }
  const blocks = [], re = /:root((?:\[[^\]]+\])*)\s*\{([^{}]*)\}/g;
  for (let m; (m = re.exec(css)); ) {
    const tokens = {};
    for (const t of m[2].matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)) tokens[t[1]] = t[2];
    blocks.push({ attrs: [...m[1].matchAll(/\[([\w-]+)/g)].map((a) => a[1]), dark: dark.some(([a, b]) => m.index > a && m.index < b), tokens });
  }
  return blocks;
}
function colours(theme, on) {
  const out = {};
  // Light first, dark on top of it, and fewer options first: the same order the browser's rules work in.
  const blocks = tokenBlocks().filter((b) => (theme === "dark" || !b.dark) && b.attrs.every((a) => on.includes(a)));
  blocks.sort((a, b) => a.dark - b.dark || a.attrs.length - b.attrs.length);
  for (const b of blocks) Object.assign(out, b.tokens);
  return out;
}
function contrast(a, b) {
  const lum = (hex) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
const PAIRS = [["ink", "bg"], ["ink", "panel"], ["ink", "panel-2"], ["ink", "field"], ["muted", "panel"], ["muted", "bg"], ["muted", "panel-2"], ["brand", "panel"], ["brand", "bg"],
  ["brand-ink", "brand"], ["brand", "brand-soft"], ["top-ink", "top"], ["top-muted", "top"], ["up", "up-bg"], ["down", "down-bg"], ["check", "check-bg"], ["up-ink", "up"], ["ink", "mark"]];

for (const theme of ["light", "dark"]) {
  for (const on of [[], ["data-colorblind"], ["data-lowvision"], ["data-colorblind", "data-lowvision"]]) {
    const name = `${theme}${on.length ? ", " + on.map((a) => a.replace("data-", "")).join(" + ") : ""}`;
    test(`every text colour is readable: ${name}`, () => {
      const c = colours(theme, on), need = on.includes("data-lowvision") ? 7 : 4.5;
      for (const [fg, bg] of PAIRS) {
        assert.ok(c[fg] && c[bg], `${fg} or ${bg} is missing`);
        const r = contrast(c[fg], c[bg]);
        assert.ok(r >= need, `${fg} ${c[fg]} on ${bg} ${c[bg]} is ${r.toFixed(2)}:1, needs ${need}:1`);
      }
    });
  }
}

test("colour-blind colours stay apart: costs up and down differ in blue against yellow, not just green against red", () => {
  // Blue channel: the difference red-green colour blindness doesn't touch.
  const blue = (hex) => parseInt(hex.slice(5, 7), 16), red = (hex) => parseInt(hex.slice(1, 3), 16);
  for (const theme of ["light", "dark"]) {
    const c = colours(theme, ["data-colorblind"]);
    assert.ok(blue(c.down) > red(c.down), `${theme}: "down" should read as blue, is ${c.down}`);
    assert.ok(blue(c.up) < red(c.up), `${theme}: "up" should read as orange, is ${c.up}`);
  }
  for (const on of ["colorblind", "lowvision"]) assert.ok(css.includes(`:root[data-${on}] .fc--over::before`), `food cost has a mark in ${on}`);
  assert.ok(/data-colorblind\] \.hchart__line--2 \{ stroke-dasharray/.test(css), "price lines have their own pattern");
});

/* ---------- the options themselves ---------- */
function page(saved) {
  const attrs = new Map(), store = new Map(saved ? [["costing.access", saved]] : []);
  const listeners = {};
  const root = {
    lang: "en",
    toggleAttribute(k, on) { if (on) attrs.set(k, ""); else attrs.delete(k); },
    setAttribute(k, v) { attrs.set(k, v); },
    removeAttribute(k) { attrs.delete(k); },
  };
  const dialog = {
    id: "access", className: "", innerHTML: "", opened: 0, listeners: {},
    setAttribute() {}, addEventListener(k, f) { this.listeners[k] = f; }, showModal() { this.opened++; }, querySelector: () => ({ value: "" }),
  };
  const document = {
    documentElement: root, readyState: "complete", body: { append() { document.madeDialog = true; } }, madeDialog: false,
    getElementById: () => (document.madeDialog ? dialog : null),
    createElement: () => dialog,
    querySelectorAll: () => [], querySelector: () => null,
    addEventListener(k, f) { listeners[k] = f; },
  };
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "public", "access.js"), "utf8"), { document, localStorage, setTimeout, JSON });
  const hit = (sel) => ({ target: { closest: (s) => (s === sel ? {} : null) } });
  return { attrs, store, dialog, click: (sel) => listeners.click(hit(sel)) };
}

test("nothing saved: the page looks as it always did", () => {
  const p = page();
  assert.deepEqual([...p.attrs.keys()], []);
});

test("saved options reach the page before anything is drawn", () => {
  const p = page(JSON.stringify({ colorblind: true, dyslexia: true, size: "xlarge" }));
  assert.ok(p.attrs.has("data-colorblind") && p.attrs.has("data-dyslexia"));
  assert.ok(!p.attrs.has("data-lowvision"));
  assert.equal(p.attrs.get("data-size"), "xlarge");
});

test("a damaged saved value is ignored, not a blank page", () => {
  assert.deepEqual([...page("{not json").attrs.keys()], []);
  assert.deepEqual([...page(JSON.stringify({ size: "enormous" })).attrs.keys()], []);
});

test("ticking an option changes the page straight away and is remembered; low vision starts at large text", () => {
  const p = page();
  p.click("[data-access-open]");
  assert.equal(p.dialog.opened, 1);
  const change = (pref, input) => p.dialog.listeners.change({ target: { dataset: { pref }, ...input } });
  change("colorblind", { checked: true });
  assert.ok(p.attrs.has("data-colorblind"));
  change("lowvision", { checked: true });
  assert.ok(p.attrs.has("data-lowvision"));
  assert.equal(p.attrs.get("data-size"), "large");
  change("size", { value: "" });
  assert.ok(!p.attrs.has("data-size"));
  change("colorblind", { checked: false });
  assert.ok(!p.attrs.has("data-colorblind"));
  const saved = JSON.parse(p.store.get("costing.access"));
  assert.equal(saved.lowvision, true);
  assert.equal(saved.colorblind, false);
});

test("the font comes with the site, licence included, and both sites use it", () => {
  for (const f of ["opendyslexic-latin-400-normal.woff2", "opendyslexic-latin-700-normal.woff2", "OFL.txt"]) assert.ok(fs.existsSync(path.join(root, "public", "fonts", f)), f);
  assert.ok(css.includes('url("fonts/opendyslexic-latin-400-normal.woff2")'));
  const index = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  assert.ok(index.indexOf("access.js") < index.indexOf("<body>"), "options are read before the page is drawn");
  for (const f of ["terms", "conditions", "privacy", "confidentialite"]) assert.ok(fs.readFileSync(path.join(root, "sites", "commis", "pages", f + ".html"), "utf8").includes("access.js"), f);
});
