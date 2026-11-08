/* Units. Every price is stored per kg, per L, per unit, per portion, per recipe or per bunch ("base" units).
 * Anything typed in g, lb, oz or ml is converted on the way in, so pounds never reach a recipe.
 * A portion, a recipe (one batch) or a bunch counts as one unit, so each turns into units 1 for 1 (amountIn); they
 * never turn into each other.
 * Works in the browser (window.Units) and in Node (require) for the tests and the import script.
 */
(function (root) {
  const UNITS = {
    kg: { base: "kg", f: 1, label: "kg" },
    g: { base: "kg", f: 0.001, label: "g" },
    lb: { base: "kg", f: 0.45359237, label: "lb" },
    oz: { base: "kg", f: 0.028349523125, label: "oz" },
    L: { base: "L", f: 1, label: "L" },
    ml: { base: "L", f: 0.001, label: "ml" },
    unit: { base: "unit", f: 1, label: "unit" },
    dozen: { base: "unit", f: 12, label: "dozen" },
    portion: { base: "portion", f: 1, label: "portion" },
    recipe: { base: "recipe", f: 1, label: "recipe" },
    bunch: { base: "bunch", f: 1, label: "bunch" },
    // Behind a bar (Barback). An ounce there is a fluid one, so it has its own key; a dash and a barspoon are the usual
    // rounded amounts. A bottle's size is the item's own, in its measures. The kitchen's lists never offer these.
    floz: { base: "L", f: 0.0295735, label: "oz", bar: true },
    dash: { base: "L", f: 0.00092, label: "dash", bar: true },
    barspoon: { base: "L", f: 0.005, label: "barspoon", bar: true },
    bottle: { base: "bottle", f: 1, label: "bottle", bar: true },
  };
  const BASES = ["kg", "L", "unit", "portion", "recipe", "bunch"];

  // Every spelling found in the Master Data sheet, and a few more.
  const ALIASES = {
    kg: ["kg", "kgs", "kilo", "kilos", "kl"],
    g: ["g", "gr", "grs", "gram", "grams", "gramme", "grammes"],
    lb: ["lb", "lbs", "livre", "livres"],
    oz: ["oz"],
    L: ["l", "lt", "litre", "litres", "liter", "liters"],
    ml: ["ml"],
    dozen: ["dz", "douzaine", "dozen"],
    unit: ["unit", "units", "unite", "unites", "unité", "unités", "un", "u", "ea", "each", "p", "pc", "pcs",
      "piece", "pieces", "morceau", "pqt", "paquet", "pt", "pts",
      "pint", "cs", "case", "caisse", "pot", "sac", "bag", "box"],
    portion: ["portion", "portions"],
    recipe: ["recipe", "recipes", "recette", "recettes", "batch", "batches"],
    bunch: ["b", "bunch", "bunches", "botte", "bottes"],
  };
  // Container words: counted as "unit", but the import flags them because the size is unknown.
  const VAGUE = new Set(["pqt", "paquet", "pt", "pts", "pint", "cs",
    "case", "caisse", "pot", "sac", "bag", "box", "p"]);

  const LOOKUP = {};
  for (const [key, list] of Object.entries(ALIASES)) for (const a of list) LOOKUP[a] = key;

  const clean = (s) => String(s == null ? "" : s).trim().toLowerCase().replace(/\.+$/, "").replace(/\s+/g, " ");

  /** "Kg" -> "kg", "un." -> "unit", "Lbs" -> "lb". Returns null when it isn't a plain unit word. */
  function parseUnit(s) {
    const c = clean(s);
    return c in LOOKUP ? LOOKUP[c] : null;
  }

  function isVague(s) {
    return VAGUE.has(clean(s));
  }

  /** Reads a size hidden inside text, like "284g", "2.3kg", "57 ml", "3,78L/Un", "pt/60g", "OIGNON 50LB". */
  function parseSize(s) {
    const m = String(s == null ? "" : s).match(/(\d+(?:[.,]\d+)?)\s*(kg|kgs|g|gr|lbs?|oz|ml|l)(?![a-z])/i);
    if (!m) return null;
    const unit = parseUnit(m[2]);
    if (!unit) return null;
    const qty = parseFloat(m[1].replace(",", "."));
    return { qty: qty * UNITS[unit].f, base: UNITS[unit].base, unit, raw: m[0] };
  }

  const baseOf = (unit) => (UNITS[unit] ? UNITS[unit].base : null);

  /** Converts a quantity between units with the same base (g -> kg, lb -> kg, ml -> L). null if they don't match. */
  function convert(qty, from, to) {
    const a = UNITS[from], b = UNITS[to];
    if (!a || !b || a.base !== b.base) return null;
    return (qty * a.f) / b.f;
  }

  /** Units offered in a recipe line for an ingredient stored in `base`. */
  function choicesFor(base) {
    return Object.keys(UNITS).filter((u) => UNITS[u].base === base && !UNITS[u].bar);
  }

  // Counted one piece at a time.
  const countable = (base) => base === "unit" || base === "portion" || base === "recipe" || base === "bunch";
  // Pieces that turn into each other 1 for 1: a unit and a portion, a recipe or a bunch.
  const samePieces = (a, b) => countable(a) && countable(b) && (a === "unit" || b === "unit");

  /** Turns `qty fromUnit` into `base`: same kind of unit, a portion or a recipe as one unit, or by the weight of
   * one piece when given (3 celeriac -> kg). null when it can't. */
  function amountIn(qty, fromUnit, base, eachKg) {
    const direct = convert(qty, fromUnit, base);
    if (direct != null) return direct;
    const from = baseOf(fromUnit);
    const pieces = countable(from) ? qty * UNITS[fromUnit].f : null;
    if (pieces != null && samePieces(from, base)) return pieces;
    if (eachKg > 0) {
      if (pieces != null && base === "kg") return pieces * eachKg;
      if (from === "kg" && countable(base)) return convert(qty, fromUnit, "kg") / eachKg;
    }
    return null;
  }

  const api = { UNITS, BASES, parseUnit, parseSize, isVague, baseOf, convert, choicesFor, countable, samePieces, amountIn };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Units = api;
})(typeof window !== "undefined" ? window : globalThis);
