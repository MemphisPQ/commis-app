/* Dish costing workbooks made from your own costing template ("_ A Recipe Cost Template"): the same file you send
 * out, with its tabs (Total Cost, Recipe 1–6, Recipe Template, Ingredients), formulas and formatting.
 *
 * What's filled in:
 *   Total Cost    A1 the dish, B2 its notes, its ingredients just above the preps (from row 20, as in your sheets;
 *                 name in A, amount in B, the template's own lookups give unit, price and supplier), rows 23–28
 *                 its preps (amount in B, blank for one portion; name and cost come from the prep's Recipe tab),
 *                 G30 what it makes.
 *   Recipe 1–6    one prep each, the same way (rows 4–28). A prep used inside a prep points at its own tab.
 *   Ingredients   the ingredients this dish uses, with today's prices, instead of the live link to Master Data.
 * Two fixes so the numbers hold up in Excel too: the lookups reach the last ingredient row (Google saves them as
 * stopping at row 33), and Excel recalculates everything when the file opens. Every cell also carries its value,
 * so a preview that doesn't calculate still shows the right numbers.
 * Works in the browser (window.SheetFill, JSZip from cdnjs) and in Node (require, for the tests).
 */
(function (root) {
  const isNode = typeof module !== "undefined" && module.exports;
  const JSZIP = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
  let zipLib = null;
  function loadZip() {
    if (isNode) return Promise.resolve(require("jszip"));
    if (window.JSZip) return Promise.resolve(window.JSZip);
    zipLib = zipLib || new Promise((ok, fail) => {
      const s = document.createElement("script");
      s.src = JSZIP;
      s.onload = () => ok(window.JSZip);
      s.onerror = () => { zipLib = null; fail(new Error("Couldn't load the spreadsheet maker. Check your connection.")); };
      document.head.appendChild(s);
    });
    return zipLib;
  }

  const ROWS = { first: 4, dishLast: 22, prepFirst: 23, tabLast: 28 }; // the template's item rows
  const TABS = 6;
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([\w:]+)="([^"]*)"/g)].map((m) => [m[1], unesc(m[2])]));
  const colNum = (ref) => ref.replace(/\d+/g, "").split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  const round2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;
  const isNum = (v) => typeof v === "number" && isFinite(v);

  /** One cell: a formula with its value, or just a value (number, text, or empty). Keeps the template's look (s). */
  function cellXml(ref, s, { f, v }) {
    const st = s != null ? ` s="${s}"` : "";
    if (f != null) {
      const text = typeof v === "string";
      const val = text ? `<v>${esc(v)}</v>` : isNum(v) ? `<v>${v}</v>` : "";
      return `<c r="${ref}"${st}${text ? ' t="str"' : ""}><f>${esc(f)}</f>${val}</c>`;
    }
    if (isNum(v)) return `<c r="${ref}"${st}><v>${v}</v></c>`;
    if (v == null || v === "") return `<c r="${ref}"${st}/>`;
    return `<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
  }

  /** A worksheet's XML, edited cell by cell. */
  class Sheet {
    constructor(xml) { this.xml = xml; }
    find(ref) {
      const m = new RegExp(`<c r="${ref}"(?=[\\s>/])[^>]*?(?:/>|>[\\s\\S]*?</c>)`).exec(this.xml);
      if (!m) return null;
      const open = m[0].match(/^<c[^>]*?\/?>/)[0];
      const f = m[0].match(/<f>([\s\S]*?)<\/f>/);
      const v = m[0].match(/<v>([\s\S]*?)<\/v>/);
      return { index: m.index, xml: m[0], s: attrs(open).s, f: f ? unesc(f[1]) : null, v: v ? unesc(v[1]) : null };
    }
    formula(ref) { const c = this.find(ref); return c && c.f; }
    number(ref) { const c = this.find(ref); return c && c.v != null && c.v !== "" && isFinite(+c.v) ? +c.v : null; }
    set(ref, cell) {
      const c = this.find(ref);
      if (c) { this.xml = this.xml.slice(0, c.index) + cellXml(ref, c.s, cell) + this.xml.slice(c.index + c.xml.length); return; }
      // Not in the template: add it in its row, in column order.
      const row = +ref.replace(/\D+/g, "");
      const rowRe = new RegExp(`<row r="${row}"(?=[\\s>/])[^>]*?(?:/>|>([\\s\\S]*?)</row>)`);
      const rm = rowRe.exec(this.xml);
      if (!rm) {
        const after = [...this.xml.matchAll(/<row r="(\d+)"/g)].find((x) => +x[1] > row);
        const at = after ? after.index : this.xml.indexOf("</sheetData>");
        this.xml = this.xml.slice(0, at) + `<row r="${row}">${cellXml(ref, null, cell)}</row>` + this.xml.slice(at);
        return;
      }
      const open = rm[0].match(/^<row[^>]*?\/?>/)[0].replace(/\/>$/, ">");
      const cells = rm[1] || "";
      const next = [...cells.matchAll(/<c r="([A-Z]+\d+)"/g)].find((x) => colNum(x[1]) > colNum(ref));
      const body = next ? cells.slice(0, next.index) + cellXml(ref, null, cell) + cells.slice(next.index) : cells + cellXml(ref, null, cell);
      this.xml = this.xml.slice(0, rm.index) + `${open}${body}</row>` + this.xml.slice(rm.index + rm[0].length);
    }
    /** Same formula as in the template, with a new value. */
    keep(ref, v) { this.set(ref, { f: this.formula(ref), v }); }
  }

  /** Fills the template. book: {
   *    dish: { name, notes, yieldQty, multiplier, items, preps },
   *    tabs: [{ name, notes, yieldQty, items, preps }],          // Recipe 1, 2… in order
   *    ingredients: [{ category, name, supplier, cost, volume, unit, yield, price }] }
   *  items: [{ name, qty, unit, price, supplier, own }]  own = priced from another supplier than the Ingredients tab
   *  preps: [{ tab, qty, locked }]                      tab = 1-based Recipe tab number; locked = its locked cost, if any */
  async function xlsx(templateBytes, book) {
    const JSZip = await loadZip();
    const zip = await JSZip.loadAsync(templateBytes, { createFolders: false });
    const read = (p) => { const f = zip.file(p); if (!f) throw new Error("The costing template isn't laid out like “_ A Recipe Cost Template” (missing " + p + ")."); return f.async("string"); };
    const write = (p, s) => zip.file(p, s, { createFolders: false });
    let wb = await read("xl/workbook.xml");
    const rels = await read("xl/_rels/workbook.xml.rels");
    const targets = Object.fromEntries([...rels.matchAll(/<Relationship [^>]*>/g)].map((m) => attrs(m[0])).map((a) => [a.Id, a.Target]));
    const sheetsByName = {};
    for (const m of wb.matchAll(/<sheet [^>]*\/>/g)) {
      const a = attrs(m[0]);
      sheetsByName[a.name] = { path: "xl/" + targets[a["r:id"]].replace(/^\/?xl\//, ""), index: Object.keys(sheetsByName).length };
    }
    const need = ["Total Cost", ...Array.from({ length: TABS }, (_, k) => `Recipe ${k + 1}`), "Ingredients"];
    const missing = need.filter((n) => !sheetsByName[n]);
    if (missing.length) throw new Error(`The costing template has no ${missing.map((n) => `“${n}”`).join(", ")} tab. Pick your “_ A Recipe Cost Template” in Settings.`);
    if (book.dish.items.length > ROWS.dishLast - ROWS.first + 1) throw new Error(`This dish has ${book.dish.items.length} ingredients; the Total Cost tab has room for ${ROWS.dishLast - ROWS.first + 1}.`);
    if (book.tabs.length > TABS) throw new Error(`This dish uses ${book.tabs.length} preps (counting the preps inside its preps); the costing template has room for ${TABS} (Recipe 1–${TABS}).`);
    for (const t of book.tabs) if (t.items.length + t.preps.length > ROWS.tabLast - ROWS.first + 1) throw new Error(`“${t.name}” has ${t.items.length + t.preps.length} lines; a Recipe tab has room for ${ROWS.tabLast - ROWS.first + 1}.`);

    // Ingredients: the dish's ingredients, then every lookup reaches the last of them.
    const last = Math.max(3, book.ingredients.length + 2);
    const range = (a, b) => `Ingredients!$${a}$3:$${b}$${last}`;
    const fixRanges = (xml) => xml.replace(/Ingredients!\$([A-Z])\$3:\$([A-Z])\$?\d+/g, (m, a, b) => range(a, b));
    const ingPath = sheetsByName.Ingredients.path;
    let ing = await read(ingPath);
    const data = ing.match(/<sheetData>([\s\S]*?)<\/sheetData>/);
    const rowXml = (r) => (data[1].match(new RegExp(`<row r="${r}"(?=[\\s>/])[^>]*?(?:/>|>[\\s\\S]*?</row>)`)) || [""])[0];
    const head = rowXml(1) + rowXml(2);
    const model = rowXml(3);
    const rowOpen = (model.match(/^<row[^>]*?>/) || ['<row r="3">'])[0];
    const styleOf = (col) => { const m = model.match(new RegExp(`<c r="${col}3"[^>]*?s="(\\d+)"`)); return m ? m[1] : null; };
    const rows = book.ingredients.map((x, k) => {
      const n = k + 3;
      const cells = [["A", x.category], ["B", x.name], ["C", x.supplier || ""], ["D", x.cost], ["E", x.volume], ["F", x.unit], ["G", x.yield]]
        .map(([c, v]) => cellXml(c + n, styleOf(c), { v: v == null ? "" : v }));
      // Price /unit worked out like the Master Data sheet: cost ÷ (volume × yield), to the cent.
      cells.push(cellXml("H" + n, styleOf("H"), { f: `IFERROR(ROUND(D${n}/(E${n}*G${n}), 2), "")`, v: isNum(x.price) ? x.price : "" }));
      return rowOpen.replace(/r="\d+"/, `r="${n}"`) + cells.join("") + "</row>";
    });
    ing = ing.slice(0, data.index) + `<sheetData>${head}${rows.join("")}</sheetData>` + ing.slice(data.index + data[0].length);
    // Its drop-down lists were for typing by hand (and don't list every supplier): the rows now come from the app.
    ing = ing.replace(/<dataValidations[\s\S]*?<\/dataValidations>/, "").replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:H${last}"/>`);
    write(ingPath, ing);
    const ingRels = zip.file(ingPath.replace(/([^/]+)$/, "_rels/$1.rels"));
    if (ingRels) {
      for (const m of (await ingRels.async("string")).matchAll(/<Relationship [^>]*>/g)) {
        const a = attrs(m[0]);
        if (!/\/table$/.test(a.Type)) continue;
        const p = ("xl/worksheets/" + a.Target).replace(/[^/]+\/\.\.\//g, "");
        const t = zip.file(p) && (await zip.file(p).async("string"));
        if (t) write(p, t.replace(/ref="A2:H\d+"/g, `ref="A2:H${last}"`).replace(/ref="\$A\$2:\$H\$\d+"/g, `ref="$A$2:$H$${last}"`));
      }
    }
    wb = wb.replace(/(_xlnm\._FilterDatabase">Ingredients!\$A\$2:\$H\$)\d+/, `$1${last}`)
      .replace(/<calcPr[^>]*\/>|<calcPr[\s\S]*?<\/calcPr>/, '<calcPr fullCalcOnLoad="1"/>');
    if (!/<calcPr/.test(wb)) wb = wb.replace("</workbook>", '<calcPr fullCalcOnLoad="1"/></workbook>');
    write("xl/workbook.xml", wb);

    const byName = new Map(book.ingredients.map((x) => [x.name, x]));
    const perYield = {}; // Recipe tab number -> its Cost /Portion (G31)
    const prepName = {};

    /** One costing tab: title, notes, item rows, prep rows, yield and the totals' values. Item rows it doesn't use are
     * emptied (the template keeps a sample line or two), their formulas staying in place. */
    async function fill(sheetName, r, prepRow, lastItemRow, firstItem = ROWS.first) {
      const path = sheetsByName[sheetName].path;
      const s = new Sheet(fixRanges(await read(path)));
      s.set("A1", { v: r.name });
      s.set("B2", { v: r.notes || "" });
      let total = 0;
      const usedRows = new Set();
      r.items.forEach((it, k) => {
        const n = firstItem + k;
        usedRows.add(n);
        const x = byName.get(it.name);
        const unit = x ? x.unit : "", price = it.own ? it.price : x ? x.price : null, supplier = it.own ? it.supplier : x ? x.supplier || "" : "";
        s.set("A" + n, { v: it.name });
        s.set("B" + n, { v: isNum(it.qty) ? it.qty : "" });
        s.set("C" + n, { f: `IFERROR(VLOOKUP($A${n}, ${range("B", "H")}, 5, FALSE), "")`, v: unit });
        s.set("D" + n, { f: `IFERROR(VLOOKUP($A${n}, ${range("B", "H")}, 5, FALSE), "")`, v: unit });
        // A line priced from another supplier than the usual one keeps its own price and supplier.
        s.set("E" + n, it.own ? { v: isNum(price) ? price : "" } : { f: `IFERROR(VLOOKUP($A${n}, ${range("B", "H")}, 7, FALSE), "")`, v: isNum(price) ? price : "" });
        const cost = isNum(price) ? round2((isNum(it.qty) ? it.qty : 0) * price) : "";
        s.set("F" + n, { f: `IFERROR(ROUND(B${n}*E${n}, 2), "")`, v: cost });
        s.set("G" + n, it.own ? { v: supplier } : { f: `IFERROR(VLOOKUP($A${n}, ${range("B", "H")}, 2, FALSE), "")`, v: supplier });
        if (isNum(cost)) total += cost;
      });
      r.preps.forEach((p, k) => {
        const n = prepRow(p, k);
        usedRows.add(n);
        // A locked prep counts at its locked cost, written as a number instead of its tab's Cost /Portion.
        const e = isNum(p.locked) ? p.locked : perYield[p.tab] || 0;
        // One portion (or one of whatever it makes) is left blank, as in your sheets: the row then counts it once.
        const qty = isNum(p.qty) && p.qty !== 1 ? p.qty : "";
        const cost = qty === "" ? e : round2(qty * e);
        s.set("A" + n, { f: `'Recipe ${p.tab}'!$A$1`, v: prepName[p.tab] });
        s.set("B" + n, { v: qty });
        // The template's lookups on these rows stay (they find nothing for a prep's name).
        const x = byName.get(prepName[p.tab]);
        for (const [c, v] of [["C", x ? x.unit : ""], ["D", x ? x.unit : ""], ["G", x ? x.supplier || "" : ""]]) {
          const f = s.formula(c + n);
          s.set(c + n, f ? { f, v } : { v: "" });
        }
        s.set("E" + n, isNum(p.locked) ? { v: e } : { f: `'Recipe ${p.tab}'!$G$31`, v: e });
        s.set("F" + n, { f: `IF(B${n}="", E${n}, ROUND(B${n}*E${n}, 2))`, v: cost });
        total += cost;
      });
      for (let n = ROWS.first; n <= lastItemRow; n++) {
        if (usedRows.has(n)) continue;
        s.set("A" + n, { v: "" });
        s.set("B" + n, { v: "" });
        for (const c of ["C", "D", "E", "F", "G"]) { const f = s.formula(c + n); s.set(c + n, f ? { f, v: "" } : { v: "" }); }
      }
      const y = isNum(r.yieldQty) && r.yieldQty > 0 ? r.yieldQty : 1;
      s.set("G30", { v: y });
      const per = total / y;
      s.keep("G29", total);
      s.keep("G31", per);
      // Min Sale Price: the template's ×4, or this dish's own multiplier.
      const mult = isNum(r.multiplier) && r.multiplier > 0 ? r.multiplier : 4;
      const g32 = s.formula("G32") || "G31*4";
      s.set("G32", { f: mult === 4 ? g32 : g32.replace(/\*\s*[\d.]+\s*$/, "*" + mult), v: per * mult });
      const test = s.number("F33");
      const g33 = s.formula("G33");
      if (g33 && isNum(test)) s.keep("G33", (/G29/.test(g33) ? total : per) * test);
      write(path, s.xml);
      return per;
    }

    // A prep's tab is filled before the tabs that use it (its Cost /Portion feeds theirs). Recipe tabs this dish
    // doesn't need are left empty, as in the template, so they add nothing.
    const tabData = (k) => book.tabs[k - 1] || { name: `Recipe ${k}`, notes: "", yieldQty: 1, items: [], preps: [] };
    const done = new Set();
    async function tab(k) {
      if (done.has(k)) return;
      done.add(k);
      const t = tabData(k);
      for (const p of t.preps) await tab(p.tab);
      prepName[k] = t.name;
      perYield[k] = await fill(`Recipe ${k}`, t, (p, j) => ROWS.first + t.items.length + j, ROWS.tabLast);
    }
    for (let k = 1; k <= TABS; k++) await tab(k);
    // On Total Cost, Recipe n always sits on row 22 + n. A prep only used inside another prep counts 0 there;
    // an empty tab costs 0 anyway.
    const direct = new Map(book.dish.preps.map((p) => [p.tab, p]));
    const dishPreps = Array.from({ length: TABS }, (_, k) => direct.get(k + 1) || { tab: k + 1, qty: k < book.tabs.length ? 0 : null });
    // The dish's own ingredients sit just above its preps, from row 20, as in your sheets (more than three go up from there).
    const dishFirst = Math.min(20, ROWS.dishLast + 1 - book.dish.items.length);
    await fill("Total Cost", { ...book.dish, preps: dishPreps }, (p) => ROWS.prepFirst + p.tab - 1, ROWS.dishLast, dishFirst);
    const tpl = sheetsByName["Recipe Template"];
    if (tpl) write(tpl.path, fixRanges(await read(tpl.path)));

    return zip.generateAsync({ type: isNode ? "nodebuffer" : "blob", compression: "DEFLATE", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }

  const api = { xlsx, Sheet };
  if (isNode) module.exports = api;
  else root.SheetFill = api;
})(typeof window !== "undefined" ? window : globalThis);
