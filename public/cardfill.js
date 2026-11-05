/* Recipe cards made from your own template (the "AA Recipe Template" Word/Google Doc), not a look-alike.
 *
 * The template file is opened as it is and only these parts are changed; fonts, columns, headings, the
 * numbered lists and anything else in it stay exactly as in the template:
 *   RECIPE “…”                     the name between the quotes in the title
 *   Ready in …                     what follows "Ready in"
 *   Yield: …                       what follows "Yield:"
 *   Ingredients / Preparation / Notes   the lines under each heading, one per line, each written like the
 *                                  template's first line there (its numbered list for ingredients and steps).
 * Works in the browser (window.CardFill, JSZip from cdnjs) and in Node (require, for the tests).
 */
(function (root) {
  const isNode = typeof module !== "undefined" && module.exports;
  const JSZIP = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
  let zipLib = null;
  function loadZip() {
    if (isNode) return Promise.resolve(require("jszip"));
    zipLib = zipLib || new Promise((ok, fail) => {
      const s = document.createElement("script");
      s.src = JSZIP;
      s.onload = () => ok(window.JSZip);
      s.onerror = () => { zipLib = null; fail(new Error("Couldn't load the card maker. Check your connection.")); };
      document.head.appendChild(s);
    });
    return zipLib;
  }

  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  const T = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
  const textOf = (xml) => [...xml.matchAll(T)].map((m) => unesc(m[1])).join("");
  const RUN = /<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g;
  const hasText = (run) => /<w:t[\s>]/.test(run);

  /** The body's top-level pieces in order: paragraphs, tables, the page setup, and whatever sits between. */
  function pieces(body) {
    const out = [];
    const re = /<(\/?)(w:p|w:tbl|w:sdt|w:sectPr)(?=[\s>/])[^>]*?(\/?)>/g;
    let depth = 0, start = 0, name = null, m;
    while ((m = re.exec(body))) {
      const [tag, close, n, self] = m;
      if (depth === 0) {
        if (close) continue;
        if (m.index > start) out.push({ xml: body.slice(start, m.index) });
        if (self) { out.push({ xml: tag, name: n }); start = re.lastIndex; continue; }
        start = m.index; name = n; depth = 1;
        continue;
      }
      if (n !== name) continue;
      if (close) depth--; else if (!self) depth++;
      if (depth === 0) { out.push({ xml: body.slice(start, re.lastIndex), name }); start = re.lastIndex; }
    }
    if (start < body.length) out.push({ xml: body.slice(start) });
    for (const p of out) if (p.name === "w:p") {
      p.text = textOf(p.xml);
      p.style = (p.xml.match(/<w:pStyle w:val="([^"]+)"/) || [])[1] || "";
      p.list = /<w:numPr>/.test(p.xml);
    }
    return out;
  }

  /** The paragraph again with one line of text, in the style of its first run (no bookmarks or ids copied). */
  function withText(p, text) {
    const open = p.match(/^<w:p(?:\s[^>]*)?>/)[0].replace(/\s+w14:(paraId|textId)="[^"]*"/g, "");
    const pPr = (p.match(/<w:pPr>[\s\S]*?<\/w:pPr>/) || [""])[0];
    const run = (p.match(RUN) || []).find(hasText);
    const rPr = run ? (run.match(/<w:rPr>[\s\S]*?<\/w:rPr>/) || [""])[0] : "";
    return `${open}${pPr}<w:r>${rPr}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
  }

  const setRunText = (run, text) => {
    let first = true;
    // The first text in the run gets it all; any other text in the same run is emptied.
    return run.replace(T, (all) => { const v = first ? esc(text) : ""; first = false; return all.replace(/>[^<]*<\/w:t>$/, `>${v}</w:t>`).replace(/^<w:t(?![^>]*xml:space)/, '<w:t xml:space="preserve"'); });
  };

  /** "Ready in 4.5 - 12 hrs" -> "Ready in 6 hrs": keeps the label (and its run's look), puts the value in the
   * run that held the old value (bold in the template), or after the label when there's none. */
  function setAfterLabel(p, label, value) {
    const runs = [...p.matchAll(RUN)].filter((m) => hasText(m[0]));
    const k = runs.findIndex((m) => textOf(m[0]).includes(label));
    if (k < 0) return p;
    const own = textOf(runs[k][0]);
    const cut = own.indexOf(label) + label.length;
    const space = (own.slice(cut).match(/^\s*/) || [""])[0];
    const later = runs.slice(k + 1);
    const edits = [[runs[k], own.slice(0, cut) + (later.length ? space : (space || " ") + value)]];
    later.forEach((m, j) => edits.push([m, j === 0 ? value : ""]));
    let out = p;
    for (const [m, text] of edits.sort((a, b) => b[0].index - a[0].index)) out = out.slice(0, m.index) + setRunText(m[0], text) + out.slice(m.index + m[0].length);
    return out;
  }

  const SECTIONS = { ingredients: "ingredients", preparation: "steps", notes: "notes" };
  const isHeading = (x) => x.name === "w:p" && (/^Heading/i.test(x.style) || x.text.trim().toLowerCase() in SECTIONS);

  /** Fills word/document.xml. card: { name, readyIn, yieldText, ingredients: [], steps: [], notes: [] } */
  function fillXml(xml, card) {
    const a = xml.indexOf("<w:body>") + "<w:body>".length, b = xml.lastIndexOf("</w:body>");
    const list = pieces(xml.slice(a, b));
    const title = list.find((x) => x.name === "w:p" && x.style === "Title") || list.find((x) => x.name === "w:p" && /“[^”]*”/.test(x.text));
    if (title) {
      const quoted = title.xml.replace(/(<w:t(?:\s[^>]*)?>[^<]*“)[^<]*(”[^<]*<\/w:t>)/, `$1${esc(card.name)}$2`);
      if (quoted !== title.xml) title.xml = quoted;
      else {
        // No quotes in one piece: the title's last text becomes “name”.
        const runs = [...title.xml.matchAll(RUN)].filter((m) => hasText(m[0]));
        const last = runs[runs.length - 1];
        if (last) title.xml = title.xml.slice(0, last.index) + setRunText(last[0], `“${card.name}”`) + title.xml.slice(last.index + last[0].length);
      }
    }
    for (const x of list) {
      if (x.name !== "w:p") continue;
      if (/^\s*Ready in/i.test(x.text)) x.xml = setAfterLabel(x.xml, x.text.match(/Ready in/i)[0], card.readyIn || "");
      else if (/^\s*Yield\s*:/i.test(x.text)) x.xml = setAfterLabel(x.xml, x.text.match(/Yield\s*:/i)[0], card.yieldText || "");
    }
    // Each section: what's under its heading, up to the next heading or the page setup.
    for (let i = 0; i < list.length; i++) {
      const key = list[i].name === "w:p" && SECTIONS[list[i].text.trim().toLowerCase()];
      if (!key) continue;
      let j = i + 1;
      while (j < list.length && !isHeading(list[j]) && list[j].name !== "w:sectPr") j++;
      const under = list.slice(i + 1, j).filter((x) => x.name === "w:p");
      const model = (key === "notes" ? under[0] : under.find((x) => x.list) || under[0]) || null;
      const lines = (card[key] || []).length ? card[key] : [""];
      const made = model ? lines.map((t) => ({ xml: withText(model.xml, t), name: "w:p" })) : [];
      // Keep tables or anything that isn't a paragraph; the paragraphs are replaced by the filled lines.
      const keep = list.slice(i + 1, j).filter((x) => x.name !== "w:p" && x.name);
      list.splice(i + 1, j - i - 1, ...made, ...keep);
      i += made.length + keep.length;
    }
    return xml.slice(0, a) + list.map((x) => x.xml).join("") + xml.slice(b);
  }

  /** The template's Word bytes in, the filled card's Word bytes out. */
  async function docx(templateBytes, card) {
    const JSZip = await loadZip();
    const zip = await JSZip.loadAsync(templateBytes, { createFolders: false });
    const f = zip.file("word/document.xml");
    if (!f) throw new Error("The recipe card template isn't a Word document or Google Doc.");
    zip.file("word/document.xml", fillXml(await f.async("string"), card), { createFolders: false });
    return zip.generateAsync({ type: isNode ? "nodebuffer" : "arraybuffer", compression: "DEFLATE", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  }

  const api = { fillXml, docx, pieces };
  if (isNode) module.exports = api;
  else root.CardFill = api;
})(typeof window !== "undefined" ? window : globalThis);
