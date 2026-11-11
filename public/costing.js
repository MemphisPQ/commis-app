/* Costing maths, kept apart from the screens so it can be tested.
 *
 * ingredient  { id, name, category, base: "kg"|"L"|"unit"|"portion", yield (0-1), each_kg, preferred_offer_id, locked_price, measures, container_kg, count_unit }
 * offer       { id, ingredient_id, supplier, supplier_item, pack_cost, pack_qty, pack_unit }
 * recipe      { id, name, kind: "dish"|"prep", yield_qty, yield_unit: "portion"|"kg"|"L"|"unit"|..., alt_qty, alt_unit, measures, menu_price, multiplier, ack_cost }
 * line        { id, recipe_id, pos, ingredient_id | sub_recipe_id, qty, unit, offer_id }
 *
 * Price of an offer = pack cost / (pack size in the ingredient's base unit x yield).
 * A recipe line with no offer_id uses the ingredient's preferred offer, or the cheapest one.
 *
 * Measures: an item or a prep can say what ONE RECIPE (one batch) comes to, in as many ways as it likes:
 * 1 recipe = 12 kg = 66 portions. Anything measured in one of them turns into any other through the recipe.
 * A prep's are what it makes (yield), its other measure (alt) and any more in `measures`; an item's are in `measures`,
 * and an item made from a prep also has that prep's. `measures` = [{ qty, unit }]; empty on everything saved before them.
 */
