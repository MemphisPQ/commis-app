/* A menu's own files, written from scratch (no template needed): the menu list as an Excel workbook (Kitchen, Front of
 * house and Preps tabs), the menu lists to print as Word documents (kitchen, front of house), and a plain recipe card
 * for when there's no card template (Commis, or no template picked yet).
 *
 * The menu, as app.js hands it over:
 *   { name, date, dishes: [{ name, category, price, cost, foodCost, target, allergens, contents: [{ name, amount }] }],
 *     preps: [{ name, makes, usedIn: [dish names] }] }
 *   price, cost and target are dollars (or null), foodCost a fraction (0.27) or null, allergens a sentence ("Contains
 *   milk. May contain sesame.") or "".
 * Also fills a front-of-house template (Menu Item Details) with one entry per dish.
 * Works in the browser (window.MenuFile, JSZip from cdnjs) and in Node (require, for the tests).
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
      s.onerror = () => { zipLib = null; fail(new Error("Couldn't load the file maker. Check your connection.")); };
      document.head.appendChild(s);
    });
    return zipLib;
  }
  const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const out = (zip, type) => zip.generateAsync({ type: isNode ? "nodebuffer" : "blob", compression: "DEFLATE", mimeType: type });
  const x = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    // Characters XML doesn't allow (stray control characters pasted from elsewhere).
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  const money = (n) => (n == null || !isFinite(n) ? "—" : "$" + (+n).toFixed(2));
  const pct = (f) => (f == null || !isFinite(f) ? "—" : Math.round(f * 100) + "%");
  // Items are joined with a middle dot: item names have commas in them ("Interior Round, Confit").
  const contentsText = (d, withAmounts) => d.contents.map((c) => (withAmounts && c.amount ? `${c.amount} ${c.name}` : c.name)).join(" · ");

  /* ---------- Excel ---------- */
  // Styles (cellXfs, by index): 0 plain, 1 heading row, 2 money, 3 percent, 4 wrapped text, 5 title, 6 small grey.
  const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/><numFmt numFmtId="165" formatCode="0%"/></numFmts>
<fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="16"/><name val="Calibri"/></font><font><sz val="10"/><color rgb="FF6A706C"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE6EFE9"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
</styleSheet>`;
  const col = (n) => { let s = ""; for (n++; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
  /** One cell: text, a number (with a style for money or percent), or nothing. */
  function cell(ref, v, style) {
    if (v == null || v === "") return "";
    const s = style ? ` s="${style}"` : "";
    if (typeof v === "number") return isFinite(v) ? `<c r="${ref}"${s}><v>${v}</v></c>` : "";
    return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${x(v)}</t></is></c>`;
  }
  /** A tab: a title, a grey line under it, a heading row (frozen, with filters), then the rows. */
  function sheetXml({ title, note, head, rows, widths, styles }) {
    const lines = [`<row r="1">${cell("A1", title, 5)}</row>`, `<row r="2">${cell("A2", note, 6)}</row>`,
      `<row r="3">${head.map((h, k) => cell(col(k) + 3, h, 1)).join("")}</row>`];
    rows.forEach((r, i) => { const n = i + 4; lines.push(`<row r="${n}">${r.map((v, k) => cell(col(k) + n, v, styles[k])).join("")}</row>`); });
    const last = col(head.length - 1) + (rows.length + 3);
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="3" topLeftCell="A4" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${widths.map((w, k) => `<col min="${k + 1}" max="${k + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>
<sheetData>${lines.join("")}</sheetData>
<autoFilter ref="A3:${last}"/>
</worksheet>`;
  }
  /** The menu list: Kitchen (prices, costs, what's in it with amounts), Front of house (price, what's in it), Preps. */
  async function menuXlsx(menu) {
    const JSZip = await loadZip();
    const zip = new JSZip();
    const note = `${menu.dishes.length} dishes, ${menu.preps.length} preps. Costs at today's prices, ${menu.date}.`;
    const tabs = [
      { name: "Kitchen", xml: sheetXml({ title: menu.name, note,
        head: ["Category", "Dish", "Menu price", "Cost / portion", "Food cost", "Target price", "Allergens", "What's in it"],
        rows: menu.dishes.map((d) => [d.category, d.name, d.price, d.cost, d.foodCost, d.target, d.allergens, contentsText(d, true)]),
        widths: [14, 30, 11, 13, 10, 12, 36, 80], styles: [4, 4, 2, 2, 3, 2, 4, 4] }) },
      { name: "Front of house", xml: sheetXml({ title: menu.name, note: `${menu.dishes.length} dishes.`,
        head: ["Category", "Dish", "Price", "Allergens", "What's in it"],
        rows: menu.dishes.map((d) => [d.category, d.name, d.price, d.allergens, contentsText(d, false)]),
        widths: [14, 30, 10, 36, 80], styles: [4, 4, 2, 4, 4] }) },
      { name: "Preps", xml: sheetXml({ title: menu.name, note: "The preps these dishes use (and the ones inside them).",
        head: ["Prep", "Makes", "Used in"], rows: menu.preps.map((p) => [p.name, p.makes, p.usedIn.join(", ")]),
        widths: [34, 18, 70], styles: [4, 4, 4] }) },
    ];
    zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${tabs.map((t, k) => `<Override PartName="/xl/worksheets/sheet${k + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`);
    zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
    zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>
${tabs.map((t, k) => `<sheet name="${x(t.name)}" sheetId="${k + 1}" r:id="rId${k + 1}"/>`).join("")}</sheets></workbook>`);
    zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${tabs.map((t, k) => `<Relationship Id="rId${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${k + 1}.xml"/>`).join("")}
<Relationship Id="rId${tabs.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
    zip.file("xl/styles.xml", STYLES);
    tabs.forEach((t, k) => zip.file(`xl/worksheets/sheet${k + 1}.xml`, t.xml));
    return out(zip, XLSX_TYPE);
  }

  /* ---------- Word ---------- */
  // Paragraph pieces: a run of text (bold, italic, grey, size in points), a right-aligned tab for prices.
  const run = (t, o = {}) => `<w:r><w:rPr>${o.b ? "<w:b/>" : ""}${o.i ? "<w:i/>" : ""}${o.grey ? '<w:color w:val="6A706C"/>' : ""}${o.size ? `<w:sz w:val="${o.size * 2}"/>` : ""}</w:rPr>${
    String(t).split("\t").map((part, k) => (k ? "<w:tab/>" : "") + `<w:t xml:space="preserve">${x(part)}</w:t>`).join("")}</w:r>`;
  const para = (runs, o = {}) => `<w:p><w:pPr>${o.style ? `<w:pStyle w:val="${o.style}"/>` : ""}${o.keep ? "<w:keepNext/>" : ""}${
    o.tabRight ? '<w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9026"/></w:tabs>' : ""}${o.after != null ? `<w:spacing w:after="${o.after}"/>` : ""}${o.list ? '<w:ind w:left="360" w:hanging="200"/>' : ""}</w:pPr>${[].concat(runs).join("")}</w:p>`;
  const DOC_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:spacing w:after="60"/></w:pPr><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:sz w:val="48"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="320" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:color w:val="1F5C4A"/><w:sz w:val="30"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="40"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
</w:styles>`;
  async function docxOf(body) {
    const JSZip = await loadZip();
    const zip = new JSZip();
    zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`);
    zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
    zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
    zip.file("word/styles.xml", DOC_STYLES);
    zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1440" w:bottom="1080" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`);
    return out(zip, DOCX_TYPE);
  }
  /** Dishes in their categories, in the order they come in. */
  function byCategory(dishes) {
    const groups = new Map();
    for (const d of dishes) { const c = d.category || "Other"; if (!groups.has(c)) groups.set(c, []); groups.get(c).push(d); }
    return [...groups];
  }
  /**
   * The menu list to print. "front": like a menu, dish and price with what's in it underneath. "kitchen": the same plus
   * cost, food cost and target, what's in it with amounts, and the preps.
   */
  async function menuDocx(menu, kind) {
    const kitchen = kind === "kitchen";
    const parts = [para(run(menu.name), { style: "Title" }),
      para(run(kitchen ? `Kitchen sheet · ${menu.dishes.length} dishes · costs at today's prices, ${menu.date}` : `${menu.dishes.length} dishes`, { grey: true, size: 10 }), { after: 200 })];
    for (const [cat, dishes] of byCategory(menu.dishes)) {
      parts.push(para(run(cat), { style: "Heading1" }));
      for (const d of dishes) {
        parts.push(para([run(d.name, { b: true }), run("\t" + (d.price == null ? "" : money(d.price)), { b: true })], { tabRight: true, keep: true, after: 20 }));
        const allergens = d.allergens ? para([run("Allergens: ", { b: true, size: 10 }), run(d.allergens, { size: 10 })], { keep: kitchen, after: kitchen ? 20 : 140 }) : "";
        if (kitchen) {
          parts.push(para(run(`Cost ${money(d.cost)} · food cost ${pct(d.foodCost)} · target ${money(d.target)}`, { grey: true, size: 10 }), { keep: true, after: 20 }));
          parts.push(allergens);
          d.contents.forEach((c, k) => parts.push(para(run(`${c.amount ? c.amount + "  " : ""}${c.name}`, { size: 10 }), { list: true, after: 0, keep: k < d.contents.length - 1 })));
          parts.push(para(run(""), { after: 60 }));
        } else {
          parts.push(para(run(contentsText(d, false), { i: true, grey: true }), { after: allergens ? 20 : 140, keep: !!allergens }));
          parts.push(allergens);
        }
      }
    }
    if (kitchen && menu.preps.length) {
      parts.push(para(run("Preps"), { style: "Heading1" }));
      for (const p of menu.preps) {
        parts.push(para([run(p.name, { b: true }), run(p.makes ? `  makes ${p.makes}` : "", { grey: true, size: 10 })], { after: 0, keep: true }));
        parts.push(para(run(`Used in: ${p.usedIn.join(", ")}`, { grey: true, size: 10 }), { after: 100 }));
      }
    }
    return docxOf(parts.join(""));
  }
  /** A plain recipe card (the card maker's fields), for when there's no card template. */
  async function cardDocx(card) {
    const list = (items, numbered) => items.map((t, k) => para(run(`${numbered ? k + 1 + ". " : "• "}${t}`), { list: true, after: 40 }));
    const parts = [para(run(`RECIPE “${card.name}”`), { style: "Title" }),
      para(run([card.readyIn ? `Ready in ${card.readyIn}` : "", card.yieldText ? `Yield: ${card.yieldText}` : ""].filter(Boolean).join("   ·   "), { grey: true }), { after: 200 }),
      para(run("Ingredients"), { style: "Heading2" }), ...list(card.ingredients, false)];
    if (card.steps.length) parts.push(para(run("Preparation"), { style: "Heading2" }), ...list(card.steps, true));
    if (card.notes.length) parts.push(para(run("Notes"), { style: "Heading2" }), ...card.notes.map((n) => para(run(n))));
    return docxOf(parts.join(""));
  }
  /* ---------- front-of-house details, from a template ---------- */
  // A template like "Menu Item Details": a title, then one entry (a Heading 1 and lines "Label: [placeholder]") that's
  // repeated for every dish. Item Name, Price, Ingredients and Allergens are filled in; any other line (Substitutions,
  // Tasting Notes, Optional Pairings…) is left empty to write in by hand. The template's other sample entries are dropped.
  const unx = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  const textOf = (xml) => (xml.match(/<w:t(?: [^>]*)?>[^<]*<\/w:t>/g) || []).map((t) => unx(t.replace(/<[^>]+>/g, ""))).join("");
  /** The paragraph or run with its text replaced: all of it in the first piece of text, the others emptied. */
  const setText = (xml, value) => { let first = true; return xml.replace(/<w:t(?: [^>]*)?>[^<]*<\/w:t>/g, () => {
    const t = first ? x(value) : ""; first = false; return `<w:t xml:space="preserve">${t}</w:t>`; }); };
  const DETAIL_FIELDS = [[/name/i, (d) => d.name], [/price/i, (d) => (d.price == null ? "" : money(d.price))],
    [/ingredient/i, (d) => contentsText(d, false)], [/allergen/i, (d) => d.allergens || ""]];
  function fillField(p, value) {
    let done = false;
    const filled = p.replace(/<w:r[ >][\s\S]*?<\/w:r>/g, (r) => {
      if (done || !/^\s*\[[^\]]*\]\s*$/.test(textOf(r))) return r;
      done = true;
      return setText(r, " " + value);
    });
    if (done || !value) return filled;
    // No [placeholder]: the value goes after the label.
    return p.replace(/<\/w:p>$/, `<w:r><w:t xml:space="preserve"> ${x(value)}</w:t></w:r></w:p>`);
  }
  function keepWithNext(p, keep) {
    if (!keep || /<w:keepNext\b/.test(p)) return p;
    if (/<w:pPr\/>/.test(p)) return p.replace(/<w:pPr\/>/, "<w:pPr><w:keepNext/></w:pPr>");
    if (!/<w:pPr>/.test(p)) return p.replace(/^<w:p\b[^>]*>/, (open) => open + "<w:pPr><w:keepNext/></w:pPr>");
    // keepNext comes right after the paragraph's style, if it has one.
    return /<w:pPr><w:pStyle [^>]*\/>/.test(p) ? p.replace(/(<w:pPr><w:pStyle [^>]*\/>)/, "$1<w:keepNext/>") : p.replace("<w:pPr>", "<w:pPr><w:keepNext/>");
  }
  async function itemDetailsDocx(template, menu) {
    const JSZip = await loadZip();
    const zip = await JSZip.loadAsync(template);
    const doc = await zip.file("word/document.xml").async("string");
    const start = doc.indexOf("<w:body>") + "<w:body>".length, end = doc.lastIndexOf("<w:sectPr");
    const paras = doc.slice(start, end).match(/<w:p[ >][\s\S]*?<\/w:p>/g) || [];
    const isEntry = (p) => /<w:pStyle w:val="Heading1"\/>/.test(p);
    const first = paras.findIndex(isEntry);
    if (first < 0) throw new Error("The menu item template has no entry (a Heading 1 for each item).");
    const next = paras.findIndex((p, k) => k > first && isEntry(p));
    // Copies of the entry would share bookmark names and paragraph ids, which Word wants unique: they're left out.
    // Each line keeps with the next, so an entry isn't split over two pages.
    const block = paras.slice(first, next < 0 ? paras.length : next);
    const entry = block.map((p, k) => keepWithNext(p.replace(/<w:bookmark(?:Start|End)\b[^>]*\/>/g, "").replace(/ w14:(?:paraId|textId)="[^"]*"/g, ""), k < block.length - 1));
    const top = paras.slice(0, first).map((p) => (/<w:pStyle w:val="Title"\/>/.test(p) ? setText(p, menu.name)
      : textOf(p).trim() ? setText(p, `Menu item details · ${menu.dishes.length} dishes · ${menu.date}`) : p));
    const items = menu.dishes.map((d, k) => entry.map((p) => {
      if (isEntry(p)) return setText(p, /\d+\s*$/.test(textOf(p)) ? textOf(p).replace(/\d+\s*$/, String(k + 1)) : textOf(p));
      const label = textOf(p).split(":")[0];
      if (!textOf(p).includes(":")) return p;
      const f = DETAIL_FIELDS.find(([re]) => re.test(label));
      return fillField(p, f ? f[1](d) : "");
    }).join(""));
    zip.file("word/document.xml", doc.slice(0, start) + top.join("") + items.join("") + doc.slice(end));
    return out(zip, DOCX_TYPE);
  }

  /** A name that's safe as a file or folder name everywhere. */
  const fileName = (s) => String(s || "untitled").replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 100) || "untitled";

  const api = { menuXlsx, menuDocx, cardDocx, itemDetailsDocx, fileName, loadZip, XLSX_TYPE, DOCX_TYPE };
  if (isNode) module.exports = api;
  else root.MenuFile = api;
})(typeof window !== "undefined" ? window : globalThis);
