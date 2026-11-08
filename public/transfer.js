/* Bringing recipes and items from one account into another: from your own account into a restaurant's, or out of a restaurant's
 * if you're its administrator. Copies, never links, so each account stays whole on its own. Kept apart from the screens so it
 * can be tested. Works in the browser (window.Transfer) and in Node (require) for the tests.
 *
 * source, target: { ingredients, offers, recipes, lines }. The target's are what's already there to match against.
 * picked: { recipes: [ids], items: [ids] }. A picked recipe brings what it needs along: its lines, the preps they use (and what
 * those use), and its items. An item or a prep that's only needed comes from the target when it has one of that name.
 * estimate: the person can't set prices here, so what they bring in is flagged for an administrator to double check.
 */
(function (root) {
  const fold = (s) => String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

  // Whose it was, which side, how it was checked: none of it comes along. A copy starts its own life here.
  const ITEM_LEAVES = ["id", "user_id", "project", "created_at", "created_by", "preferred_offer_id", "prep_id", "needs_check", "review"];
  const RECIPE_LEAVES = ["id", "user_id", "project", "created_at", "created_by", "ack_cost", "card_doc_id", "review"];
  const OFFER_LEAVES = ["id", "user_id", "project", "created_at", "ingredient_id"];
  const LINE_LEAVES = ["id", "user_id", "project", "created_at", "recipe_id", "ingredient_id", "sub_recipe_id", "offer_id"];
  const without = (row, leaves) => { const out = { ...row }; for (const k of leaves) delete out[k]; return out; };

  function plan({ source, target, picked, newId, estimate = false, note = "" }) {
    const srcItem = new Map(source.ingredients.map((i) => [i.id, i])), srcRecipe = new Map(source.recipes.map((r) => [r.id, r]));
    const hereItem = new Map(target.ingredients.map((i) => [fold(i.name), i]));
    const preps = new Map(target.recipes.filter((r) => r.kind === "prep").map((r) => [fold(r.name), r]));
    const taken = new Set(target.recipes.map((r) => fold(r.name)));
    const offersOf = (id) => source.offers.filter((o) => o.ingredient_id === id), linesOf = (id) => source.lines.filter((l) => l.recipe_id === id);
    const pickedRecipes = new Set(picked.recipes || []);

    const out = { ingredients: [], offers: [], recipes: [], lines: [], later: [], matchedItems: [], matchedPreps: [], renamed: [] };
    const itemMap = new Map(), offerMap = new Map(), recipeMap = new Map();

    function bringItem(id) {
      if (itemMap.has(id)) return itemMap.get(id);
      const from = srcItem.get(id);
      if (!from) return null;
      const here = hereItem.get(fold(from.name));
      if (here) { itemMap.set(id, here.id); out.matchedItems.push(from.name); return here.id; }
      const copyId = newId();
      itemMap.set(id, copyId);
      hereItem.set(fold(from.name), { id: copyId, name: from.name });
      const row = { ...without(from, ITEM_LEAVES), id: copyId, preferred_offer_id: null, prep_id: null, review: "", needs_check: false };
      if (estimate) { row.needs_check = true; row.review = note; row.locked_price = null; row.locked_at = null; row.in_inventory = false; }
      out.ingredients.push(row);
      for (const o of offersOf(id)) {
        const offerId = newId();
        offerMap.set(o.id, offerId);
        out.offers.push({ ...without(o, OFFER_LEAVES), id: offerId, ingredient_id: copyId });
      }
      const later = {};
      if (from.preferred_offer_id && offerMap.has(from.preferred_offer_id)) later.preferred_offer_id = offerMap.get(from.preferred_offer_id);
      // Made from a prep: that prep comes too, unless the person can't lock or link prices here.
      if (from.prep_id && srcRecipe.has(from.prep_id) && !estimate) later.prep_id = bringRecipe(from.prep_id);
      if (Object.keys(later).length) out.later.push({ table: "ingredients", id: copyId, changes: later });
      return copyId;
    }

    function bringRecipe(id) {
      if (recipeMap.has(id)) return recipeMap.get(id);
      const from = srcRecipe.get(id);
      if (!from) return null;
      const isPicked = pickedRecipes.has(id);
      // A prep that's only needed: this account's own, if it has one of that name.
      if (!isPicked && from.kind === "prep" && preps.has(fold(from.name))) {
        const hereId = preps.get(fold(from.name)).id;
        recipeMap.set(id, hereId);
        out.matchedPreps.push(from.name);
        return hereId;
      }
      const copyId = newId();
      recipeMap.set(id, copyId);
      // A name that's already here gets marked, so nothing gets mixed up and nothing is overwritten.
      let name = from.name;
      for (let k = 1; taken.has(fold(name)); k++) name = `${from.name} (imported${k > 1 ? " " + k : ""})`;
      if (name !== from.name) out.renamed.push({ from: from.name, to: name });
      taken.add(fold(name));
      const row = { ...without(from, RECIPE_LEAVES), id: copyId, name, review: "", ack_cost: null, card_doc_id: null };
      if (estimate) { row.locked_cost = null; row.locked_at = null; }
      out.recipes.push(row);
      if (row.kind === "prep") preps.set(fold(from.name), { id: copyId, name });
      for (const l of linesOf(id)) {
        const line = { ...without(l, LINE_LEAVES), id: newId(), recipe_id: copyId };
        if (l.ingredient_id) {
          const item = bringItem(l.ingredient_id);
          if (!item) continue;
          line.ingredient_id = item;
          if (l.offer_id && offerMap.has(l.offer_id)) line.offer_id = offerMap.get(l.offer_id);
        } else if (l.sub_recipe_id) {
          const sub = bringRecipe(l.sub_recipe_id);
          if (!sub) continue;
          line.sub_recipe_id = sub;
        } else continue;
        out.lines.push(line);
      }
      return copyId;
    }

    for (const id of picked.recipes || []) bringRecipe(id);
    for (const id of picked.items || []) bringItem(id);
    return out;
  }

  /** Who can bring what where: from your own account always, out of a restaurant's only if you're its administrator. */
  function sources(joined, myId, showing) {
    const out = [];
    if (showing !== myId) out.push({ id: myId, own: true });
    for (const m of joined) if (m.role === "admin" && m.account_id !== showing) out.push({ id: m.account_id, name: m.account_name });
    return out;
  }

  const api = { plan, sources, fold };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Transfer = api;
})(typeof window !== "undefined" ? window : globalThis);
