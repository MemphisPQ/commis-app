/* Barback: a bar's own records in the same account, in blue. It runs on the same screens as the kitchen (app.js), with its
 * own rows (schema part 19). What's particular to a bar is here, apart from the screens, so it can be tested: bottles,
 * counting full bottles and weighing opened ones, and the bar's wording.
 * Works in the browser (window.Barback) and in Node (require) for the tests.
 */
(function (root) {
  const Units = typeof module !== "undefined" && module.exports ? require("./units.js") : root.Units;

  const MULTIPLIER = 5; // a 20% pour cost: the usual aim for a bar, as ×4 is for a kitchen
  const RECIPE_UNITS = ["floz", "ml", "dash", "barspoon", "L", "bottle", "g", "kg", "unit", "portion", "recipe"];
  // What a price's pack can be. A fluid ounce comes first among the small ones; a weight's ounce stays for an invoice that says so.
  const PACK_UNITS = ["ml", "L", "floz", "bottle", "unit", "dozen", "kg", "g", "lb", "oz", "portion", "recipe", "bunch"];
  const BOTTLE_SIZES = [375, 750, 1000, 1140, 1750]; // ml
  const SECTIONS = ["Gin", "Vodka", "Rum", "Tequila & mezcal", "Whisky", "Brandy & cognac", "Liqueurs", "Amari & bitters", "Vermouth & aperitifs", "Wine", "Beer & cider", "Mixers", "Garnish"];
  const CATEGORIES = ["Classics", "House", "Zero-proof"];
  const PREP_SECTION = "Bar preps";

  /** A bar's starting sections. Everything in them counts toward the pour cost, which the summary keeps under its "food" group. */
  function firstSettings() {
    const names = [...SECTIONS, PREP_SECTION];
    return { categories: { ingredients: [...SECTIONS], dishes: [...CATEGORIES], prepSection: PREP_SECTION, groups: Object.fromEntries(names.map((s) => [s, "food"])) } };
  }

  /* ---------- bottles ---------- */
  /** One bottle of an item, in ml, from its measures. null when it has no size. */
  function bottleMl(item) {
    const list = item && Array.isArray(item.measures) ? item.measures : [];
    const one = list.find((m) => m && !m.per && m.unit === "bottle"), vol = list.find((m) => m && !m.per && Units.baseOf(m.unit) === "L");
    if (!one || !vol || !(+one.qty > 0) || !(+vol.qty > 0)) return null;
    return +(Units.convert(+vol.qty, vol.unit, "ml") / +one.qty).toFixed(3);
  }

  /** An item's measures with this bottle size. No size takes it off; anything else on the list stays. */
  function withBottleSize(item, ml) {
    const rest = (item && Array.isArray(item.measures) ? item.measures : []).filter((m) => m && (m.per || (m.unit !== "bottle" && Units.baseOf(m.unit) !== "L")));
    if (!(ml > 0)) return rest.length ? rest : null;
    return [{ qty: +(ml / 1000).toFixed(6), unit: "L" }, { qty: 1, unit: "bottle" }, ...rest];
  }

  /** A pack the size of one bottle gives the item its size. A case or a keg doesn't. */
  function sizeFromPack(qty, unit) {
    const ml = Units.convert(+qty, unit, "ml");
    return ml >= 50 && ml <= 3000 ? +ml.toFixed(3) : null;
  }

  /** What a bottle and an ounce cost, from the price per litre. */
  function pours(perLitre, ml) {
    return { bottle: ml > 0 ? (perLitre * ml) / 1000 : null, oz: perLitre * Units.convert(1, "floz", "L") };
  }

  /* ---------- the count: full bottles counted, opened ones weighed ---------- */
  /** Both weights are there and make sense, so its opened bottles can go on the scale. */
  const canWeigh = (item) => +(item && item.empty_g) > 0 && +(item && item.full_g) > +(item && item.empty_g);

  // A pourer or a different cap moves the number a little, so a little over or under still reads as full or empty.
  const LEEWAY = 0.05;

  /** How much is left in what's on the scale: "840", or "840+700" for two opened bottles. Gives { bottles }, or { problem } to show. */
  function openBottles(text, emptyG, fullG) {
    const typed = String(text == null ? "" : text).trim();
    if (!typed) return { bottles: 0 };
    const empty = +emptyG, full = +fullG;
    if (!(empty > 0) || !(full > empty)) return { problem: "This bottle needs its empty and full weights before it can be weighed." };
    const parts = typed.split("+").map((s) => { const v = s.trim().replace(",", "."); return v !== "" && isFinite(+v) ? +v : NaN; });
    if (parts.some((n) => !(n >= 0))) return { problem: "Type what the scale shows, in grams. Two opened bottles: 840+700." };
    let bottles = 0;
    for (const g of parts) {
      if (g > full * (1 + LEEWAY)) return { problem: `${g} g is heavier than a full bottle (${full} g). Check the number, or the bottle's weights.` };
      if (g < empty * (1 - LEEWAY)) return { problem: `${g} g is lighter than an empty bottle (${empty} g). Check the number, or the bottle's weights.` };
      bottles += Math.min(1, Math.max(0, (g - empty) / (full - empty)));
    }
    return { bottles: +bottles.toFixed(3) };
  }

  /** Full bottles counted, plus opened ones weighed: the amount in stock, in bottles. Gives { qty, opened }, or { problem }. */
  function hybridCount(full, openText, emptyG, fullG) {
    const open = openBottles(openText, emptyG, fullG);
    if (open.problem) return open;
    return { qty: +((+full || 0) + open.bottles).toFixed(3), opened: open.bottles };
  }

  /* ---------- wording ---------- */
  // The screens are written for a kitchen. In Barback the same text goes through this list, in order, whole words only.
  const WORDS = [
    [/×4 by default, a 25% food cost/g, `×${MULTIPLIER} by default, a ${100 / MULTIPLIER}% pour cost`],
    [/\bDishes\b/g, "Cocktails"], [/\bdishes\b/g, "cocktails"], [/\bDish\b/g, "Cocktail"], [/\bdish\b/g, "cocktail"],
    [/\bFood cost\b/g, "Pour cost"], [/\bfood cost\b/g, "pour cost"],
    [/\bFood\b/g, "Liquor"], [/\bfood\b/g, "liquor"],
    [/\bPortions\b/g, "Drinks"], [/\bportions\b/g, "drinks"], [/\bPortion\b/g, "Drink"], [/\bportion\b/g, "drink"],
    [/\bInventory\b/g, "Count"], [/\binventory\b/g, "count"],
    [/\bNew ingredient\b/g, "New bottle"], [/\bnew ingredient\b/g, "new bottle"], [/\bDelete ingredient\b/g, "Delete bottle"], [/\bNo ingredients\b/g, "No bottles"],
    [/\bIngredients\b/g, "Bottles"], [/\bIngredient\b/g, "Bottle"],
  ];
  function say(text) {
    let out = String(text == null ? "" : text);
    for (const [from, to] of WORDS) out = out.replace(from, to);
    return out;
  }

  const api = { MULTIPLIER, RECIPE_UNITS, PACK_UNITS, BOTTLE_SIZES, SECTIONS, CATEGORIES, PREP_SECTION, firstSettings, bottleMl, withBottleSize, sizeFromPack, pours, canWeigh, openBottles, hybridCount, say };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Barback = api;
})(typeof window !== "undefined" ? window : globalThis);
