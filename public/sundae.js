/* Recipes sent from Sundae Atelier (the ice cream calculator): reading the link, guessing your item for each
 * calculator ingredient, and turning its grams into a recipe line.
 *
 * The calculator's "Send to Kitchen Costing" opens #/import/<code>: base64url of the JSON
 *   { v: 1, id: "<saved recipe id>", name, recipe: "<base recipe>", temp: "-14°C", batch: <kg>,
 *     rows: [[name, grams], [name, grams, "the name it shows under"], ...] }
 * The calculator's names are its own English ones ("Full fat milk", "35% cream"); your items are named your way
 * ("Lait, 3.25%", "Creme 35"), so the guess is only a start: you check each line once and it's remembered.
 * Works in the browser (window.Sundae, after invoices.js) and in Node (require) for the tests.
 */
(function (root) {
  const Invoices = root.Invoices || (typeof require === "function" ? require("./invoices.js") : null);

  /** The link's code → the recipe, or an Error saying it isn't one. */
  function decode(code) {
    let recipe;
    try {
      const b64 = String(code || "").trim().replace(/-/g, "+").replace(/_/g, "/");
      const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
      recipe = JSON.parse(decodeURIComponent(bin.replace(/[\s\S]/g, (c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))));
    } catch {
      throw new Error("This link isn't a recipe from Sundae Atelier (it may have been cut short). Send it again from the calculator.");
    }
    const bad = (why) => { throw new Error(`This recipe from Sundae Atelier can't be read: ${why}. Send it again from the calculator.`); };
    if (!recipe || recipe.v !== 1) bad("it's from a newer or older calculator");
    const text = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
    const name = text(recipe.name, 200);
    if (!name) bad("it has no name");
    const batch = +recipe.batch;
    if (!(batch > 0 && batch <= 1000)) bad("the batch weight is missing");
    if (!Array.isArray(recipe.rows) || !recipe.rows.length || recipe.rows.length > 80) bad("it has no ingredients");
    // The same ingredient twice (a recipe's own and an added one) becomes one line.
    const rows = [];
    for (const r of recipe.rows) {
      const n = Array.isArray(r) ? text(r[0], 200) : "", g = Array.isArray(r) ? +r[1] : NaN;
      if (!n || !isFinite(g)) bad("an ingredient line is broken");
      const same = rows.find((x) => x.name === n);
      if (same) same.grams = Math.round((same.grams + g) * 10) / 10;
      else rows.push({ name: n, grams: g, label: text(r[2], 200) || n });
    }
    return { id: text(recipe.id, 100) || null, name, recipe: text(recipe.recipe, 200), temp: text(recipe.temp, 20), batch, rows };
  }

  /** The other way round (for the tests, and to check a link by hand). */
  function encode(recipe) {
    const bin = encodeURIComponent(JSON.stringify(recipe)).replace(/%([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  // The calculator's wording, said the way your items are named (French, the percentage as a number).
  const SAY = [
    [/^(full fat|whole) milk$/, "lait 3.25"], [/^semi-skimmed milk$/, "lait 2"], [/^skimmed milk$/, "lait skim"],
    [/^skimmed powdered milk$/, "poudre lait skim"], [/^(\d+)% cream$/, "creme $1"], [/^sugar$/, "sucre"],
    [/^dextrose$/, "sucre dextrose"], [/^inverted sugar$/, "sucre inverse"], [/^.*(atomized glucose|glucose (syrup|powder)).*$/, "sucre glucose"],
    [/^egg yolks?$/, "oeuf yolk"], [/^water$/, "eau"], [/^salt$/, "sel"], [/^(\d+)% coating$/, "chocolat $1"],
    [/^(\d+)% milk coating$/, "chocolat lait $1"], [/^white chocolate$/, "chocolat blanc"], [/^dry cocoa$/, "cacao"],
    [/^vanilla extract$/, "vanille essence"], [/^hazelnut paste$/, "pate noisette"], [/^maple syrup$/, "sirop erable"],
    [/^(\w+) juice$/, "jus $1"], [/^neutral ingredient for .*$/, "stabilisateur"], [/^natural full fat yogurt$/, "yogourt"],
  ];
  const STOP = new Set(["de", "du", "la", "le", "les", "et", "en", "au", "aux", "the", "and", "of", "for", "kg", "frz"]);
  // Words that make it another product: skim milk isn't skim milk powder, sugar isn't brown sugar or dextrose.
  const KIND = new Set(["poudre", "condensed", "sure", "soya", "cooking", "brun", "dextrose", "glucose", "inverse", "fume", "smoked"]);
  const say = (name) => { const f = Invoices.fold(name).trim(); for (const [re, to] of SAY) if (re.test(f)) return f.replace(re, to); return f; };
  /** The words of a name, the way invoices compare them (dairy, fruit… in one language), numbers kept ("35", "3.25"). */
  const seen = new Map(); // every item's name is compared with every calculator line, on every redraw
  function tokens(s) {
    if (seen.has(s)) return seen.get(s);
    const out = new Set();
    if (seen.size > 5000) seen.clear();
    seen.set(s, out);
    for (let w of Invoices.fold(s).replace(/(\d)\s*%/g, "$1").split(/[^a-z0-9.]+/)) {
      w = w.replace(/^\.+|\.+$/g, "");
      if (!w || STOP.has(w)) continue;
      if (/\d/.test(w)) { out.add(String(+w || w)); continue; }
      const canon = [...Invoices.words(w)][0];
      if (canon) out.add(canon);
    }
    return out;
  }
  const same = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5));
  /** How alike two names are, 0 to 1: the words they share over all their words. */
  function score(calcName, itemName) {
    const a = tokens(say(calcName)), b = tokens(itemName);
    if (!a.size || !b.size || [...KIND].some((k) => a.has(k) !== b.has(k))) return 0;
    let shared = 0;
    for (const w of a) if ([...b].some((x) => same(w, x))) shared++;
    return shared / (a.size + b.size - shared);
  }

  /** Your item for a calculator ingredient: { kind: "ingredient" | "prep", id, score } or null when no item is a
   * clear best (at least half its words shared, and better than every other; an ingredient wins a tie with a prep,
   * so blueberries aren't Blueberry Filling). */
  function match(calcName, data) {
    const cands = data.ingredients.map((i) => ({ kind: "ingredient", id: i.id, score: score(calcName, i.name) }))
      .concat(data.recipes.filter((r) => r.kind === "prep").map((r) => ({ kind: "prep", id: r.id, score: score(calcName, r.name) })))
      .filter((c) => c.score >= 0.5).sort((x, y) => y.score - x.score || (x.kind === "prep") - (y.kind === "prep"));
    const [best, next] = cands;
    return best && !(next && next.score === best.score && next.kind === best.kind) ? best : null;
  }

  // Grams per ml, for items priced per litre (the calculator works in grams).
  const DENSITY = [[/honey/, 1.42], [/glucose syrup/, 1.43], [/maple syrup|syrup/, 1.32], [/milk|yogurt/, 1.03], [/cream/, 1.0],
    [/juice/, 1.04], [/oil/, 0.92], [/\b(4\d|3\d)% alc/, 0.95], [/% alc/, 0.98]];
  const density = (calcName) => { const f = Invoices.fold(calcName); const hit = DENSITY.find(([re]) => re.test(f)); return hit ? hit[1] : 1; };

  /** The recipe line for `grams` of a calculator ingredient made with your item: { qty, unit, density? }.
   * By weight (g) unless the item is priced per litre: then in ml, through the ingredient's density. */
  function lineFor(grams, calcName, item) {
    const g = Math.round(grams * 10) / 10;
    const base = item && (item.base || item.yield_unit);
    if (base === "L" || base === "ml") { const d = density(calcName); return { qty: Math.round((g / d) * 10) / 10, unit: "ml", density: d }; }
    return { qty: g, unit: "g" };
  }

  const api = { decode, encode, match, score, tokens, say, density, lineFor };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Sundae = api;
})(typeof window !== "undefined" ? window : globalThis);
