/* Reading supplier invoices: one reader per supplier's layout, and the rules for tying a line to an ingredient.
 * Used by the Invoices page (browser) and by scripts/parse-invoices.js and scripts/match-invoice-prices.js (Node).
 *   Invoices.read(text)      -> { supplier, date, lines: [{ item, format, code, qty, uom, price, total }] }
 *   Invoices.words / packOf / perKg / share  — matching helpers */
(function (root) {
  const n = (s) => +String(s).replace(/\s/g, "").replace(",", ".");
  const close = (a, b) => Math.abs(a - b) <= Math.max(0.02, 0.01 * Math.abs(b));
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

  const SUPPLIERS = [
    ["Can-Am", /can-am/i], ["Chez Nino", /chez nino/i], ["La Mer", /la mer\b|lamer/i], ["Viandex", /viandex/i],
    ["BrinNature", /brin-?nature/i], ["Champignon Inc", /pieds de champignon/i], ["Hector Larivée", /hector lariv/i],
    ["Multiplus", /AGENT PERCEPTEUR/], ["Amazon.ca", /amazon\.com\.ca/i],
  ];

  /* ---------- layouts many businesses share: one reader, whoever sent the invoice ---------- */
  // QuickBooks Online prints the same invoice for every business, in French or English. Only the columns it shows change:
  // PRODUITS|DESCRIPTION|QTÉ|TAUX|MONTANT, QTY|ACTIVITY|DESCRIPTION|RATE|AMOUNT, DATE|ACTIVITÉ|DESCRIPTION|QTÉ|TAUX|MONTANT.
  const QB_HEAD = /^(?:(?:DATE|PRODUITS?|PRODUCTS?|SERVICES?|ACTIVIT[ÉE]|ACTIVITY|DESCRIPTION|SKU|TAX(?:ES?)?|QT[ÉE]\.?|QTY|QUANTIT[ÉE]|QUANTITY|TAUX|RATE|PRIX|PRICE|MONTANT|AMOUNT)\s*){3,}$/;
  const isQbHead = (l) => QB_HEAD.test(l) && /QT|QUANTIT/.test(l) && /TAUX|RATE|PRIX|PRICE/.test(l) && /MONTANT|AMOUNT/.test(l);
  const textLines = (t) => t.split("\n").map((s) => s.normalize("NFC").trim()).filter(Boolean);
  const knownName = (s) => (SUPPLIERS.find(([, re]) => re.test(s)) || [])[0];
  // The sender is the line after "Page 1 of 1": "Brin-Nature Inc.", "Redfroglab Inc. / Lab. Grenouille".
  function qbName(t) {
    const L = textLines(t), raw = L[L.findIndex((l) => /^Page \d+ (of|de|sur) \d+$/i.test(l)) + 1] || "";
    return knownName(raw) || raw.split(" / ")[0].replace(/[,\s]+(inc|lt[ée]e|ltd|llc|enr|s\.?e\.?n\.?c\.?)\.?$/i, "").trim();
  }
  // 15/10/2026, 06/17/2026 or 2026-10-07. When it could be either, the due date says which (it's a few weeks later), then the language.
  function qbDate(L) {
    const find = (re) => { for (const l of L) { const m = l.match(re); if (m) return m[1]; } return null; };
    const d = find(/^DATE\s*(\d[\d/-]+\d)$/), due = find(/^(?:ÉCHÉANCE|DUE DATE)\s*(\d[\d/-]+\d)$/);
    if (!d) return null;
    if (/^\d{4}-/.test(d)) return d;
    const [a, b, y] = d.split("/").map(Number);
    if (a > 12) return iso(y, b, a);
    if (b > 12) return iso(y, a, b);
    if (due && /^\d+\/\d+\/\d{4}$/.test(due)) {
      const [c, e, z] = due.split("/").map(Number);
      const days = (from, to) => (to - from) / 86400000;
      const dayFirst = days(Date.UTC(y, b - 1, a), Date.UTC(z, e - 1, c)), monthFirst = days(Date.UTC(y, a - 1, b), Date.UTC(z, c - 1, e));
      const fits = (x) => x >= 0 && x <= 120;
      if (fits(dayFirst) !== fits(monthFirst)) return fits(dayFirst) ? iso(y, b, a) : iso(y, a, b);
    }
    return L.some((l) => /^(BILL TO|INVOICE)$/.test(l)) ? iso(y, a, b) : iso(y, b, a);
  }
  // The numbers run together ("9.341.2511.68"): try every split into quantity | rate | amount and keep the one where
  // quantity x rate = amount, the smallest quantity when several fit. Digits it doesn't need belong to the name.
  function qbSplit(tail) {
    for (let p = 0; p < tail.length; p++) {
      const s = tail.slice(p);
      if (p && !/^\d/.test(s)) continue;
      let best = null;
      for (let a = 1; a < s.length; a++) {
        const amt = s.slice(a);
        if (!/^(0|[1-9]\d*)[.,]\d{2}$/.test(amt)) continue;
        for (let r = 1; r < a; r++) {
          const rate = s.slice(r, a), qty = s.slice(0, r);
          if (!/^\d+[.,]\d{2,4}$/.test(rate) || !/^\d+([.,]\d{1,3})?$/.test(qty)) continue;
          const err = Math.abs(n(qty) * n(rate) - n(amt));
          if (err <= Math.max(0.02, 0.005 * n(amt)) && (!best || err < best.err)) best = { qty: n(qty), price: n(rate), total: n(amt), err, extra: tail.slice(0, p) };
        }
      }
      if (best) return best;
    }
    return null;
  }
  // "Lobster mushroomLobster Mushroom (…)", "C-Pleurotes bleusPOC-Pleurotes bleus": the product, then its description.
  function qbTidy(s) {
    const low = s.toLowerCase();
    for (let k = Math.floor(s.length / 2); k >= 4; k--) { const at = low.indexOf(low.slice(0, k), k); if (at >= k && at <= k + 3) return s.slice(at); }
    return s;
  }
  function qbRow(text, qtyFirst) {
    // Thousands: "1,250.00", "1 250,00".
    const s = text.replace(/(\d),(\d{3}\.\d{2})/g, "$1$2").replace(/(\d)[ \u00a0](\d{3},\d{2})/g, "$1$2");
    if (qtyFirst) {
      const m = s.match(/^(\d+(?:[.,]\d+)?)(\D.*?)(\d+[.,]\d{2})(\d+[.,]\d{2})$/);
      if (!m || !close(n(m[1]) * n(m[3]), n(m[4]))) return null;
      // "r-Ch-Maitake/5LBSMaitake boite de 5LBs": the activity's code runs into the description.
      return { item: (m[2].match(/^\S+?\/\S+?(\D.*)$/) || [null, m[2]])[1].trim(), qty: n(m[1]), uom: "UN", price: n(m[3]), total: n(m[4]) };
    }
    // "2 un" before the numbers is a piece count; the rate is per lb.
    const m = s.match(/^(.*?\D)(?:\d+ un)?([\d.,]+)$/);
    if (!m || /TOTAL|TPS|TVQ|SOLDE/i.test(m[1])) return null;
    const got = qbSplit(m[2]);
    if (!got) return null;
    const name = qbTidy((m[1] + got.extra).replace(/^\d{4}-\d{2}-\d{2}|^\d{2}\/\d{2}\/\d{4}/, "").trim());
    return { item: name, qty: got.qty, uom: /\(lbs?\)/i.test(name) ? "LB" : /\(kg\)/i.test(name) ? "KG" : "UN", price: got.price, total: got.total };
  }
  function quickbooks(t) {
    const L = textLines(t), head = L.findIndex(isQbHead);
    if (head < 0) return [];
    const date = qbDate(L), qtyFirst = /^(QT|QUANTIT)/.test(L[head]);
    const end = L.findIndex((l, k) => k > head && /^(TOTAL PARTIEL|SUBTOTAL|SOUS-TOTAL|TOTAL)\b/.test(l));
    const rows = L.slice(head + 1, end < 0 ? L.length : end), out = [];
    const numbers = (l) => /^[\d.,]+$/.test(l);
    for (let i = 0; i < rows.length; i++) {
      // A long name runs over lines, its numbers at the end of the last one, or on a line of their own.
      const tries = [[rows[i], 0]];
      if (rows[i + 1] != null && (numbers(rows[i + 1]) || !/^\d/.test(rows[i + 1]))) tries.push([rows[i] + " " + rows[i + 1], 1]);
      if (rows[i + 2] != null && numbers(rows[i + 2])) tries.push([rows[i] + " " + rows[i + 1] + " " + rows[i + 2], 2]);
      for (const [text, more] of tries) {
        const row = qbRow(text, qtyFirst);
        if (row) { out.push({ date, ...row }); i += more; break; }
      }
    }
    return out;
  }
  const qbSubtotal = (t) => after(t, new RegExp("(?:TOTAL PARTIEL|SUBTOTAL|SOUS-TOTAL)\\s*:?\\s*\\$?\\s*" + AMT));
  const isQuickBooks = (t) => /TOTAL/.test(t) && textLines(t).some(isQbHead);

  // Pepper: distributors take orders through it, and its confirmation emails look the same whichever one you order from.
  // "Hector Larivée <hello+…@messages.usepepper.com>Thu, Aug 20, 2026" ... "4Dill 1UN UNUnit00683CA$2.25CA$9.00"
  // Items off the order guide run over lines: "2Carrots Medium 5LB CL" / "Non-order guide" / "Bag00259CA$3.20CA$6.40".
  function pepper(t) {
    const d = t.match(/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), ([A-Z][a-z]{2}) (\d{1,2}), (\d{4})/);
    const date = d ? iso(d[3], MONTHS[d[1].toLowerCase()], d[2]) : null;
    const out = [];
    const RE = /^(\d+)(.+?)(?:CS|UN|LB|KG|BAG|CA|BX|BN|DZ)?(Case|Unit|Bag|Box|Bunch|Pound|Kilogram|Dozen)?(\d{4,6})CA\$([\d,.]+)CA\$([\d,.]+)$/;
    let L = t.split("\n").map((s) => s.trim()).filter((s) => s && !/^(Non-order guide|Order guide|No substitutes selected)$/i.test(s));
    // Only the item table: the address above it starts with a number too ("12 Rue Exemple").
    const top = L.findIndex((s) => /^QtyItem/.test(s));
    if (top >= 0) L = L.slice(top + 1);
    const end = L.findIndex((s) => /^Subtotal\b/.test(s));
    if (end >= 0) L = L.slice(0, end);
    for (let i = 0; i < L.length; i++) {
      let l = L[i];
      // Not a whole item: join the next lines (up to 3) until the prices show up, unless one of them is an item itself.
      if (!RE.test(l) && /^\d+\D/.test(l)) {
        for (let k = i + 1; k < L.length && k <= i + 3 && !RE.test(L[k]); k++) {
          if (RE.test(l + " " + L[k])) { l += " " + L[k]; i = k; break; }
          l += " " + L[k];
        }
      }
      const m = l.match(RE);
      if (!m) continue;
      const qty = +m[1], price = n(m[5].replace(/,/g, "")), total = n(m[6].replace(/,/g, ""));
      // Icons from the email (a favourite star) come through as private-use characters: drop them.
      const item = m[2].replace(/[\uE000-\uF8FF\u200B-\u200D\uFEFF]/g, "").replace(/\s+(CS|UN|LB|KG|BAG|CA|BX|BN|DZ)\s*$/i, "").trim();
      // How Hector sells it (case, bag, unit…) is only for showing: their "Unit" can be a pack ("Chives 4UN").
      out.push({ date, item, qty, uom: "PK", sold: m[3] ? { Pound: "lb", Kilogram: "kg" }[m[3]] || m[3].toLowerCase() : undefined, price, total, code: m[4] });
    }
    return out;
  }
  const pepperSubtotal = (t) => after(t, new RegExp("Subtotal \\(\\d+ units?\\)\\s*CA\\$" + AMT));
  const isPepper = (t) => /usepepper\.com/i.test(t) || /^QtyItemUnitItem ?code/m.test(t);
  function pepperName(t) {
    const m = t.match(/^(.+?) <[^>]*usepepper\.com>/m);
    return knownName(m ? m[1] : t) || (m ? m[1].trim() : "Pepper order");
  }
  const SHARED = [
    { is: isQuickBooks, name: qbName, read: quickbooks, subtotal: qbSubtotal },
    { is: isPepper, name: pepperName, read: pepper, subtotal: pepperSubtotal },
  ];

  const readers = {
    // "Laitues Mesclun Arcadian3 lbFIE ARC2  CACA2.000 15.50Mans31.00 0"
    "Can-Am"(t) {
      const date = (t.match(/\d{4}-\d{2}-\d{2}/) || [])[0];
      const out = [];
      const RE = /^(.+?)\d+\s+([A-Z]{2})\2(\d+\.\d{3}) (\d+\.\d{2})\D*?(\d+\.\d{2}) \d+\s*$/;
      const L = t.split("\n");
      for (let i = 0; i < L.length; i++) {
        let l = L[i];
        // A brand can push the total onto the next line: "…UNUN6.000 10.50" / "PERRICONE FARMS63.00 0".
        if (!RE.test(l) && L[i + 1] != null && !RE.test(L[i + 1]) && RE.test(l + " " + L[i + 1])) l += " " + L[++i];
        const m = l.match(RE);
        if (!m || !close(n(m[3]) * n(m[4]), n(m[5]))) continue;
        // "BasilicunBAS" = Basilic | un | BAS; "Laitues Mesclun Arcadian3 lbFIE ARC" = name | 3 lb | code.
        const p = m[1].trim().match(/^(.*?)((?:\d+(?:[.,]\d+)?\s?(?:x\s?)?)?\d*\s?(?:lb|kg|g|un|ct|L|ml|dz))([A-Z][A-Z0-9 -]*)$/);
        out.push({ date, item: (p ? p[1] : m[1]).trim(), format: p ? p[2].trim() : "", code: p ? p[3].trim() : "", qty: n(m[3]), uom: m[2], price: n(m[4]), total: n(m[5]) });
      }
      return out;
    },
    // "312054 2,00 2,00CS 20 kgPoulet Carcasse (dos de poulet)Ferme Voltigeur40.000 KG 2,2590.00" (printed twice)
    Viandex(t) {
      const date = (t.match(/\d{4}-\d{2}-\d{2}/) || [])[0];
      const flat = t.replace(/\n/g, " ");
      const seen = new Set(), out = [];
      // "1,00CS12 x 6 x 200 grCaille…": sometimes no space after the unit.
      for (const m of flat.matchAll(/(\d{6}) (\d+,\d{2}) (\d+,\d{2})([A-Z]{2}) ?(.+?)(\d+\.\d{3}) (KG|UN|CS|LB) (\d+,\d{2})(\d+\.\d{2})/g)) {
        const key = m[1] + "|" + m[9];
        if (seen.has(key) || !close(n(m[6]) * n(m[8]), n(m[9]))) continue;
        seen.add(key);
        out.push({ date, item: `${m[1]} ${m[5].trim()}`, qty: n(m[6]), uom: m[7], price: n(m[8]), total: n(m[9]), code: m[1] });
      }
      return out;
    },
    "Chez Nino": quickbooks,
    // "9,619,61FRW1023026,63 /KG255,91OMBLE - QC (Ocean Wise)KGKG"
    "La Mer"(t) {
      const date = (t.match(/\d{4}-\d{2}-\d{2}/) || [])[0];
      const out = [];
      for (const l of t.split("\n")) {
        const m = l.match(/^(\d+,\d{2})(\d+,\d{2})(\S*?)(\d+,\d{2}) \/([A-Z]{2})(\d+,\d{2})(.+?)([A-Z]{2})\8?$/);
        if (!m) continue;
        const qty = n(m[2]), total = n(m[6]);
        out.push({ date, item: m[7].trim(), qty, uom: m[5], price: qty ? +(total / qty).toFixed(2) : n(m[4]), total });
      }
      return out;
    },
    "Hector Larivée": pepper,
    // "6  Maitake17.00102.00"
    "Champignon Inc"(t) {
      const date = (t.match(/\d{4}-\d{2}-\d{2}/) || [])[0];
      return t.split("\n").map((l) => l.match(/^(\d+(?:\.\d+)?)\s+(\D.*?)(\d+\.\d{2})(\d+\.\d{2})$/)).filter((m) => m && close(n(m[1]) * n(m[3]), n(m[4])))
        .map((m) => ({ date, item: m[2].trim(), qty: n(m[1]), uom: "UN", price: n(m[3]), total: n(m[4]) }));
    },
    BrinNature: quickbooks,
    // Amazon.ca, in both languages. The description, "ASIN: …", then "1$22.99$0.00$1.15$2.29$26.43": quantity, unit
    // price, discount, the two taxes, and the line's total with its taxes.
    "Amazon.ca"(t) {
      const d = t.match(/Invoice date[^\n]*\n\s*(\d{1,2}) ([A-Z][a-z]+) (\d{4})/);
      const date = d ? iso(d[3], MONTHS[d[2].slice(0, 3).toLowerCase()], d[1]) : null;
      const L = textLines(t), out = [];
      const money = (s) => n(s.replace(/,/g, ""));
      for (let i = 0; i < L.length; i++) {
        const m = L[i].match(/^(\d+)\$([\d,.]+)-?\$([\d,.]+)\$([\d,.]+)\$([\d,.]+)\$([\d,.]+)$/);
        if (!m) continue;
        const name = [];
        for (let k = i - 1; k >= 0 && !/\$\d[\d,.]*$|l.article$/.test(L[k]); k--) if (!/^ASIN:/.test(L[k])) name.unshift(L[k]);
        const qty = +m[1], total = Math.round((money(m[6]) - money(m[4]) - money(m[5])) * 100) / 100;
        out.push({ date, item: name.join(" ").split(" / ")[0].trim(), qty, uom: "UN", price: qty ? Math.round((total / qty) * 100) / 100 : money(m[2]), total });
      }
      return out;
    },
    // Columns: descriptions, then quantities, formats, units (CA/UN…), unit prices, totals, shipped quantities.
    Multiplus(t) {
      const d = t.match(/(\d{2})\/(\d{2})\/(\d{4})/);
      const date = d ? iso(d[3], d[2], d[1]) : null;
      const L = t.split("\n").map((s) => s.trim()).filter(Boolean);
      const out = [];
      // Several pages: each page has its own block of descriptions and columns.
      const isUnit = (s) => /^(CA|UN|KG|LB|PQ|BT|SA|CS|DZ|BO|PA)$/.test(s);
      for (let i = 0; i < L.length; i++) {
        if (!isUnit(L[i]) || isUnit(L[i - 1] || "")) continue;
        let j = i; while (j < L.length && isUnit(L[j])) j++;
        const count = j - i;
        if (count < 1) continue;
        const formats = L.slice(i - count, i);
        // Descriptions: the run of text lines before the quantity column, which sits right before the formats.
        let q = i - count; let qs = q; while (qs > 0 && /^\d+$/.test(L[qs - 1])) qs--;
        const descEnd = qs; let ds = descEnd; while (ds > 0 && /[A-Za-z]/.test(L[ds - 1]) && !/^(AGENT PERCEPTEUR|TEL\.|No TPS)/.test(L[ds - 1])) ds--;
        const descs = L.slice(ds, descEnd).slice(-count);
        // Prices follow the unit codes; then "FP" markers; then totals; then shipped quantities.
        let k = j; const prices = []; while (k < L.length && /^\d+\.\d{2}$/.test(L[k])) prices.push(n(L[k++]));
        while (k < L.length && L[k] === "FP") k++;
        const totals = []; while (k < L.length && /^\d+\.\d{2}$/.test(L[k])) totals.push(n(L[k++]));
        const shipped = []; while (k < L.length && /^\d+$/.test(L[k])) shipped.push(+L[k++]);
        if (descs.length !== count) continue;
        // Items not shipped (0) have no price: line the prices up with the shipped ones.
        const shippedIdx = shipped.length === count ? descs.map((_, x) => x).filter((x) => shipped[x] > 0) : descs.map((_, x) => x);
        // No "FP" between them: the prices and the totals run together in one column.
        if (!totals.length && prices.length === 2 * shippedIdx.length) totals.push(...prices.splice(shippedIdx.length));
        if (prices.length !== shippedIdx.length) continue;
        shippedIdx.forEach((x, p) => {
          const qty = shipped.length === count ? shipped[x] : 1;
          const total = totals[p] != null ? totals[p] : prices[p] * qty;
          if (!close(prices[p] * qty, total)) return;
          out.push({ date, item: descs[x], format: formats[x], qty, uom: L[i + x], price: prices[p], total });
        });
        i = k;
      }
      return out;
    },
  };


  // "1 153.56", "1,153.56", "301,05", "1 301,05" -> a number (the last . or , with two digits after it is the decimal point).
  const amount = (s) => {
    const m = String(s).replace(/\s/g, "").match(/^(\d[\d.,]*?)[.,](\d{2})$/);
    return m ? +(m[1].replace(/[.,]/g, "") + "." + m[2]) : null;
  };
  const AMT = "(\\d[\\d ,.]*[.,]\\d{2})";
  const after = (t, re) => { const m = t.match(re); return m ? amount(m[1]) : null; };
  // An amount alone on its line.
  const alone = (l) => /^\s*\d[\d ,.]*[.,]\d{2}\s*$/.test(l);

  // The subtotal printed on each supplier's invoice (before taxes), to catch lines the reader missed.
  const SUBTOTALS = {
    "Hector Larivée": pepperSubtotal,
    "Chez Nino": qbSubtotal,
    BrinNature: qbSubtotal,
    // Its subtotal includes the taxes and any shipping: the lines are before tax, and shipping isn't one of them.
    "Amazon.ca"(t) {
      const sub = after(t, /Invoice subtotal[^$]*\$(\d[\d ,.]*[.,]\d{2})/);
      if (sub == null) return null;
      let off = 0;
      for (const l of t.split("\n").map((s) => s.trim())) {
        const m = l.match(/^(\d+|Shipping charges[^$]*)\$[\d,.]+-?\$[\d,.]+\$([\d,.]+)\$([\d,.]+)\$([\d,.]+)$/);
        if (m) off += /^\d/.test(m[1]) ? amount(m[2]) + amount(m[3]) : amount(m[4]);
      }
      return Math.round((sub - off) * 100) / 100;
    },
    "Champignon Inc": (t) => after(t, new RegExp("Sous-total\\s*:\\s*" + AMT)),
    "La Mer": (t) => after(t, new RegExp("Sous-Total\\s*" + AMT)),
    // "Sous-total :" / taxes / "Total facture :" labels, then their amounts in the same order further down.
    "Can-Am"(t) {
      const L = t.split("\n"), i = L.findIndex((l) => /^Sous-total\s*:/.test(l));
      const v = i < 0 ? null : L.slice(i + 1).find(alone);
      return v ? amount(v) : null;
    },
    // The amount sits right above its "Sous Total" label.
    Multiplus(t) {
      const L = t.split("\n"), i = L.findIndex((l) => /^\s*Sous Total\s*$/.test(l));
      return i > 0 && alone(L[i - 1]) ? amount(L[i - 1]) : null;
    },
    // No label: what's owed is the first amount printed twice ("797.84 797.84", once per copy of the invoice). It
    // includes delivery ("Frais de transport (TX)", 10.00) and that fee's taxes (5% + 9.975%): take those off.
    Viandex(t) {
      const L = t.split("\n").map((l) => l.trim());
      let owed = null;
      for (let k = 0; k < L.length && !owed; k++) {
        const m = L[k].match(/^(\d[\d,.]*[.,]\d{2}) \1$/) || (alone(L[k]) && L[k] === L[k + 1] ? [L[k], L[k]] : null);
        if (m) owed = amount(m[1]);
      }
      if (!owed) return null;
      const i = L.findIndex((l) => /^Frais de transport/.test(l));
      const fee = i > 0 && alone(L[i - 1]) ? amount(L[i - 1]) : 0;
      return Math.round((owed - fee * 1.14975) * 100) / 100;
    },
  };

  /** The text of one invoice -> its supplier, date and lines (empty when the layout isn't known), `subtotal` as
   * printed, and `missed`: how much of it no line accounts for (0 when it adds up, null when there's none to check). */
  function read(text) {
    // The shared layouts first, by their shape: the name of a known supplier can turn up anywhere on someone else's invoice.
    const shared = SHARED.find((x) => x.is(text));
    const supplier = shared ? shared.name(text) : knownName(text);
    if (!supplier) return { supplier: null, date: null, lines: [], subtotal: null, missed: null };
    const lines = (shared ? shared.read : readers[supplier])(text);
    const subtotal = shared ? shared.subtotal(text) : SUBTOTALS[supplier] ? SUBTOTALS[supplier](text) : null;
    const got = lines.reduce((a, l) => a + (+l.total || 0), 0);
    const missed = subtotal != null ? Math.round((subtotal - got) * 100) / 100 : null;
    return { supplier, date: (lines[0] && lines[0].date) || null, lines, subtotal, missed: missed != null && Math.abs(missed) < 0.02 ? 0 : missed };
  }

  const fold = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  // French ↔ English and spelling variants seen on the invoices.
  const SAME = [["aneth", "dill"], ["basilic", "basil"], ["ciboulette", "chive", "chives", "chiv"], ["persil", "parsley"], ["thym", "thyme"],
    ["sauge", "sage"], ["estragon", "tarragon"], ["menthe", "mint"], ["romarin", "rosemary"], ["cerfeuil", "chervil"], ["coriandre", "cilantro", "coriander"],
    ["carotte", "carottes", "carrottes", "carrot", "carrots"], ["betterave", "beet", "beets"], ["oignon", "oignons", "onion", "onions"],
    ["poireau", "poireaux", "leek", "leeks"], ["celeri", "celery"], ["celeri-rave", "celeriac", "rave"], ["chou", "cabbage"], ["choufleur", "chou-fleur", "cauliflower"],
    ["laitue", "laitues", "lettuce"], ["tomate", "tomates", "tomato", "tomatoes"], ["pomme", "pommes", "apple", "apples"], ["poire", "pear"],
    ["citron", "lemon"], ["lime", "limes"], ["orange", "oranges"], ["concombre", "concombres", "cucumber"], ["courgette", "courgettes", "zucchini"],
    ["aubergine", "eggplant"], ["poivron", "pepper"], ["piment", "chilli", "chillies", "chili"], ["champignon", "champignons", "mushroom"],
    ["epinard", "epinards", "spinach"], ["radis", "radish"], ["navet", "navets", "turnip", "rabioles"], ["fenouil", "fennel"], ["ail", "garlic"],
    ["gingembre", "ginger"], ["mais", "corn"], ["pois", "peas"], ["haricot", "haricots", "bean", "beans"], ["patate", "patates", "potato", "potatoes"],
    ["creme", "cream"], ["lait", "milk"], ["beurre", "butter"], ["oeuf", "oeufs", "egg", "eggs"], ["fromage", "cheese"], ["sucre", "sugar"],
    ["farine", "flour"], ["sel", "salt"], ["poivre", "pepper"], ["vinaigre", "vinegar"], ["huile", "oil"], ["miel", "honey"],
    ["poulet", "chicken"], ["boeuf", "beef"], ["porc", "pork"], ["canard", "duck"], ["agneau", "lamb"], ["jambon", "ham"], ["os", "carcasse", "bones"],
    ["omble", "char"], ["maquereau", "mackerel"], ["moules", "mussels"], ["crabe", "crab"], ["calamar", "calamars", "squid"],
    ["raisin", "raisins", "grape", "grapes"], ["cerise", "cerises", "cherry", "cherries"], ["bleuet", "bleuets", "blueberry"], ["fraise", "fraises", "strawberry"],
    ["melon", "melons"], ["courge", "squash"], ["endive", "endives"], ["radicchio"], ["shishito", "shishitos"], ["jalapeno"], ["habanero"], ["maitake", "maitakes"],
    ["anchois", "anchovy", "anchovies"], ["moutarde", "mustard"], ["laurier", "bay"], ["girofle", "clove", "cloves"], ["cannelle", "canelle", "cinnamon"],
    ["sesame"], ["muscade", "nutmeg"], ["paprika"], ["cumin"], ["cari", "curry"], ["riz", "rice"], ["papier", "paper"], ["sac", "sacs", "bag", "bags"]];
  const CANON = new Map();
  SAME.forEach((g) => g.forEach((w) => CANON.set(w, g[0])));
  const STOP = new Set(["de", "du", "la", "le", "les", "et", "en", "au", "aux", "a", "un", "une", "des", "sac", "caisse", "lbs", "lb", "kg", "unite", "unit", "bunch",
    "case", "cartons", "farm", "qc", "frais", "fresh", "x", "pc", "pcs", "gr", "lt", "ml", "the", "and", "of"]);
  function words(s) {
    // Words run together on some invoices ("1.5 kPoulet", "200 grCaille"): a capital after a small letter starts a new one.
    s = String(s == null ? "" : s).replace(/([a-zà-ÿ])([A-ZÀ-Ý])/g, "$1 $2");
    // Percentages count ("Lait 2%" is not 3.25% milk).
    const pct = (fold(s).match(/\d+(?:[.,]\d+)?\s*%/g) || []).map((x) => x.replace(/\s/g, "").replace(",", "."));
    return new Set(pct.concat(fold(s).split(/[^a-z-]+/).filter((w) => w.length >= 3 && !STOP.has(w))
      .flatMap((w) => [w, ...w.split("-")]).map((w) => CANON.get(w) || CANON.get(w.replace(/s$/, "")) || w.replace(/s$/, ""))));
  }
  const share = (a, b) => [...a].some((w) => b.has(w) || [...b].some((x) => x.length >= 5 && w.length >= 5 && x.slice(0, 5) === w.slice(0, 5)));
  const cents = (a, b) => Math.abs(a - b) < 0.005;

  // Weighed lines (per kg / per lb) compare against the ingredient's price per kg.
  const perKg = (l) => (/^(KG|KL)$/.test(l.uom) ? l.price : /^(LB|LV)$/.test(l.uom) ? l.price / 0.45359237 : null);

  /** How a line is billed, in words ("case", "bag", "unit", "lb"…): `weighed` when priced per kg or lb, `pack` when
   * one price covers a case, bag, box… that can hold several. */
  const BILLED = { CA: "case", CS: "case", PK: "pack", PQ: "pack", SC: "bag", SA: "bag", BG: "bag", BAG: "bag", CE: "cello bag",
    BX: "box", BO: "box", BT: "bottle", PA: "pail", UN: "unit", EA: "unit", DZ: "dozen", KG: "kg", KL: "kg", LB: "lb", LV: "lb" };
  function billedAs(l) {
    const word = l.sold || BILLED[l.uom] || String(l.uom || "").toLowerCase() || "unit";
    return { word, weighed: perKg(l) != null, pack: !/^(unit|kg|lb|dozen)$/.test(word) };
  }

  /** What one invoice "price" buys, from the uom and the pack written in the description:
   * "3 lb", "10 x 5 lb", "4x4LT", "3x1KG", "12/1LT", "16UN", "(sac - 50 lbs)", per kg / per lb… */
  function packOf(p, Units) {
    if (/^(KG|KL)$/.test(p.uom)) return { qty: 1, unit: "kg" };
    if (/^(LB|LV)$/.test(p.uom)) return { qty: 1, unit: "lb" };
    if (p.uom === "DZ") return { qty: 12, unit: "unit" };
    const text = (p.format ? p.format + " " : "") + p.item;
    // US gallons, as Multiplus sells vinegar and oil: "4x1GALLON" is 4 × 3.785 L (not 4 × 1 g).
    const gal = text.match(/(?:(\d+(?:[.,]\d+)?)\s*[x/]\s*)?(\d+(?:[.,]\d+)?)\s*(?:GALLONS?|GAL)\b/i);
    if (gal) return { qty: +((gal[1] ? num(gal[1]) : 1) * num(gal[2]) * 3.785411784).toFixed(3), unit: "L" };
    // Billed per piece: one piece, unless the description gives its weight or volume ("1L" of juice, "500GR").
    if (/^(UN|EA)$/.test(p.uom)) {
      const w = text.match(/(\d+(?:[.,]\d+)?)\s*(kg|g|gr|lbs?|l|lt|ml)(?=[A-Z\s(),]|$)/i);
      return w ? { qty: num(w[1]), unit: unitWord(w[2]) } : { qty: 1, unit: "unit" };
    }
    // "12 x 6 x 200 gr": every number counts.
    let m = text.match(/(\d+)\s*x\s*(\d+)\s*x\s*(\d+(?:[.,]\d+)?)\s*(kg|g|gr|lbs?|l|lt|ml)(?=[A-Z\s(),]|$)/i);
    if (m) { const u = unitWord(m[4]); return u ? { qty: num(m[1]) * num(m[2]) * num(m[3]), unit: u } : null; }
    m = text.match(/(\d+(?:[.,]\d+)?)\s*[x/]\s*(\d+(?:[.,]\d+)?)\s*(kg|g|gr|lbs?|l|lt|ml|un|rl)\b/i);
    if (m) { const u = unitWord(m[3]); return u ? { qty: num(m[1]) * num(m[2]), unit: u } : null; }
    // "24 unEGG": the product code follows the unit, so no word boundary. "8888 un" = size 88, 88 to a case.
    m = text.match(/(\d+(?:[.,]\d+)?)\s*(kg|g|gr|lbs?|l|lt|ml|un|ct|rl)(?=[A-Z\s(),]|$)/i);
    if (m) {
      const u = unitWord(m[2]); if (!u) return null;
      let q = m[1];
      if (u === "unit" && /^\d+$/.test(q) && q.length % 2 === 0 && q.slice(0, q.length / 2) === q.slice(q.length / 2)) q = q.slice(q.length / 2);
      return { qty: num(q), unit: u };
    }
    if (/\(unit[eé]\)|\(bunch\)|\bun[A-Z]|\(caisse\)/i.test(p.item) || /^\d+$/.test(p.format || "")) return { qty: /^\d+$/.test(p.format || "") ? +p.format : 1, unit: "unit" };
    return null;
  }
  const num = (s) => +String(s).replace(",", ".");
  function unitWord(w) {
    w = w.toLowerCase();
    return { kg: "kg", g: "g", gr: "g", lb: "lb", lbs: "lb", l: "L", lt: "L", ml: "ml", un: "unit", ct: "unit", rl: "unit" }[w] || null;
  }


  /** How a line is remembered on a supplier price ("name on invoice"): its description and pack as printed. */
  const lineKey = (l) => (l.item + (l.format ? " " + l.format : "")).trim().slice(0, 120);

  /** Which ingredient an invoice line is, and in what pack: a remembered name first, then the same price with a
   * shared word, then every word of the ingredient in the description. Returns null when nothing fits. */
  function suggest(line, supplier, data, Units) {
    const key = lineKey(line);
    const ingById = new Map(data.ingredients.map((i) => [i.id, i]));
    const pack = packOf(line, Units);
    const packFor = (i, o) => {
      const fits = (p) => p && Units.amountIn(p.qty, p.unit, i.base, +i.each_kg || 0) != null;
      if (fits(pack)) return pack;
      return o && fits({ qty: +o.pack_qty, unit: o.pack_unit }) ? { qty: +o.pack_qty, unit: o.pack_unit } : null;
    };
    // 1. Remembered: a price from this supplier saved under this exact description.
    const known = data.offers.find((o) => o.supplier === supplier && o.supplier_item === key && ingById.has(o.ingredient_id));
    if (known) { const i = ingById.get(known.ingredient_id); return { ingredient: i, offer: known, pack: packFor(i, known), how: "remembered" }; }
    const lw = words(line.item);
    // 2. Same price as one of the ingredient's prices (per pack, or per kg when weighed), and a shared word.
    for (const o of data.offers) {
      const i = ingById.get(o.ingredient_id);
      if (!i || !share(lw, words(i.name))) continue;
      if (Math.abs(line.price - +o.pack_cost) < 0.005) return { ingredient: i, offer: o, pack: packFor(i, o), how: "price" };
      const pk = perKg(line), kg = Units.convert(+o.pack_qty, o.pack_unit, "kg");
      if (pk != null && kg && Math.abs(pk - +o.pack_cost / kg) < 0.005) return { ingredient: i, offer: o, pack: packFor(i, o), how: "price" };
    }
    // 3. Every word of the ingredient's name in the description, and a pack that converts.
    const has = (x) => lw.has(x) || [...lw].some((y) => x.length >= 5 && y.length >= 5 && y.slice(0, 5) === x.slice(0, 5));
    const cands = data.ingredients.filter((i) => { const w = [...words(i.name)].filter((x) => !["sauce", "base", "frais", "entier", "whole"].includes(x)); return w.length && w.every(has) && packFor(i, null); })
      .sort((a, b) => words(b.name).size - words(a.name).size);
    if (cands.length && !(cands[1] && words(cands[1].name).size === words(cands[0].name).size)) {
      const i = cands[0];
      return { ingredient: i, offer: data.offers.find((o) => o.ingredient_id === i.id && o.supplier === supplier) || null, pack: packFor(i, null), how: "name" };
    }
    return null;
  }

  const api = { SUPPLIERS: SUPPLIERS.map((s) => s[0]), read, readers, words, share, perKg, billedAs, packOf, fold, lineKey, suggest };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Invoices = api;
})(typeof window !== "undefined" ? window : globalThis);
