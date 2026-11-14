/* The inventory's summary, kept apart from the screens so it can be tested: which kind of cost each section is, what
 * each group is worth this month and last, and the month's food cost.
 * A section's group is the one you picked (settings.categories.groups = { section: group }), else a guess from its name.
 * Works in the browser (window.Summary) and in Node (require) for the tests.
 */
(function (root) {
  // What each kind of stock counts toward. A group only shows once a section is in it.
  const TIERS = [
    { key: "food", label: "Food cost" },
    { key: "beverage", label: "Beverage cost" },
    { key: "other", label: "Not food cost" },
  ];
  const GROUPS = [
    { key: "food", label: "Food", tier: "food" },
    { key: "alcohol", label: "Alcohol", tier: "beverage" },
    { key: "drinks", label: "Non-alcoholic drinks", tier: "beverage" },
    { key: "takeout", label: "Takeout & packaging", tier: "other" },
    { key: "kitchen", label: "Kitchen supplies", tier: "other" },
    { key: "cleaning", label: "Cleaning", tier: "other" },
    { key: "dining", label: "Dining room supplies", tier: "other" },
    { key: "retail", label: "Retail / merchandise", tier: "other" },
  ];
  const fold = (s) => String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  /** A first guess from a section's name, in French or English. Anything it doesn't recognise is food. */
  function guessGroup(section) {
    const s = fold(section);
    if (/emporter|take ?out|to ?go\b|packag|emballage|contenant/.test(s)) return "takeout";
    if (/nettoy|clean|entretien|hygien|sanit|chimique|chemical/.test(s)) return "cleaning";
    if (/alcool|alcohol|\bvins?\b|\bwines?\b|\bbieres?\b|\bbeers?\b|spiritueux|\bspirits?\b|\bbar\b|liqueur|cocktail/.test(s)) return "alcohol";
    if (/boisson|\bdrinks?\b|beverage|\bcafes?\b|coffee|\bthes?\b|\bteas?\b|\bjus\b|juice/.test(s)) return "drinks";
    if (/salle a manger|dining|front of house|\bfoh\b|vaisselle/.test(s)) return "dining";
    if (/retail|merch|boutique/.test(s)) return "retail";
    if (/^mono\b|jetable|disposable|fournitures|kitchen suppl/.test(s)) return "kitchen";
    return "food";
  }

  const known = new Set(GROUPS.map((g) => g.key));
  /** The section's group: your pick when it's a real one, else the guess. */
  const groupOf = (section, saved) => (saved && known.has(saved[section]) ? saved[section] : guessGroup(section));

  /**
   * now, last: one row per item on the count, { section, value, counted }. saved: your picks. lastSaved: the groups last month is
   * added up under, when it isn't the same: a closed month keeps the groups it closed with, so its column reads as its record does.
   * Gives the tiers with their groups and sections (each with now, last, change), the total, and the sections that look
   * forgotten: counted last month and not this month. (With no count last month to go by, any section with nothing counted.
   * A section that's never counted isn't called out every month; opening its group still says so.)
   */
  function build(now, last, saved, lastSaved = saved) {
    const sections = new Map();
    const touch = (name) => {
      if (!sections.has(name)) sections.set(name, { name, now: 0, last: 0, change: 0, items: 0, counted: 0, lastCounted: 0 });
      return sections.get(name);
    };
    for (const r of now) { const s = touch(r.section); s.now += r.value || 0; s.items++; if (r.counted) s.counted++; }
    for (const r of last) { const s = touch(r.section); s.last += r.value || 0; if (r.counted) s.lastCounted++; }
    const sum = (list, f) => list.reduce((t, x) => t + x[f], 0);
    for (const s of sections.values()) s.change = s.now - s.last;
    const groups = GROUPS.map((g) => {
      // A section with nothing on the count now stays where last month had it.
      const list = [...sections.values()].filter((s) => groupOf(s.name, s.items ? saved : lastSaved) === g.key);
      const before = [...sections.values()].filter((s) => groupOf(s.name, lastSaved) === g.key);
      return { ...g, sections: list, now: sum(list, "now"), last: sum(before, "last"), change: sum(list, "now") - sum(before, "last"), counted: sum(list, "counted"), lastCounted: sum(before, "lastCounted") };
    }).filter((g) => g.sections.length || g.lastCounted);
    const all = [...sections.values()];
    return {
      tiers: TIERS.map((t) => ({ ...t, groups: groups.filter((g) => g.tier === t.key) })).filter((t) => t.groups.length),
      groups,
      total: { now: sum(all, "now"), last: sum(all, "last"), change: sum(all, "now") - sum(all, "last") },
      notCounted: all.filter((s) => s.items > 0 && s.counted === 0 && (s.lastCounted > 0 || !all.some((x) => x.lastCounted > 0))).map((s) => s.name),
    };
  }

  /**
   * What a month's record holds. rows: the count's rows; sectionOf and cellsOf read a row's section and its cells for the
   * sheet (supplier, cost, volume, unit, yield); saved: your group picks. Plain values only, nothing that points back at
   * today's items or prices: that's what lets it never move.
   */
  function freeze(rows, { sectionOf, cellsOf, saved }) {
    const groups = {};
    for (const r of rows) { const s = sectionOf(r); groups[s] = groupOf(s, saved); }
    const counted = rows.filter((r) => r.qty != null);
    return {
      total: counted.reduce((t, r) => t + (r.value || 0), 0),
      items: rows.length,
      groups,
      rows: counted.map((r) => ({
        k: r.kind, id: r.item.id, name: r.item.name, section: sectionOf(r), qty: r.qty, unit: r.unit,
        price: r.unitPrice == null ? null : r.unitPrice, value: r.value || 0,
        last: r.last == null ? null : r.last, lastUnit: r.last == null ? null : r.lastUnit,
        locked: r.locked == null ? null : r.locked, sheet: cellsOf(r),
      })),
    };
  }
  /** A record's rows, in the shape the count's page, the summary and the sheet read. */
  function thaw(record) {
    return (record.rows || []).map((x) => ({
      frozen: true, kind: x.k,
      item: { kind: x.k, key: (x.k === "prep" ? "r:" : "") + x.id, id: x.id, name: x.name, category: x.section, base: x.unit },
      qty: x.qty, unit: x.unit, price: x.price, unitPrice: x.price, value: x.value, last: x.last, lastUnit: x.lastUnit,
      locked: x.locked, sheet: x.sheet, choices: [x.unit], tare: null, containers: null, one: 1, problem: false,
    }));
  }

  /**
   * The month's food cost: (last month's stock + purchases - this month's stock) / sales.
   * Anything missing just leaves what depends on it empty: open and close are null when that month's food wasn't counted.
   */
  function foodCost({ open = null, purchases = null, close = null, sales = null }) {
    const used = open != null && purchases != null && close != null ? open + purchases - close : null;
    return { used, pct: used != null && sales > 0 ? used / sales : null };
  }

  /** A month's purchases or sales as people write them: 12000, 12 000, 12,000, 12,000.50, 12 000,50, $12000. Elsewhere in the app a
   * comma is a decimal point, but a bigger amount is usually written with one every three digits. null if it isn't an amount. */
  function parseAmount(text) {
    let s = String(text == null ? "" : text).replace(/[\s\u00a0\u202f$]/g, "");
    if (!s) return null;
    const lastComma = s.lastIndexOf(","), lastDot = s.lastIndexOf(".");
    if (lastComma >= 0 && lastDot >= 0) {
      // Both: whichever comes last is the decimal point.
      s = lastDot > lastComma ? s.replace(/,/g, "") : s.replace(/\./g, "").replace(",", ".");
    } else if (lastComma >= 0) {
      // One comma before exactly three digits, or several commas, are thousands; otherwise it's the decimal point.
      s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, "") : s.replace(",", ".");
    }
    const v = /^\d*\.?\d+$|^\d+\.$/.test(s) ? +s : NaN;
    return Number.isFinite(v) ? v : null;
  }

  /* ---------- what was spent ---------- */
  const LEFT_OUT = "none", NOT_SORTED = "unsorted";
  // Every choice a line has: the groups, what the invoice's total couldn't account for, and lines that aren't a purchase (a deposit).
  const SPEND_EXTRA = [{ key: NOT_SORTED, label: "Not sorted" }, { key: LEFT_OUT, label: "Leave it out" }];

  // Words that say what a product is whatever a restaurant's sections are, in French or English.
  const WORDS = [
    [LEFT_OUT, /\bconsignes?\b|\bdeposits?\b/],
    ["food", /vinaigre|vinegar/], // cider vinegar isn't cider
    ["cleaning", /savon|detergent|javel|chiffon|eponge|\bsacs? (a )?ordures?|ordures|garbage|\bgants?\b|\bgloves?\b|degraissant|desinfect|sanitiz|papier (a )?main|papier (de )?toilette|pap\.? ?toilet|ess\.? ?main|essuie|lysol|kemplus|nettoy|\bnett\.|vadrouille|\bmops?\b|\bbalais?\b|\bbrooms?\b|\bsoap\b|\bbleach\b|\bsponge|\bsac pour can/],
    ["takeout", /couvercle|\bcouv\.|\blids?\b|contenant|\bcont\.|container|ustensil|\bkraft\b|styro|take ?out|to ?go\b|emporter|\bpailles?\b|\bstraws?\b|\bcups?\b|sacs? (a |de )?papier|paper bags?|\bsac karry|bol papier|paper bowl|verre portion|portion cup/],
    ["kitchen", /parchemin|parchment|silicone|papier (d )?alumin|alumin(i)?um|pellicule|\bpell\.|plastic wrap|sous.?vide|cure.?dent|toothpick|papier (a |de )?peche|papier damier|butcher paper|\bquilon\b|brochette|skewer|etamine|cheesecloth|ficelle|\btwine\b|wood (pellets|chips)|masking tape|\bthermo|\btorch\b|\bscale\b|\bbalance num/],
    ["drinks", /club soda|ginger ale|biere (de )?gingembre|ginger beer|racinette|root beer|\bcoke\b|\bcoca\b|pepsi|sprite|\b7.?up\b|perrier|pellegrino|\beau (petillant|minerale|miniral|tonic|de source)|tonic water|sparkling water|boisson|\bsoft drinks?\b|\bkombucha\b|\bcafes? (colombien|exclusif|moulu|en grain|decaf|espresso)|\bcoffee\b|\bjus (de )?(pomme|canneberge|pamplemousse|orange|raisin)|\b(apple|cranberry|grapefruit|orange) juice/],
    ["alcohol", /\bvins?\b|\bwines?\b|\bbieres?\b|\bbeers?\b|\bcidres?\b|\bcider\b|spiritueux|vodka|\bgin\b|\brhum\b|\brum\b|whisk|tequila|liqueur|cognac/],
    ["dining", /serviette|\bserv\.|napkin|chandelle|bougie|\bcandles?\b|\bnappes?\b|tablecloth/],
  ];

  /**
   * Makes the best guess of a line's group from a restaurant's own items: items = [{ name, section }], saved = its group picks.
   * In order: an item whose whole name is in the line; words that say what it is; a one-word item; the item it shares most with; else food.
   */
  function lineGuesser(items, saved) {
    const I = typeof module !== "undefined" && module.exports ? require("./invoices.js") : root.Invoices;
    // Word by word: "HPE-PBWL 04" is hpe and pbwl, not those and the two joined up, or one match would look like three.
    const known = items.map((i) => ({ section: i.section, words: [...I.words(i.name)].filter((w) => w && !w.includes("-")) })).filter((i) => i.words.length);
    const seen = new Map();
    return (name) => {
      if (seen.has(name)) return seen.get(name);
      const answer = guess(name);
      seen.set(name, answer);
      return answer;
    };
    function guess(name) {
      const line = I.words(name), text = fold(String(name).replace(/([a-zà-ÿ])([A-ZÀ-Ý])/g, "$1 $2"));
      const has = (w) => line.has(w) || [...line].some((x) => x.length >= 5 && w.length >= 5 && x.slice(0, 5) === w.slice(0, 5));
      let whole = null, near = null, nearScore = 0, nearHits = 0;
      for (const i of known) {
        const hits = i.words.filter(has).length;
        if (!hits) continue;
        if (hits === i.words.length && (!whole || i.words.length > whole.words.length)) whole = i;
        const score = hits / i.words.length + hits / Math.max(line.size, 1);
        if (score > nearScore) { near = i; nearScore = score; nearHits = hits; }
      }
      // A whole name of two words or more is the restaurant's own say. One word alone ("Gingembre" in "ginger beer") gives way.
      if (whole && whole.words.length > 1) return groupOf(whole.section, saved);
      const said = WORDS.find(([, re]) => re.test(text));
      if (said) return said[0];
      if (whole) return groupOf(whole.section, saved);
      if (!near) return "food";
      // One word in common is enough to say food; to say it isn't ("papier de riz" and "papier à main"), it takes two.
      const group = groupOf(near.section, saved);
      return group === "food" || nearHits >= 2 ? group : "food";
    }
  }

  /** A saved invoice's lines and total: each line with the group it's saved under. missed: what the printed subtotal has that no line does. */
  function invoiceRecord(lines, groupFor, missed = 0) {
    const named = (l) => String(l.item + (l.format ? " " + l.format : "")).trim().slice(0, 120);
    const out = lines.map((l) => ({ item: named(l), total: +l.total || 0, group: groupFor(l), ing: l.ingId || null }));
    if (missed) out.push({ item: "Not read from the invoice", total: missed, group: NOT_SORTED, ing: null });
    return { lines: out, total: Math.round(out.reduce((t, l) => t + (l.group === LEFT_OUT ? 0 : l.total), 0) * 100) / 100 };
  }

  /** Two invoices are the same one when supplier, date and lines all match: a copy of a file, whatever it's called. */
  const sameLines = (a, b) => a.length === b.length && a.every((l, k) => l.item === b[k].item && Math.abs((+l.total || 0) - (+b[k].total || 0)) < 0.005);

  /* Groups of your own, for what you buy that doesn't fit the others (a delivery fee): settings.spendGroups =
   * [{ key: "x:Delivery fees", label: "Delivery fees", tier: "other" }]. Only purchases go in them; the count's sections don't. */
  const OWN = "x:";
  /** A group's name from its key alone, for one that's no longer on the list. */
  const labelOf = (key) => (String(key).startsWith(OWN) ? String(key).slice(OWN.length) : String(key));
  /** Every group a purchase can count as: the built-in ones, then your own, each under the kind of cost you gave it. */
  function spendGroups(own) {
    const mine = (Array.isArray(own) ? own : []).filter((g) => g && g.key && g.label && !known.has(g.key))
      .map((g) => ({ key: g.key, label: g.label, tier: TIERS.some((t) => t.key === g.tier) ? g.tier : "other", own: true }));
    return GROUPS.concat(mine.filter((g, k) => mine.findIndex((x) => x.key === g.key) === k));
  }
  /** A new group from the name typed. A name already on the list (whatever the capitals or accents) gives that group back instead. */
  function newGroup(name, tier, own) {
    const label = String(name == null ? "" : name).trim().replace(/\s+/g, " ").slice(0, 40);
    if (!label) return null;
    const same = spendGroups(own).concat(SPEND_EXTRA).find((g) => fold(g.label) === fold(label));
    if (same) return { group: same, added: false };
    return { group: { key: OWN + label, label, tier: TIERS.some((t) => t.key === tier) ? tier : "other" }, added: true };
  }

  const cents = (n) => Math.round(n * 100) / 100;
  /** What a month's invoices come to: by tier and group, the total, and how many invoices. own: your own groups. food: everything in the
   * food cost tier (Food, and any group of your own you put there), which is what the month's food cost uses. */
  function spent(invoices, month, own) {
    const list = invoices.filter((x) => String(x.date || "").slice(0, 7) === month);
    const by = new Map();
    for (const x of list) for (const l of x.lines || []) {
      if (l.group === LEFT_OUT) continue;
      by.set(l.group, (by.get(l.group) || 0) + (+l.total || 0));
    }
    const all = spendGroups(own);
    // A group taken off the list still shows, under its own name, on what was saved in it.
    for (const k of by.keys()) if (k !== NOT_SORTED && !all.some((g) => g.key === k)) all.push({ key: k, label: labelOf(k), tier: "other" });
    const groups = all.filter((g) => by.has(g.key)).map((g) => ({ ...g, total: by.get(g.key) }));
    return {
      invoices: list.length, tiers: TIERS.map((t) => ({ ...t, groups: groups.filter((g) => g.tier === t.key) })).filter((t) => t.groups.length), groups,
      notSorted: by.has(NOT_SORTED) ? cents(by.get(NOT_SORTED)) : 0, food: cents(groups.filter((g) => g.tier === "food").reduce((t, g) => t + g.total, 0)),
      total: cents([...by.values()].reduce((t, v) => t + v, 0)),
    };
  }

  /** What a month's purchases come to per supplier, the biggest first: how many invoices and on which days, the total, by group, and what
   * was bought (the same thing on several invoices is one row, with how many times). Lines left out don't count, like everywhere else. */
  function bySupplier(invoices, month) {
    const by = new Map();
    for (const x of invoices) {
      if (String(x.date || "").slice(0, 7) !== month) continue;
      const name = String(x.supplier || "").trim() || "No supplier";
      if (!by.has(fold(name))) by.set(fold(name), { supplier: name, invoices: 0, dates: [], total: 0, groups: new Map(), items: new Map() });
      const s = by.get(fold(name));
      s.invoices++;
      s.dates.push(String(x.date).slice(0, 10));
      for (const l of x.lines || []) {
        if (l.group === LEFT_OUT) continue;
        const t = +l.total || 0, item = String(l.item || "").trim() || "Purchase";
        s.total += t;
        s.groups.set(l.group, (s.groups.get(l.group) || 0) + t);
        if (!s.items.has(fold(item))) s.items.set(fold(item), { item, group: l.group, times: 0, total: 0 });
        const it = s.items.get(fold(item));
        it.times++;
        it.total += t;
      }
    }
    return [...by.values()].map((s) => ({
      supplier: s.supplier, invoices: s.invoices, dates: s.dates.sort(), total: cents(s.total),
      groups: [...s.groups].map(([key, total]) => ({ key, total: cents(total) })).sort((a, b) => b.total - a.total),
      items: [...s.items.values()].map((i) => ({ ...i, total: cents(i.total) })).sort((a, b) => b.total - a.total || a.item.localeCompare(b.item, "fr")),
    })).sort((a, b) => b.total - a.total || a.supplier.localeCompare(b.supplier, "fr"));
  }

  const api = { TIERS, GROUPS, SPEND_EXTRA, LEFT_OUT, NOT_SORTED, guessGroup, groupOf, build, foodCost, parseAmount, freeze, thaw, lineGuesser, invoiceRecord, sameLines,
    spent, spendGroups, newGroup, labelOf, bySupplier };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Summary = api;
})(typeof window !== "undefined" ? window : globalThis);
