/* Where the data lives.
 *
 * Two places, same six tables (ingredients, offers, price_history, recipes, lines, counts):
 *   - Supabase, when config.js has the project address and you're signed in (your real, backed-up data);
 *   - this browser's storage otherwise ("local mode"), handy for trying things out.
 * The app loads everything at start (a few thousand rows at most) and works from memory;
 * every change is written straight through to the store.
 */
const Store = (() => {
  const TABLES = ["ingredients", "offers", "price_history", "recipes", "lines", "counts"];
  // Kept apart from those: importing a sheet or a backup never touches a month's record. From schema.sql part 17.
  const RECORDS = ["closed_months", "saved_invoices"]; // saved_invoices: part 18
  // Columns added in schema.sql part 4. Until that part has been run in Supabase, they're left out of every write.
  const NEW_COLUMNS = { ingredients: ["in_inventory"], recipes: ["method", "ready_in", "card_doc_id"] };
  // Columns from schema.sql part 5 (preps on the monthly count): left out until that part has been run.
  const PART5_COLUMNS = { recipes: ["in_inventory", "alt_qty", "alt_unit"], counts: ["recipe_id"], ingredients: ["prep_id"] };
  // Columns from schema.sql part 7 (locked prices): left out until that part has been run.
  const PART7_COLUMNS = { ingredients: ["locked_price", "locked_at"], recipes: ["locked_cost", "locked_at"] };
  // Columns from schema.sql part 9 (dish categories): left out until that part has been run.
  const PART9_COLUMNS = { recipes: ["category"] };
  // Columns from schema.sql part 10 (a yield on one recipe line): left out until that part has been run.
  const PART10_COLUMNS = { lines: ["yield"] };
  // Columns from schema.sql part 12 (allergens on items): left out until that part has been run.
  const PART12_COLUMNS = { ingredients: ["allergens", "allergen_contact"] };
  // Columns from schema.sql part 16 (more ways to measure, counting in any of them, containers): left out until that part has been run.
  const PART16_COLUMNS = { ingredients: ["measures", "count_unit", "container_kg"], recipes: ["measures", "count_unit", "container_kg"], counts: ["unit", "containers"] };
  let schemaOld = false, part5Old = false, part7Old = false, part9Old = false, part10Old = false, part12Old = false, part16Old = false, part17Old = false, part18Old = false;
  const LOCAL_KEY = "costing.db";

  /* ---------- local mode ---------- */
  const local = {
    kind: "local",
    _db: null,
    _load() {
      if (this._db) return this._db;
      let db = null;
      try { db = JSON.parse(localStorage.getItem(LOCAL_KEY) || "null"); } catch { db = null; }
      this._db = db && typeof db === "object" ? db : {};
      for (const t of [...TABLES, ...RECORDS]) if (!Array.isArray(this._db[t])) this._db[t] = [];
      return this._db;
    },
    _save() {
      try { localStorage.setItem(LOCAL_KEY, JSON.stringify(this._db)); }
      catch { throw new Error("This browser's storage is full or blocked. Connect Supabase to keep your data."); }
    },
    async loadAll() {
      const db = this._load();
      return Object.fromEntries([...TABLES, ...RECORDS].map((t) => [t, db[t].map((r) => ({ ...r }))]));
    },
    async insert(table, rows) {
      const db = this._load();
      db[table].push(...[].concat(rows).map((r) => ({ ...r })));
      this._save();
    },
    async update(table, id, patch) {
      const db = this._load();
      const row = db[table].find((r) => r.id === id);
      if (row) Object.assign(row, patch);
      this._save();
    },
    async remove(table, ids) {
      const db = this._load();
      const set = new Set([].concat(ids));
      db[table] = db[table].filter((r) => !set.has(r.id));
      this._save();
    },
    async replaceAll(data) {
      const { settings, closed_months, saved_invoices } = this._load();
      this._db = Object.fromEntries(TABLES.map((t) => [t, (data[t] || []).map((r) => ({ ...r }))]));
      this._db.closed_months = closed_months;
      this._db.saved_invoices = saved_invoices;
      if (settings) this._db.settings = settings;
      this._save();
    },
    async upsert(table, rows) {
      const db = this._load();
      for (const r of [].concat(rows)) {
        const i = db[table].findIndex((x) => x.id === r.id);
        if (i >= 0) db[table][i] = { ...db[table][i], ...r }; else db[table].push({ ...r });
      }
      this._save();
    },
    async getSettings() { return { ...(this._load().settings || {}) }; },
    async saveSettings(s) { this._load().settings = { ...s }; this._save(); },
  };

  /* ---------- Supabase (plain REST, no library) ---------- */
  const remote = {
    kind: "supabase",
    async _call(path, { method = "GET", body, headers = {} } = {}) {
      const cfg = window.COSTING_CONFIG;
      const token = await Auth.token();
      if (!token) throw new Error("Signed out. Sign in again.");
      let res;
      try {
        res = await fetch(cfg.supabaseUrl.replace(/\/+$/, "") + "/rest/v1/" + path, {
          method,
          headers: { apikey: cfg.supabaseAnonKey, Authorization: "Bearer " + token, "Content-Type": "application/json", ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch {
        throw new Error("Couldn't reach Supabase. Check your connection; your last change was not saved.");
      }
      if (!res.ok) {
        let msg = res.statusText;
        try { const j = await res.json(); msg = j.message || j.hint || msg; } catch { /* no body */ }
        // A rule from before part 8: the database doesn't know "recipe" or "bunch" (or, before part 6, "portion") yet.
        if (/ingredients_base_check/.test(msg)) throw new Error("Pricing per recipe or per bunch needs part 8 of supabase/schema.sql: run it in Supabase (SQL Editor), then pick it again.");
        throw new Error("Supabase said: " + msg);
      }
      return method === "GET" ? res.json() : null;
    },
    async loadAll() {
      const out = {};
      schemaOld = false;
      part5Old = false;
      part7Old = false;
      part9Old = false;
      part10Old = false;
      part12Old = false;
      part16Old = false;
      part17Old = false;
      part18Old = false;
      await Promise.all([...TABLES, ...RECORDS].map(async (t) => {
        // Supabase sends at most 1000 rows per request, so read in pages.
        const rows = [];
        try {
          for (let from = 0; ; from += 1000) {
            const page = await this._call(`${t}?select=*&order=id&limit=1000&offset=${from}`);
            rows.push(...page);
            if (page.length < 1000) break;
          }
        } catch (e) {
          // These come with later parts of schema.sql: without them, run as before.
          if (t === "closed_months") part17Old = true;
          else if (t === "saved_invoices") part18Old = true;
          else if (t === "counts") schemaOld = true;
          else throw e;
        }
        // A price's history keeps when each row was saved: the order of a day's changes depends on it.
        out[t] = rows.map((r) => (t === "price_history" ? { ...strip(r), created_at: r.created_at } : strip(r)));
      }));
      if (schemaOld) part5Old = true;
      else { try { await this._call("counts?select=recipe_id&limit=1"); await this._call("ingredients?select=prep_id&limit=1"); await this._call("recipes?select=alt_qty&limit=1"); } catch { part5Old = true; } }
      try { await this._call("ingredients?select=locked_price,locked_at&limit=1"); await this._call("recipes?select=locked_cost,locked_at&limit=1"); } catch { part7Old = true; }
      try { await this._call("recipes?select=category&limit=1"); } catch { part9Old = true; }
      try { await this._call("lines?select=yield&limit=1"); } catch { part10Old = true; }
      try { await this._call("ingredients?select=allergens,allergen_contact&limit=1"); } catch { part12Old = true; }
      try { await this._call("ingredients?select=measures,count_unit,container_kg&limit=1"); await this._call("recipes?select=measures,count_unit,container_kg&limit=1"); await this._call("counts?select=unit,containers&limit=1"); } catch { part16Old = true; }
      return out;
    },
    async insert(table, rows) {
      const list = [].concat(rows);
      for (let i = 0; i < list.length; i += 500) {
        await this._call(table, { method: "POST", body: list.slice(i, i + 500), headers: { Prefer: "return=minimal" } });
      }
    },
    async update(table, id, patch) {
      await this._call(`${table}?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body: patch, headers: { Prefer: "return=minimal" } });
    },
    async remove(table, ids) {
      const list = [].concat(ids);
      for (let i = 0; i < list.length; i += 100) {
        await this._call(`${table}?id=in.(${list.slice(i, i + 100).map(encodeURIComponent).join(",")})`, { method: "DELETE" });
      }
    },
    async replaceAll(data) {
      // Children first, so nothing points at a deleted row.
      for (const t of (schemaOld ? [] : ["counts"]).concat(["lines", "price_history", "offers", "recipes", "ingredients"])) {
        await this._call(`${t}?id=not.is.null`, { method: "DELETE" });
      }
      // Preferred offers point back at offers: insert ingredients without them, then fill them in.
      const ings = (data.ingredients || []).map((i) => ({ ...i, preferred_offer_id: null }));
      await this.insert("ingredients", ings);
      await this.insert("recipes", data.recipes || []);
      await this.insert("offers", data.offers || []);
      await this.insert("price_history", data.price_history || []);
      await this.insert("lines", data.lines || []);
      if (!schemaOld) await this.insert("counts", data.counts || []);
      // One upsert per 500 rows instead of one request per ingredient.
      const prefs = (data.ingredients || []).filter((x) => x.preferred_offer_id);
      for (let i = 0; i < prefs.length; i += 500) {
        await this._call("ingredients?on_conflict=id", { method: "POST", body: prefs.slice(i, i + 500),
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" } });
      }
    },
  };

  /** Adds rows, or replaces the ones with the same id: one request per 500 rows. */
  remote.upsert = async function (table, rows) {
    const list = [].concat(rows);
    for (let i = 0; i < list.length; i += 500) {
      await this._call(`${table}?on_conflict=id`, { method: "POST", body: list.slice(i, i + 500), headers: { Prefer: "resolution=merge-duplicates,return=minimal" } });
    }
  };
  /**
   * Commis: an invoice the app can't read yet, sent privately (schema part 11) so a reader can be written for its
   * supplier. The PDF goes into this account's folder of the "invoice-inbox" bucket, which only the owner of the
   * Supabase project can open, and a row in invoice_requests says what was sent.
   */
  remote.sendInvoice = async function (file, why) {
    const cfg = window.COSTING_CONFIG, token = await Auth.token();
    if (!token) throw new Error("Signed out. Sign in again.");
    const me = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).sub;
    const path = `${me}/${new Date().toISOString().replace(/[:.]/g, "-")}-${file.name.replace(/[^\w.-]+/g, "_")}`;
    let res;
    try {
      res = await fetch(cfg.supabaseUrl.replace(/\/+$/, "") + "/storage/v1/object/invoice-inbox/" + path, {
        method: "POST", headers: { apikey: cfg.supabaseAnonKey, Authorization: "Bearer " + token, "Content-Type": "application/pdf" }, body: file });
    } catch {
      throw new Error("Couldn't reach Supabase. Check your connection and send it again.");
    }
    if (!res.ok) {
      let msg = res.statusText;
      try { const j = await res.json(); msg = j.message || j.error || msg; } catch { /* no body */ }
      throw new Error(/bucket not found|row-level security/i.test(msg) ? "Sending invoices isn't set up yet (part 11 of supabase/schema.sql)." : msg);
    }
    await this._call("invoice_requests", { method: "POST", body: { file_path: path, file_name: file.name, note: why || "" }, headers: { Prefer: "return=minimal" } });
  };
  remote.getSettings = async function () {
    const rows = await this._call("settings?select=data");
    return rows[0] ? rows[0].data : {};
  };
  remote.saveSettings = async function (s) {
    await this._call("settings?on_conflict=user_id", { method: "POST", body: { data: s, updated_at: new Date().toISOString() },
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" } });
  };

  // Columns Supabase adds that the app doesn't send back.
  function strip(r) {
    const { user_id, created_at, ...rest } = r;
    return rest;
  }

  /** Only the columns each table has, so imported files with extra fields still save. */
  const COLUMNS = {
    ingredients: ["id", "name", "category", "base", "yield", "each_kg", "preferred_offer_id", "notes", "review", "in_inventory", "prep_id", "locked_price", "locked_at", "allergens", "allergen_contact", "measures", "count_unit", "container_kg"],
    offers: ["id", "ingredient_id", "supplier", "supplier_item", "pack_cost", "pack_qty", "pack_unit", "updated_at"],
    price_history: ["id", "offer_id", "ingredient_id", "supplier", "pack_cost", "pack_qty", "pack_unit", "date", "source"],
    recipes: ["id", "name", "kind", "menu", "category", "yield_qty", "yield_unit", "menu_price", "multiplier", "notes", "ack_cost", "review", "method", "ready_in", "card_doc_id", "in_inventory", "alt_qty", "alt_unit", "locked_cost", "locked_at", "measures", "count_unit", "container_kg"],
    counts: ["id", "month", "ingredient_id", "recipe_id", "qty", "unit", "containers"],
    lines: ["id", "recipe_id", "pos", "ingredient_id", "sub_recipe_id", "qty", "unit", "offer_id", "yield"],
    closed_months: ["id", "month", "closed_at", "reopened_at", "source", "total", "items", "groups", "rows"],
    saved_invoices: ["id", "supplier", "date", "file", "total", "lines", "saved_at"],
  };
  // What an empty value becomes, matching the database's "not null" columns.
  const DEFAULTS = {
    ingredients: { category: "", base: "kg", yield: 1, notes: "", review: "", in_inventory: true, allergen_contact: "" },
    offers: { supplier: "", supplier_item: "", pack_unit: "kg" },
    price_history: { supplier: "", source: "" },
    recipes: { kind: "dish", menu: "", category: "", yield_qty: 1, yield_unit: "portion", notes: "", review: "", method: "", ready_in: "", in_inventory: false },
    counts: {},
    lines: { pos: 0 },
    closed_months: { source: "", total: 0, items: 0, groups: {}, rows: [] },
    saved_invoices: { supplier: "", file: "", total: 0, lines: [] },
  };
  function shape(table, row) {
    const out = {};
    for (const c of COLUMNS[table]) {
      if (schemaOld && (NEW_COLUMNS[table] || []).includes(c)) continue;
      if (part5Old && (PART5_COLUMNS[table] || []).includes(c)) continue;
      if (part7Old && (PART7_COLUMNS[table] || []).includes(c)) continue;
      if (part9Old && (PART9_COLUMNS[table] || []).includes(c)) continue;
      if (part10Old && (PART10_COLUMNS[table] || []).includes(c)) continue;
      if (part12Old && (PART12_COLUMNS[table] || []).includes(c)) continue;
      if (part16Old && (PART16_COLUMNS[table] || []).includes(c)) continue;
      const v = row[c] === undefined ? null : row[c];
      out[c] = v == null && c in DEFAULTS[table] ? DEFAULTS[table][c] : v;
    }
    return out;
  }

  function current() {
    const cfg = window.COSTING_CONFIG || {};
    return cfg.supabaseUrl && cfg.supabaseAnonKey && Auth.signedIn() ? remote : local;
  }

  return { TABLES, COLUMNS, shape, current, local, remote, schemaOld: () => schemaOld, part5Old: () => part5Old, part7Old: () => part7Old, part9Old: () => part9Old, part10Old: () => part10Old, part12Old: () => part12Old, part16Old: () => part16Old, part17Old: () => part17Old, part18Old: () => part18Old };
})();
