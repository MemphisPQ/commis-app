/* Google Drive, straight from the browser.
 *
 * Permission asked: "drive.file" only. The app can touch the files it creates, plus the folder, sheets and
 * recipe card template you pick yourself in Google's own picker. It can't see the rest of your Drive.
 * Sign-in gives a token that lasts about an hour; after that, "Connect" again (one click, no password
 * while you're signed in to Google in this browser).
 *
 * Needs in config.js: googleClientId, googleApiKey, googleProjectNumber (see README, "Google Drive").
 */
const GDrive = (() => {
  const SCOPE = "https://www.googleapis.com/auth/drive.file";
  const cfg = () => window.COSTING_CONFIG || {};
  let token = null, expiresAt = 0, client = null;

  const scripts = {};
  function load(src) {
    scripts[src] = scripts[src] || new Promise((ok, fail) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = ok;
      s.onerror = () => fail(new Error("Couldn't load Google's sign-in. Check your connection."));
      document.head.appendChild(s);
    });
    return scripts[src];
  }
  async function ready() {
    await Promise.all([load("https://accounts.google.com/gsi/client"), load("https://apis.google.com/js/api.js")]);
    await new Promise((ok) => window.gapi.load("picker", ok));
  }

  const configured = () => !!(cfg().googleClientId && cfg().googleApiKey && cfg().googleProjectNumber);
  const connected = () => !!token && Date.now() < expiresAt - 60000;

  /** Opens Google's sign-in window. Must be called from a click. */
  async function connect() {
    if (!configured()) throw new Error("Google isn't set up yet: add the three Google values to config.js.");
    await ready();
    return new Promise((ok, fail) => {
      client = window.google.accounts.oauth2.initTokenClient({
        client_id: cfg().googleClientId,
        scope: SCOPE,
        callback: (r) => {
          if (r.error) return fail(new Error("Google sign-in didn't finish: " + (r.error_description || r.error)));
          token = r.access_token;
          expiresAt = Date.now() + (r.expires_in || 3600) * 1000;
          ok();
          if (api.onConnect) setTimeout(api.onConnect, 0); // e.g. the daily backup
        },
        error_callback: (e) => fail(new Error(e && e.type === "popup_closed" ? "The Google window was closed." : "Google sign-in was blocked. Allow pop-ups for this site and try again.")),
      });
      client.requestAccessToken({ prompt: token ? "" : "consent" });
    });
  }

  async function call(url, { method = "GET", body, headers = {}, raw = false } = {}) {
    if (!connected()) throw new Error("Connect Google Drive first (Settings, or the button on this page).");
    let res;
    try {
      res = await fetch(url, { method, headers: { Authorization: "Bearer " + token, ...headers }, body });
    } catch {
      throw new Error("Couldn't reach Google Drive. Check your connection.");
    }
    if (res.status === 401) { token = null; throw new Error("Your Google connection ran out. Connect again."); }
    if (!res.ok) {
      let msg = res.statusText;
      try { const j = await res.json(); msg = (j.error && j.error.message) || msg; } catch { /* no body */ }
      throw new Error("Google Drive said: " + msg);
    }
    return raw ? res : res.status === 204 ? null : res.json();
  }

  const GOOGLE_DOC = "application/vnd.google-apps.document";
  const GOOGLE_SHEET = "application/vnd.google-apps.spreadsheet";
  const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  /** Google's picker, fitted to the window (so the Select button is always on screen: it's 1051×650 by default). */
  function showPicker(G, view, title, onPick, multi) {
    const b = new G.PickerBuilder()
      .setTitle(title)
      .addView(view)
      .setOAuthToken(token)
      .setDeveloperKey(cfg().googleApiKey)
      .setAppId(String(cfg().googleProjectNumber))
      .setSize(Math.max(320, Math.min(1051, window.innerWidth - 24)), Math.max(360, Math.min(650, window.innerHeight - 24)))
      .setCallback(onPick);
    if (multi) b.enableFeature(G.Feature.MULTISELECT_ENABLED);
    b.build().setVisible(true);
  }

  /** Google's own file picker. kind: "folder", "sheet", "master", "template" or "costsheet". Resolves { id, name } or null if cancelled. */
  async function pick(kind) {
    if (!connected()) await connect();
    await ready();
    const G = window.google.picker;
    const view = kind === "folder"
      ? new G.DocsView(G.ViewId.FOLDERS).setSelectFolderEnabled(true).setIncludeFolders(true).setMimeTypes("application/vnd.google-apps.folder")
      : kind === "template" ? new G.DocsView(G.ViewId.DOCS).setMimeTypes(`${GOOGLE_DOC},${DOCX}`)
      : kind === "costsheet" ? new G.DocsView(G.ViewId.DOCS).setMimeTypes(`${GOOGLE_SHEET},${XLSX}`)
      : new G.DocsView(G.ViewId.SPREADSHEETS);
    const title = { folder: "Pick the folder for recipe cards", sheet: "Pick your inventory sheet", master: "Pick your Master Data sheet",
      template: "Pick your recipe card template", costsheet: "Pick your recipe cost template" }[kind];
    return new Promise((ok) => showPicker(G, view, title, (d) => {
      if (d.action === G.Action.PICKED) ok({ id: d.docs[0].id, name: d.docs[0].name });
      else if (d.action === G.Action.CANCEL) ok(null);
    }));
  }

  /** Several PDFs at once (invoices), starting in the folder used last time. Resolves [{ id, name, parentId }], [] if cancelled. */
  async function pickPdfs(startFolder) {
    if (!connected()) await connect();
    await ready();
    const G = window.google.picker;
    const view = new G.DocsView(G.ViewId.DOCS).setMimeTypes("application/pdf").setIncludeFolders(true);
    if (startFolder) view.setParent(startFolder);
    return new Promise((ok) => showPicker(G, view, "Pick invoice PDFs (several at once is fine)", (d) => {
      if (d.action === G.Action.PICKED) ok(d.docs.map((x) => ({ id: x.id, name: x.name, parentId: x.parentId || null })));
      else if (d.action === G.Action.CANCEL) ok([]);
    }, true));
  }

  /** What's in a file the app can open (one you picked, or one it made). */
  async function fileBlob(id) {
    return (await call(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`, { raw: true })).blob();
  }

  /** Creates (or, with existingId, replaces) a Google Doc from HTML. Drive does the conversion. */
  async function saveDoc({ name, html, folderId, existingId }) {
    const boundary = "kc" + Math.random().toString(36).slice(2);
    const meta = existingId ? { name } : { name, mimeType: "application/vnd.google-apps.document", parents: [folderId] };
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
      `--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${html}\r\n--${boundary}--`;
    const url = existingId
      ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(existingId)}?uploadType=multipart&fields=id,name,webViewLink`
      : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink";
    return call(url, { method: existingId ? "PATCH" : "POST", body, headers: { "Content-Type": `multipart/related; boundary=${boundary}` } });
  }

  /** A file's name, type and whether it's in the bin; null when it's gone or the app can't open it. */
  async function info(id) {
    try { return await call(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,mimeType,trashed`); }
    catch { return null; }
  }

  /** A template as Office bytes: a Google Doc or Sheet is exported as Word or Excel (`as`), an Office file downloaded as it is. */
  async function officeOf(id, as) {
    const f = await info(id);
    if (!f || f.trashed) throw new Error("Can't open that template any more (moved to the bin, or no longer shared with the app). Pick it again in Settings.");
    const url = /^application\/vnd\.google-apps\./.test(f.mimeType)
      ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(as)}`
      : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`;
    return { file: f, bytes: await (await call(url, { raw: true })).arrayBuffer() };
  }
  const wordOf = (id) => officeOf(id, DOCX);
  const excelOf = (id) => officeOf(id, XLSX);

  /** Creates (or, with existingId, replaces the content of) a file from Word bytes: a Google Doc when asDoc, else a Word file. */
  async function saveWord({ name, bytes, folderId, existingId, asDoc }) {
    const boundary = "kc" + Math.random().toString(36).slice(2);
    const meta = existingId ? { name } : { name, mimeType: asDoc ? GOOGLE_DOC : DOCX, parents: [folderId] };
    const body = new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${DOCX}\r\n\r\n`,
      bytes, `\r\n--${boundary}--`]);
    const url = existingId
      ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(existingId)}?uploadType=multipart&fields=id,name,mimeType,webViewLink`
      : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink";
    return call(url, { method: existingId ? "PATCH" : "POST", body, headers: { "Content-Type": `multipart/related; boundary=${boundary}` } });
  }

  /** Uploads a Word or Excel file made in the app, turned into a Google Doc or Sheet (as) or kept as it is. */
  async function saveBytes({ name, bytes, mime, folderId, as }) {
    const boundary = "kc" + Math.random().toString(36).slice(2);
    const body = new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, mimeType: as || mime, parents: [folderId] })}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
      bytes, `\r\n--${boundary}--`]);
    return call("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink", { method: "POST", body,
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` } });
  }
  /** Makes a folder inside another one, or in My Drive without a parent. Resolves { id, name }. */
  async function makeFolder(name, parentId) {
    return call("https://www.googleapis.com/drive/v3/files?fields=id,name", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", ...(parentId ? { parents: [parentId] } : {}) }) });
  }

  /** Saves a plain file (kept as is, not turned into a Google Doc). */
  async function saveFile({ name, content, mime, folderId }) {
    const boundary = "kc" + Math.random().toString(36).slice(2);
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, mimeType: mime, parents: [folderId] })}\r\n` +
      `--${boundary}\r\nContent-Type: ${mime}\r\n\r\n${content}\r\n--${boundary}--`;
    return call("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name", { method: "POST", body,
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` } });
  }

  /** Files the app made in a folder, newest first. */
  async function listFolder(folderId) {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
    const r = await call(`https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=createdTime desc&pageSize=200&fields=files(id,name,createdTime)`);
    return r.files || [];
  }

  /** Moves a file the app made to the bin (it can be restored from Drive's bin for 30 days). */
  async function trash(id) {
    await call(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }) });
  }

  /** Whether a file the app made still exists (not deleted or trashed). */
  async function exists(id) {
    try { const f = await call(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,trashed`); return !f.trashed; }
    catch { return false; }
  }

  /* ---------- Sheets ---------- */
  const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets/";
  const quoted = (title) => `'${title.replace(/'/g, "''")}'`;
  const batch = (sheetId, requests) => call(SHEETS + encodeURIComponent(sheetId) + ":batchUpdate", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requests }) });
  async function sheetTabs(sheetId) {
    const s = await call(SHEETS + encodeURIComponent(sheetId) + "?fields=sheets.properties(sheetId,title,index,gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount))");
    return s.sheets.map((x) => x.properties);
  }
  /** One column of a tab ("A"), as text from the top; empty cells are "". */
  async function readColumn(sheetId, title, col) {
    const r = await call(`${SHEETS}${encodeURIComponent(sheetId)}/values/${encodeURIComponent(`${quoted(title)}!${col}:${col}`)}`);
    return (r.values || []).map((row) => (row[0] == null ? "" : String(row[0])));
  }
  /** Writes rows into a tab, creating it first (as the first tab) if it isn't there. Replaces what was in it. */
  /** Copies a tab inside the same spreadsheet (a safety copy before replacing it). */
  async function copyTab(sheetId, title, newTitle) {
    const tab = (await sheetTabs(sheetId)).find((t) => t.title === title);
    if (!tab) return false;
    await call(SHEETS + encodeURIComponent(sheetId) + ":batchUpdate", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [{ duplicateSheet: { sourceSheetId: tab.sheetId, insertSheetIndex: tab.index + 1, newSheetName: newTitle } }] }) });
    return true;
  }
  async function writeTab(sheetId, title, rows) {
    const tabs = await sheetTabs(sheetId);
    if (!tabs.some((t) => t.title === title)) {
      await call(SHEETS + encodeURIComponent(sheetId) + ":batchUpdate", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requests: [{ addSheet: { properties: { title, index: 0 } } }] }) });
    }
    const range = encodeURIComponent(`'${title.replace(/'/g, "''")}'`);
    await call(`${SHEETS}${encodeURIComponent(sheetId)}/values/${range}:clear`, { method: "POST" });
    await call(`${SHEETS}${encodeURIComponent(sheetId)}/values/${range}!A1?valueInputOption=USER_ENTERED`, { method: "PUT",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values: rows }) });
  }
  /**
   * Like writeTab, but the tab looks like another one (fromTitle), the way a new month is made by duplicating the last:
   * a new tab starts as a copy of it (colours, column widths, row heights, number formats, frozen rows…). A tab that's
   * already there keeps its place, since later tabs' formulas may point at it, and takes on the other's look instead.
   * Then `looks` lays the formatting of single rows of fromTitle over rows of the new tab, so rows that moved look
   * right: [{ from, to: [first, end] }], rows counted from 0, end not included, later ones on top.
   */
  async function writeTabLike(sheetId, title, rows, fromTitle, looks = []) {
    const tabs = await sheetTabs(sheetId);
    const from = tabs.find((t) => t.title === fromTitle);
    if (!from) return writeTab(sheetId, title, rows);
    const fg = { rowCount: 1000, columnCount: 26, ...from.gridProperties };
    let to = tabs.find((t) => t.title === title);
    if (!to) {
      let id;
      do id = 1 + Math.floor(Math.random() * 2e9); while (tabs.some((t) => t.sheetId === id));
      await batch(sheetId, [{ duplicateSheet: { sourceSheetId: from.sheetId, insertSheetIndex: 0, newSheetId: id, newSheetName: title } }]);
      to = { sheetId: id, gridProperties: { ...fg } };
    } else if (to.sheetId !== from.sheetId) {
      await copyLook(sheetId, from, fg, to);
    }
    const have = Math.max(fg.rowCount, (to.gridProperties && to.gridProperties.rowCount) || 0);
    const need = Math.max(rows.length, ...looks.map((l) => l.to[1]));
    if (need > have) await batch(sheetId, [{ appendDimension: { sheetId: to.sheetId, dimension: "ROWS", length: need - have } }]);
    const range = encodeURIComponent(quoted(title));
    await call(`${SHEETS}${encodeURIComponent(sheetId)}/values/${range}:clear`, { method: "POST" });
    await call(`${SHEETS}${encodeURIComponent(sheetId)}/values/${range}!A1?valueInputOption=USER_ENTERED`, { method: "PUT",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values: rows }) });
    const cols = fg.columnCount;
    const area = (id, a, b) => ({ sheetId: id, startRowIndex: a, endRowIndex: b, startColumnIndex: 0, endColumnIndex: cols });
    const pastes = looks.filter((l) => l.from >= 0 && l.from < fg.rowCount && l.to[1] > l.to[0])
      .map((l) => ({ copyPaste: { source: area(from.sheetId, l.from, l.from + 1), destination: area(to.sheetId, l.to[0], l.to[1]), pasteType: "PASTE_FORMAT" } }));
    if (pastes.length) await batch(sheetId, pastes);
  }
  /** Gives a tab another tab's formatting, column widths, row heights and frozen rows (its values stay). */
  async function copyLook(sheetId, from, fg, to) {
    const tg = { rowCount: 1000, columnCount: 26, ...to.gridProperties };
    const meta = await call(`${SHEETS}${encodeURIComponent(sheetId)}?ranges=${encodeURIComponent(quoted(from.title))}&fields=${encodeURIComponent("sheets(data(rowMetadata(pixelSize),columnMetadata(pixelSize)))")}`);
    const data = (((meta.sheets || [])[0] || {}).data || [])[0] || {};
    const requests = [];
    if (fg.rowCount > tg.rowCount) requests.push({ appendDimension: { sheetId: to.sheetId, dimension: "ROWS", length: fg.rowCount - tg.rowCount } });
    if (fg.columnCount > tg.columnCount) requests.push({ appendDimension: { sheetId: to.sheetId, dimension: "COLUMNS", length: fg.columnCount - tg.columnCount } });
    const whole = (id) => ({ sheetId: id, startRowIndex: 0, endRowIndex: fg.rowCount, startColumnIndex: 0, endColumnIndex: fg.columnCount });
    requests.push({ copyPaste: { source: whole(from.sheetId), destination: whole(to.sheetId), pasteType: "PASTE_FORMAT" } });
    // Sizes, a run of same-size rows (or columns) at a time.
    for (const [dimension, list] of [["ROWS", data.rowMetadata || []], ["COLUMNS", data.columnMetadata || []]]) {
      for (let a = 0; a < list.length;) {
        let b = a + 1;
        while (b < list.length && list[b].pixelSize === list[a].pixelSize) b++;
        if (list[a].pixelSize) requests.push({ updateDimensionProperties: { range: { sheetId: to.sheetId, dimension, startIndex: a, endIndex: b }, properties: { pixelSize: list[a].pixelSize }, fields: "pixelSize" } });
        a = b;
      }
    }
    requests.push({ updateSheetProperties: { properties: { sheetId: to.sheetId, gridProperties: { frozenRowCount: fg.frozenRowCount || 0, frozenColumnCount: fg.frozenColumnCount || 0 } },
      fields: "gridProperties.frozenRowCount,gridProperties.frozenColumnCount" } });
    await batch(sheetId, requests);
  }

  const api = { configured, connected, connect, pick, pickPdfs, fileBlob, saveDoc, saveFile, info, wordOf, excelOf, saveWord, GOOGLE_DOC, DOCX, XLSX, listFolder, makeFolder, trash, exists, sheetTabs, readColumn, saveBytes, copyTab, writeTab, writeTabLike, onConnect: null };
  return api;
})();
