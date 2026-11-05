const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// google.js runs in the browser: here it gets a stand-in for Google's sign-in and for a Google Sheets spreadsheet,
// which keeps its tabs and every change asked of it.
function setup(tabs) {
  const sheet = { tabs: tabs.map((t) => ({ ...t, gridProperties: { rowCount: 1000, columnCount: 26, ...t.gridProperties } })), batches: [], writes: [] };
  const json = (body) => ({ ok: true, status: 200, json: async () => body });
  async function fetch(url, { method = "GET", body } = {}) {
    const u = new URL(url), p = decodeURIComponent(u.pathname);
    if (p.endsWith(":batchUpdate")) {
      const { requests } = JSON.parse(body);
      sheet.batches.push(requests);
      const replies = requests.map((r) => {
        if (r.duplicateSheet) {
          const d = r.duplicateSheet, src = sheet.tabs.find((t) => t.sheetId === d.sourceSheetId);
          sheet.tabs.forEach((t) => { if (t.index >= d.insertSheetIndex) t.index++; });
          sheet.tabs.push({ sheetId: d.newSheetId, title: d.newSheetName, index: d.insertSheetIndex, gridProperties: { ...src.gridProperties } });
        }
        if (r.addSheet) sheet.tabs.push({ sheetId: 999, ...r.addSheet.properties, gridProperties: { rowCount: 1000, columnCount: 26 } });
        return {};
      });
      return json({ replies });
    }
    const values = p.match(/\/values\/(.+?)(:clear|!A1)?$/);
    if (values) {
      if (method === "GET") return json({ values: sheet.columnA.map((v) => (v ? [v] : [])) });
      sheet.writes.push({ range: values[1], what: values[2] || "", body: body && JSON.parse(body) });
      return json({});
    }
    if (u.searchParams.get("ranges")) return json({ sheets: [{ data: [{ rowMetadata: [{ pixelSize: 21 }, { pixelSize: 30 }, { pixelSize: 30 }, { pixelSize: 21 }], columnMetadata: [{ pixelSize: 120 }, { pixelSize: 200 }] }] }] });
    return json({ sheets: sheet.tabs.map((t) => ({ properties: t })) });
  }
  const window = {
    COSTING_CONFIG: { googleClientId: "id", googleApiKey: "key", googleProjectNumber: "1" },
    gapi: { load: (name, ok) => ok() },
    google: { accounts: { oauth2: { initTokenClient: (o) => ({ requestAccessToken: () => o.callback({ access_token: "token", expires_in: 3600 }) }) } } },
  };
  const document = { createElement: () => ({}), head: { appendChild: (s) => setTimeout(s.onload, 0) } };
  const ctx = vm.createContext({ window, document, fetch, URL, setTimeout, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/google.js"), "utf8"), ctx);
  return { GDrive: vm.runInContext("GDrive", ctx), sheet };
}

const SEPT = { sheetId: 11, title: "Septembre 2026", index: 0, gridProperties: { rowCount: 1184, columnCount: 10, frozenRowCount: 2 } };
const ROWS = [[], ["Category", "Item"], ["Epices", "Cumin"], [], ["Category", "Total Cost"], ["Epices", "=1"], ["Grand Total", "=2"]];
const LOOKS = [{ from: 438, to: [3, 438] }, { from: 2, to: [2, 3] }, { from: 420, to: [4, 5] }];

test("a new month's tab is a copy of last month's, filled in, with rows given their look", async () => {
  const { GDrive, sheet } = setup([SEPT]);
  await GDrive.connect();
  await GDrive.writeTabLike("abc", "Octobre 2026", ROWS, "Septembre 2026", LOOKS);
  const [dup] = sheet.batches[0];
  assert.equal(dup.duplicateSheet.sourceSheetId, 11);
  assert.equal(dup.duplicateSheet.newSheetName, "Octobre 2026");
  assert.equal(dup.duplicateSheet.insertSheetIndex, 0);
  const id = dup.duplicateSheet.newSheetId;
  assert.ok(id > 0 && id !== 11);
  // Its old values go, then this month's go in (formats stay).
  assert.deepEqual(sheet.writes.map((w) => [w.range, w.what]), [["'Octobre 2026'", ":clear"], ["'Octobre 2026'", "!A1"]]);
  assert.deepEqual(sheet.writes[1].body.values, ROWS);
  // Row looks: from last month's tab onto the new one, in the order given.
  const pastes = sheet.batches[1].map((r) => r.copyPaste);
  assert.deepEqual(pastes.map((c) => [c.source.sheetId, c.source.startRowIndex, c.source.endRowIndex, c.destination.sheetId, c.destination.startRowIndex, c.destination.endRowIndex, c.pasteType]),
    [[11, 438, 439, id, 3, 438, "PASTE_FORMAT"], [11, 2, 3, id, 2, 3, "PASTE_FORMAT"], [11, 420, 421, id, 4, 5, "PASTE_FORMAT"]]);
  assert.equal(pastes[0].destination.endColumnIndex, 10);
  assert.equal(sheet.batches.length, 2);
});

test("a month sent before keeps its tab (formulas may point at it) and takes on last month's look", async () => {
  const OCT = { sheetId: 22, title: "Octobre 2026", index: 0, gridProperties: { rowCount: 1000, columnCount: 26 } };
  const { GDrive, sheet } = setup([OCT, { ...SEPT, index: 1 }]);
  await GDrive.connect();
  await GDrive.writeTabLike("abc", "Octobre 2026", ROWS, "Septembre 2026", LOOKS);
  const look = sheet.batches[0];
  assert.ok(!look.some((r) => r.duplicateSheet || r.deleteSheet), "no copy, nothing deleted");
  assert.deepEqual(look[0], { appendDimension: { sheetId: 22, dimension: "ROWS", length: 184 } });
  assert.equal(look[1].copyPaste.pasteType, "PASTE_FORMAT");
  assert.deepEqual([look[1].copyPaste.source.sheetId, look[1].copyPaste.destination.sheetId, look[1].copyPaste.destination.endRowIndex], [11, 22, 1184]);
  // Row heights and column widths, a run of same sizes at a time, then the frozen rows.
  const sizes = look.filter((r) => r.updateDimensionProperties).map((r) => { const d = r.updateDimensionProperties; return [d.range.dimension, d.range.startIndex, d.range.endIndex, d.properties.pixelSize]; });
  assert.deepEqual(sizes, [["ROWS", 0, 1, 21], ["ROWS", 1, 3, 30], ["ROWS", 3, 4, 21], ["COLUMNS", 0, 1, 120], ["COLUMNS", 1, 2, 200]]);
  assert.equal(look.at(-1).updateSheetProperties.properties.gridProperties.frozenRowCount, 2);
  assert.deepEqual(sheet.writes.map((w) => w.what), [":clear", "!A1"]);
  assert.ok(sheet.batches[1].every((r) => r.copyPaste.destination.sheetId === 22));
});

test("a tab rewritten in place (Master Data) keeps its look, and its rows take the look of one of them", async () => {
  const ING = { sheetId: 33, title: "Ingredients", index: 0, gridProperties: { rowCount: 1195, columnCount: 8 } };
  const { GDrive, sheet } = setup([ING]);
  await GDrive.connect();
  await GDrive.writeTabLike("abc", "Ingredients", ROWS, "Ingredients", [{ from: 2, to: [2, 7] }]);
  assert.deepEqual(sheet.writes.map((w) => [w.range, w.what]), [["'Ingredients'", ":clear"], ["'Ingredients'", "!A1"]]);
  assert.equal(sheet.batches.length, 1, "no copy of itself onto itself");
  const c = sheet.batches[0][0].copyPaste;
  assert.deepEqual([c.source.sheetId, c.source.startRowIndex, c.destination.sheetId, c.destination.startRowIndex, c.destination.endRowIndex, c.destination.endColumnIndex], [33, 2, 33, 2, 7, 8]);
});

test("without last month's tab it's written plain, as before", async () => {
  const { GDrive, sheet } = setup([{ sheetId: 5, title: "Notes", index: 0 }]);
  await GDrive.connect();
  await GDrive.writeTabLike("abc", "Octobre 2026", ROWS, "Septembre 2026", LOOKS);
  assert.ok(sheet.batches[0][0].addSheet);
  assert.equal(sheet.batches.length, 1);
});

test("reads a column of a tab, empty cells as empty text", async () => {
  const { GDrive, sheet } = setup([SEPT]);
  sheet.columnA = ["", "Category", "Epices", "", "Category"];
  await GDrive.connect();
  assert.deepEqual(await GDrive.readColumn("abc", "Septembre 2026", "A"), ["", "Category", "Epices", "", "Category"]);
});