(function (root) {
  const Units = typeof module !== "undefined" && module.exports ? require("./units.js") : root.Units;

  const DEFAULT_MULTIPLIER = 4;
  const num = (v) => (v === "" || v == null || !isFinite(+v) ? null : +v);

  /** Turns `qty fromUnit` into the ingredient's base unit, using the weight of one unit when needed (3 celeriac -> kg). */
  const amountIn = Units.amountIn;

  /** The measures saved in `measures`: what one recipe comes to. (An item's own sizes are kept there too, with `per`: see below.) */
  const savedMeasures = (x) => (x && Array.isArray(x.measures) ? x.measures : []).filter((m) => !(m && m.per))
    .map((m) => ({ qty: num(m && m.qty), unit: m && m.unit })).filter((m) => m.qty > 0 && m.unit && m.unit !== "recipe");

  /* ---------- an item's own sizes ---------- */
  // How it comes, boxes inside boxes, with names the supplier or the kitchen uses: 1 case = 24 pack, 1 pack = 454 g, 1 pack = 15 sheet.
  // Saved in the item's measures as { per: "case", qty: 24, unit: "pack" }. A price, a recipe line and the count can use any of them.
  const savedSizes = (x) => (x && Array.isArray(x.measures) ? x.measures : []).filter((m) => m && typeof m.per === "string" && m.per.trim())
    .map((m) => ({ per: m.per.trim(), qty: num(m.qty), unit: m.unit })).filter((m) => m.qty > 0 && m.unit);
  /** One of an item's sizes in a unit everyone knows, following the sizes as far as they go: "case" -> 10896 g. null when it doesn't get there. */
  function sizeIn(x, name) {
    if (!name || Units.UNITS[name]) return null;
    const ways = new Map(), add = (a, f, b) => { if (!ways.has(a)) ways.set(a, []); ways.get(a).push([f, b]); };
    for (const r of savedSizes(x)) { add(r.per, r.qty, r.unit); add(r.unit, 1 / r.qty, r.per); }
    const seen = new Set([name]);
    for (let now = [[name, 1]]; now.length;) {
      const next = [];
      for (const [u, f] of now) {
        if (Units.UNITS[u]) return { qty: f, unit: u };
        for (const [g, v] of ways.get(u) || []) if (!seen.has(v)) { seen.add(v); next.push([v, f * g]); }
      }
      now = next;
    }
    return null;
  }
  /** The names of an item's sizes that lead somewhere, in the order they were written. */
  const sizeNames = (x) => [...new Set(savedSizes(x).flatMap((r) => [r.per, r.unit]))].filter((n) => !Units.UNITS[n] && sizeIn(x, n));

  /** Everything one batch of a prep comes to: what it makes, its other measure, any more. Never "recipe": that's the batch itself. */
  function recipeMeasures(r) {
    const out = [];
    const add = (qty, unit) => { if (qty > 0 && unit && unit !== "recipe" && !out.some((m) => m.unit === unit)) out.push({ qty, unit }); };
    add(num(r.yield_qty) || 1, r.yield_unit);
    add(num(r.alt_qty), r.alt_unit);
    for (const m of savedMeasures(r)) add(m.qty, m.unit);
    return out;
  }

  /** `qty unit` as an amount of `to`, through what one recipe comes to. null when the list doesn't have both sides. */
  function throughRecipe(qty, unit, to, list) {
    const fit = (u) => list.find((m) => Units.convert(1, u, m.unit) != null);
    const from = unit === "recipe" ? null : fit(unit), into = to === "recipe" ? null : fit(to);
    const share = unit === "recipe" ? qty : from ? Units.convert(qty, unit, from.unit) / from.qty : null;
    const whole = to === "recipe" ? 1 : into ? Units.convert(into.qty, into.unit, to) : null;
    return share == null || whole == null ? null : share * whole;
  }

  /** "1 portion = 182 g": with a weight known it gives the portions, with the portions it gives the weight, with
   * neither it's the one fact there is. `size` is in kg or L (`big`). Returns a new list. */
  function withPortionSize(list, size, big = "kg") {
    const out = list.map((m) => ({ ...m }));
    const w = out.find((m) => { const b = Units.baseOf(m.unit); return b === "kg" || b === "L"; }), n = out.find((m) => m.unit === "portion");
    if (w) {
      const portions = +(Units.convert(w.qty, w.unit, Units.baseOf(w.unit)) / size).toPrecision(6);
      if (n) n.qty = portions; else out.push({ qty: portions, unit: "portion" });
    } else if (n) out.push({ qty: +(n.qty * size).toPrecision(6), unit: big });
    else out.push({ qty: size, unit: big }, { qty: 1, unit: "portion" });
    return out;
  }

  /**
   * One supplier price's history, one row per day, oldest first: the last row of each day. Changing a price takes more than one
   * save (the cost, then the pack size, maybe a typo on the way), and only where it ended up was ever the price.
   * Saved order comes from created_at; rows without one (this browser's own data) keep the order they were saved in.
   */
  function lastOfEachDay(rows) {
    const days = new Map();
    rows.map((h, k) => ({ h, k }))
      .sort((a, b) => String(a.h.date || "").localeCompare(String(b.h.date || "")) || String(a.h.created_at || "").localeCompare(String(b.h.created_at || "")) || a.k - b.k)
      .forEach(({ h }) => days.set(h.date, h));
    return [...days.values()];
  }

  /** What's left once the containers come off the scale's number. null when it's lighter than they are. */
  function netWeight(typed, containers, tare) {
    const net = +(typed - containers * tare).toFixed(6);
    return net < 0 ? null : net;
  }

  function create(data) {
    const ingredients = new Map(data.ingredients.map((i) => [i.id, i]));
    const recipes = new Map(data.recipes.map((r) => [r.id, r]));
    const offersByIng = new Map();
    for (const o of data.offers) {
      if (!offersByIng.has(o.ingredient_id)) offersByIng.set(o.ingredient_id, []);
      offersByIng.get(o.ingredient_id).push(o);
    }
    const linesByRecipe = new Map();
    for (const l of data.lines) {
      if (!linesByRecipe.has(l.recipe_id)) linesByRecipe.set(l.recipe_id, []);
      linesByRecipe.get(l.recipe_id).push(l);
    }
    for (const list of linesByRecipe.values()) list.sort((a, b) => (a.pos || 0) - (b.pos || 0));

    /** A pack size in an item's base unit: the same kind of unit, its own measures, the weight of one piece, or one of its own sizes. */
    function packAmount(qty, unit, ing) {
      const size = sizeIn(ing, unit);
      if (size) return packAmount(qty * size.qty, size.unit, ing);
      const own = Units.convert(qty, unit, ing.base) ?? throughRecipe(qty, unit, ing.base, savedMeasures(ing));
      return own ?? amountIn(qty, unit, ing.base, num(ing.each_kg));
    }

    /** Price per base unit for one supplier's offer, or null if it can't be worked out. */
    function offerPrice(offer, ing) {
      const cost = num(offer.pack_cost), qty = num(offer.pack_qty);
      if (cost == null || !qty) return null;
      const inBase = packAmount(qty, offer.pack_unit || ing.base, ing);
      if (!inBase) return null;
      const y = num(ing.yield) || 1;
      return cost / (inBase * y);
    }

    function offersFor(ingId) {
      const ing = ingredients.get(ingId);
      return (offersByIng.get(ingId) || []).map((o) => ({ offer: o, price: ing ? offerPrice(o, ing) : null }));
    }

    /** A prepped item made from a prep: one batch costs what the prep costs today. The batch size is the
     * preferred price's pack size (Master Data's volume), or else what the prep makes. */
    const linking = new Set();
    function batchSize(ing, prep) {
      const packs = offersByIng.get(ing.id) || [];
      const size = packs.find((o) => o.id === ing.preferred_offer_id) || packs[0];
      const inBase = size && num(size.pack_qty) ? packAmount(num(size.pack_qty), size.pack_unit || ing.base, ing) : null;
      return inBase || batchIn(prep, ing.base);
    }
    function linkedOffer(ing) {
      const prep = ing && ing.prep_id && recipes.get(ing.prep_id);
      if (!prep || linking.has(ing.id)) return null;
      linking.add(ing.id);
      try {
        const total = recipeCost(prep.id).total;
        // Batch size: the item's own pack size (how Master Data and the inventory count it), else the prep's
        // measure in this item's unit (what it makes, or its true weight).
        const size = (offersByIng.get(ing.id) || []).find((o) => o.id === ing.preferred_offer_id) || (offersByIng.get(ing.id) || [])[0];
        const own = size ? null : batchIn(prep, ing.base);
        if (own == null && !size) return null;
        const offer = { id: "prep:" + prep.id, ingredient_id: ing.id, supplier: "Made in-house", supplier_item: prep.name, pack_cost: total,
          pack_qty: size ? size.pack_qty : own, pack_unit: size ? size.pack_unit : ing.base, prep: true };
        const price = offerPrice(offer, ing);
        return price == null ? null : { offer, price };
      } finally { linking.delete(ing.id); }
    }

    /** A locked price: the price you locked stays, whatever ingredient prices do. It keeps the live price's pack size
     * and supplier, with the pack cost that gives the locked price, so sheets show the same pack. */
    function lockedOffer(ing, live) {
      const p = ing && num(ing.locked_price);
      if (p == null) return null;
      const base = live && live.offer;
      let qty = base ? num(base.pack_qty) : null, unit = base ? base.pack_unit || ing.base : ing.base;
      let inBase = qty ? packAmount(qty, unit, ing) : null;
      if (!inBase) { qty = 1; unit = ing.base; inBase = 1; }
      const offer = { id: "lock:" + ing.id, ingredient_id: ing.id, supplier: base ? base.supplier : "", supplier_item: base ? base.supplier_item : "",
        pack_cost: p * inBase * (num(ing.yield) || 1), pack_qty: qty, pack_unit: unit, locked: true, locked_at: ing.locked_at || null };
      return { offer, price: p, live: live ? live.price : null };
    }

    /** The offer a recipe uses by default: a locked price, else the prep it's made from, else the preferred one,
     * else the cheapest with a price. */
    function defaultOffer(ingId) {
      const ing = ingredients.get(ingId), live = liveOffer(ingId);
      return lockedOffer(ing, live) || live;
    }
    /** Same, leaving any lock aside: what the item costs today. */
    function liveOffer(ingId) {
      const ing = ingredients.get(ingId);
      const linked = linkedOffer(ing);
      if (linked) return linked;
      const list = offersFor(ingId);
      const pref = ing && list.find((x) => x.offer.id === ing.preferred_offer_id && x.price != null);
      if (pref) return pref;
      const priced = list.filter((x) => x.price != null).sort((a, b) => a.price - b.price);
      return priced[0] || null;
    }

    function chosenOffer(ingId, offerId) {
      if (offerId) {
        const hit = offersFor(ingId).find((x) => x.offer.id === offerId);
        if (hit && hit.price != null) return hit;
      }
      return defaultOffer(ingId);
    }

    const memo = new Map();

    /** Full cost of one batch of a recipe, line by line. */
    function recipeCost(recipeId, stack = []) {
      if (memo.has(recipeId)) return memo.get(recipeId);
      const rec = recipes.get(recipeId);
      if (!rec) return { total: 0, perYield: 0, lines: [], problems: ["Recipe not found"] };
      if (stack.includes(recipeId)) return { total: 0, perYield: 0, lines: [], problems: ["Uses itself"], loop: true };
      const next = stack.concat(recipeId);
      const out = { total: 0, lines: [], problems: [] };

      for (const line of linesByRecipe.get(recipeId) || []) {
        const qty = num(line.qty);
        const row = { line, cost: 0, unitPrice: null, priceUnit: null, offer: null, problem: null };
        if (line.ingredient_id) {
          const ing = ingredients.get(line.ingredient_id);
          const pick = ing && chosenOffer(ing.id, line.offer_id);
          if (!ing) row.problem = "Ingredient was deleted";
          else if (!pick) row.problem = "No price yet";
          else {
            row.offer = pick.offer;
            row.unitPrice = pick.price;
            row.priceUnit = ing.base;
            // A yield of its own on this line (the item trimmed differently here): the price per usable unit follows it.
            const ly = num(line.yield);
            if (ly > 0 && ly <= 1) { row.unitPrice = pick.price * (num(ing.yield) || 1) / ly; row.lineYield = ly; }
            const amount = qty == null ? null : itemAmount(ing, qty, line.unit || ing.base);
            if (qty == null) row.problem = "No quantity";
            else if (amount == null) row.problem = `Can't turn ${line.unit} into ${ing.base}` + (Units.countable(ing.base) || Units.countable(Units.baseOf(line.unit)) ? ` (add a weight per ${Units.countable(ing.base) ? ing.base : Units.baseOf(line.unit)})` : "");
            else row.cost = amount * row.unitPrice;
          }
        } else if (line.sub_recipe_id) {
          const sub = recipes.get(line.sub_recipe_id);
          const subCost = sub && recipeCost(sub.id, next);
          if (!sub) row.problem = "Prep was deleted";
          else if (subCost.loop) row.problem = "This prep uses itself";
          else {
            row.unitPrice = subCost.perYield;
            row.priceUnit = sub.yield_unit;
            const amount = qty == null ? 1 : subAmount(qty, line.unit || sub.yield_unit, sub);
            if (amount == null) row.problem = `Can't turn ${line.unit} into ${sub.yield_unit}`;
            else row.cost = amount * subCost.perYield;
            if (subCost.problems.length && !subCost.locked) row.problem = row.problem || "Prep has missing prices";
          }
        } else row.problem = "Empty line";
        if (row.problem) out.problems.push(row.problem);
        out.total += row.cost;
        out.lines.push(row);
      }
      const y = num(rec.yield_qty) || 1;
      out.perYield = out.total / y;
      // A locked prep costs what you locked it at, whatever its ingredients cost today (kept in out.live).
      const lock = num(rec.locked_cost);
      if (lock != null) {
        out.live = { total: out.total, perYield: out.perYield };
        out.total = lock * y;
        out.perYield = lock;
        out.locked = true;
      }
      memo.set(recipeId, out);
      return out;
    }

    // How many of the prep's yield units a line uses (2 portions, or 0.3 kg of a prep made by the kg).
    // A prep's batch can be described two ways: what it makes (yield, e.g. 15 portions) and its other measure
    // (alt, e.g. it weighs 1.2 kg). A line can use either; the other one converts through the batch.
    // A line can also use it by the recipe: 1 recipe is the whole batch.
    function subAmount(qty, unit, sub) {
      const direct = sameMeasure(qty, unit, sub.yield_unit);
      if (direct != null) return direct;
      const altQty = num(sub.alt_qty), yieldQty = num(sub.yield_qty) || 1;
      if (unit === "recipe") return qty * yieldQty;
      const viaAlt = altQty ? sameMeasure(qty, unit, sub.alt_unit) : null;
      if (viaAlt != null) return (viaAlt / altQty) * yieldQty;
      for (const m of savedMeasures(sub)) {
        const v = sameMeasure(qty, unit, m.unit);
        if (v != null) return (v / m.qty) * yieldQty;
      }
      return null;
    }
    /** How much of an item's base unit `qty unit` is. In order: the same kind of unit; the item's own measures; the
     * weight of one piece; the measures of the prep it's made from, where one recipe is the batch its price is for; a
     * recipe, a portion or a bunch as one unit. null when it can't be worked out. */
    function itemAmount(ing, qty, unit) {
      const size = sizeIn(ing, unit);
      if (size) return itemAmount(ing, qty * size.qty, size.unit);
      const base = ing.base, each = num(ing.each_kg), own = savedMeasures(ing);
      const direct = Units.convert(qty, unit, base);
      if (direct != null) return direct;
      const mine = throughRecipe(qty, unit, base, own);
      if (mine != null) return mine;
      const from = Units.baseOf(unit);
      const byPiece = each > 0 && ((from === "kg" && Units.countable(base)) || (Units.countable(from) && base === "kg"));
      if (byPiece) return amountIn(qty, unit, base, each);
      const prep = ing.prep_id && recipes.get(ing.prep_id);
      if (prep) {
        const size = batchSize(ing, prep);
        const viaPrep = size ? throughRecipe(qty, unit, base, [{ qty: size, unit: base }, ...recipeMeasures(prep)]) : null;
        if (viaPrep != null) return viaPrep;
      }
      // An item counted by the unit or the bunch with a recipe's measures: one recipe is one of them, as ever.
      if (own.length && (base === "unit" || base === "bunch")) {
        const asOne = throughRecipe(qty, unit, base, [...own, { qty: 1, unit: base }]);
        if (asOne != null) return asOne;
      }
      return amountIn(qty, unit, base, each);
    }
    /** What one recipe of an item comes to: its prep's when it's made from one, else its own. */
    function itemMeasures(ing) {
      const prep = ing.prep_id && recipes.get(ing.prep_id);
      return prep ? recipeMeasures(prep) : savedMeasures(ing);
    }
    /** The units something can be counted in on the inventory: its own first, then any it has a measure for. */
    function countChoices(x, isPrep) {
      const base = isPrep ? x.yield_unit : x.base;
      const convert = (u) => (isPrep ? subAmount(1, u, x) : itemAmount(x, 1, u));
      const linked = !isPrep && x.prep_id && recipes.get(x.prep_id);
      const known = isPrep ? recipeMeasures(x).map((m) => m.unit) : [...savedMeasures(x).map((m) => m.unit), ...itemMeasures(x).map((m) => m.unit)];
      const seen = [...known];
      if (isPrep || linked || known.length) seen.push("recipe");
      if (!isPrep && num(x.each_kg) > 0) seen.push(Units.countable(base) ? "kg" : base === "kg" ? "unit" : "");
      const others = ["kg", "L", "portion", "unit", "bunch", "recipe", "bottle"].filter((u) => u !== base && seen.includes(u) && convert(u) > 0);
      // An item's own sizes too: count the pastry in packs or cases.
      const own = isPrep ? [] : sizeNames(x).filter((u) => convert(u) > 0);
      return [base, ...others, ...own];
    }
    function sameMeasure(qty, from, to) {
      if (!to) return null;
      if (from === "portion" || to === "portion" || from === "recipe" || to === "recipe") return from === to ? qty : null;
      return Units.convert(qty, from, to);
    }
    /** How much one batch of a prep is in a given base (kg / L / unit), from its yield or its other measure. */
    function batchIn(sub, base) {
      if (base === "recipe") return 1; // one recipe is one batch
      for (const [q, u] of [[num(sub.yield_qty), sub.yield_unit], [num(sub.alt_qty), sub.alt_unit], ...savedMeasures(sub).map((m) => [m.qty, m.unit])]) {
        if (!q || !u) continue;
        const v = amountIn(q, u, base);
        if (v != null) return v;
      }
      return null;
    }

    /** What the dish screens and the alerts show. */
    function summary(recipeId) {
      const rec = recipes.get(recipeId);
      const c = recipeCost(recipeId);
      const mult = num(rec.multiplier) || DEFAULT_MULTIPLIER;
      const per = c.perYield;
      const price = num(rec.menu_price);
      const ack = num(rec.ack_cost);
      const change = ack == null ? 0 : per - ack;
      return {
        recipe: rec,
        total: c.total,
        perPortion: per,
        multiplier: mult,
        suggested: per * mult,
        menuPrice: price,
        foodCost: price ? per / price : null,
        target: 1 / mult,
        over: price ? per / price > 1 / mult + 1e-9 : false,
        actualMultiplier: price && per ? price / per : null,
        ack,
        change: Math.abs(change) < 0.005 ? 0 : change,
        changePct: ack ? change / ack : null,
        problems: c.problems,
        lines: c.lines,
      };
    }

    /** Recipes (dishes and preps) that use an ingredient or a prep, directly or through other preps. */
    // A prep also reaches the recipes that use a prepped item made from it.
    const usersOf = (rid) => data.lines.filter((l) => l.sub_recipe_id === rid ||
      (l.ingredient_id && ingredients.get(l.ingredient_id) && ingredients.get(l.ingredient_id).prep_id === rid));
    function usedBy(id) {
      const direct = data.lines.filter((l) => l.ingredient_id === id || l.sub_recipe_id === id ||
        (l.ingredient_id && ingredients.get(l.ingredient_id) && ingredients.get(l.ingredient_id).prep_id === id)).map((l) => l.recipe_id);
      const seen = new Set();
      const walk = (rid) => {
        if (seen.has(rid)) return;
        seen.add(rid);
        usersOf(rid).forEach((l) => walk(l.recipe_id));
      };
      direct.forEach(walk);
      return [...seen];
    }

    return { offerPrice, offersFor, defaultOffer, liveOffer, chosenOffer, linkedOffer, recipeCost, subAmount, itemAmount, packAmount, batchSize, itemMeasures, countChoices, summary, usedBy, ingredients, recipes, linesByRecipe };
  }

  const api = { create, amountIn, savedMeasures, savedSizes, sizeIn, sizeNames, recipeMeasures, withPortionSize, netWeight, lastOfEachDay, DEFAULT_MULTIPLIER };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Costing = api;
})(typeof window !== "undefined" ? window : globalThis);
