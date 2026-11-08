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
  // Columns from schema.sql part 19 (Barback): a bottle's weights, and how a count was made up. Left out until that part has been
  // run, and on a site without Barback. config.js turns Barback on (site.barback).
  const PART19_COLUMNS = { ingredients: ["empty_g", "full_g"], counts: ["full_bottles", "open_g"] };
  const barbackOn = () => !!((typeof window !== "undefined" && window.COSTING_CONFIG && window.COSTING_CONFIG.site) || {}).barback;
  let part19Old = !barbackOn();
  // Columns from schema.sql part 20 (people in an account), and whose account is showing. An account's id is its owner's user id.
  const PART20_COLUMNS = { ingredients: ["created_by", "needs_check"], recipes: ["created_by"] };
  const teamsOn = () => !!((typeof window !== "undefined" && window.COSTING_CONFIG && window.COSTING_CONFIG.site) || {}).teams;
  let part20Old = true, account = null, myId = null;
  // What goes only to a restaurant's administrators: the month's typed sales and purchases.
  const PRIVATE_KEYS = ["stockMonths"];
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
      part19Old = !barbackOn();
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
    // `only`: replacing one project's rows, so the other project's stay.
    async replaceAll(data, only) {
      const { settings, closed_months, saved_invoices } = this._load();
      const old = this._db, others = (t) => (only ? old[t].filter((r) => (r.project || "kitchen") !== only) : []);
      this._db = Object.fromEntries(TABLES.map((t) => [t, [...others(t), ...(data[t] || []).map((r) => ({ ...r }))]]));
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
        // Something on a side this person can't see, such as a cocktail in Barback.
        if (/lines_(ingredient_id|sub_recipe_id)_fkey/.test(msg)) throw new Error("Something still uses this: a recipe, or a cocktail in Barback. Take it out there first.");
        if (/row-level security/.test(msg)) throw new Error("You don't have access to change that here. An administrator can.");
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
            const page = await this._call(`${t}?select=*${oneAccount()}&order=id&limit=1000&offset=${from}`);
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
      part19Old = !barbackOn();
      if (!part19Old) { try { await this._call("ingredients?select=project,empty_g,full_g&limit=1"); await this._call("counts?select=project,full_bottles,open_g&limit=1"); } catch { part19Old = true; } }
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
    // `only`: replacing one project's rows, so the other project's stay.
    async replaceAll(data, only) {
      // Children first, so nothing points at a deleted row.
      for (const t of (schemaOld ? [] : ["counts"]).concat(["lines", "price_history", "offers", "recipes", "ingredients"])) {
        await this._call(`${t}?id=not.is.null${only ? `&project=eq.${only}` : ""}${oneAccount()}`, { method: "DELETE" });
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
    const rows = await this._call(`settings?select=data${oneAccount()}`);
    const data = rows[0] ? rows[0].data : {};
    if (part20Old) return data;
    // An employee gets nothing back here. Anyone who can read it gets it put back where the screens look for it.
    const kept = await this._call(`settings_private?select=data${oneAccount()}`);
    return kept[0] ? mergeInPrivate(data, kept[0].data) : data;
  };
  remote.saveSettings = async function (s) {
    const body = (data) => ({ data, updated_at: new Date().toISOString(), ...(account ? { user_id: account } : {}) });
    const merge = { Prefer: "resolution=merge-duplicates,return=minimal" };
    const { open, kept } = part20Old ? { open: s, kept: null } : splitPrivate(s);
    await this._call("settings?on_conflict=user_id", { method: "POST", body: body(open), headers: merge });
    if (kept) await this._call("settings_private?on_conflict=user_id", { method: "POST", body: body(kept), headers: merge });
  };
  /* People in an account (schema part 20). */
  remote.myMemberships = async function () { return this._call("members?select=*"); };
  remote.people = async function (id) { return this._call(`members?select=*&account_id=eq.${encodeURIComponent(id)}&order=email`); };
  remote.invite = async function (row) { await this._call("members", { method: "POST", body: row, headers: { Prefer: "return=minimal" } }); };
  remote.changePerson = async function (id, email, changes) {
    await this._call(`members?account_id=eq.${encodeURIComponent(id)}&email=eq.${encodeURIComponent(email)}`, { method: "PATCH", body: changes, headers: { Prefer: "return=minimal" } });
  };
  remote.removePerson = async function (id, email) {
    await this._call(`members?account_id=eq.${encodeURIComponent(id)}&email=eq.${encodeURIComponent(email)}`, { method: "DELETE" });
  };
  remote.acceptInvite = async function (id) { await this._call("rpc/accept_invite", { method: "POST", body: { account: id } }); };
  /** Someone else's account, or my own while I'm in someone else's, to bring things over from. Nothing about what's showing changes. */
  remote.readAccount = async function (id) {
    const out = {};
    for (const t of ["ingredients", "offers", "recipes", "lines"]) {
      const rows = [];
      for (let from = 0; ; from += 1000) {
        const page = await this._call(`${t}?select=*&user_id=eq.${encodeURIComponent(id)}&order=id&limit=1000&offset=${from}`);
        rows.push(...page);
        if (page.length < 1000) break;
      }
      out[t] = rows.map(strip);
    }
    return out;
  };

  // Every read and bulk delete names the account: someone in two accounts can see both.
  function oneAccount() { return account ? `&user_id=eq.${encodeURIComponent(account)}` : ""; }
  function splitPrivate(s) {
    const pull = (x) => { const open = { ...x }, kept = {}; for (const k of PRIVATE_KEYS) if (k in open) { kept[k] = open[k]; delete open[k]; } return { open, kept }; };
    const top = pull(s), bar = s.barback ? pull(s.barback) : null;
    return { open: { ...top.open, ...(bar ? { barback: bar.open } : {}) }, kept: { ...top.kept, ...(bar ? { barback: bar.kept } : {}) } };
  }
  // A month in the open row was typed on a page from before part 20, after the move, so it's the newer one: it wins.
  const months = (open, kept) => (open || kept ? { ...(kept || {}), ...(open || {}) } : undefined);
  function mergeInPrivate(s, kept) {
    const { barback, ...top } = kept;
    const out = { ...s, ...top };
    const m = months(s.stockMonths, top.stockMonths);
    if (m) out.stockMonths = m;
    if (s.barback || barback) {
      out.barback = { ...(s.barback || {}), ...(barback || {}) };
      const b = months((s.barback || {}).stockMonths, (barback || {}).stockMonths);
      if (b) out.barback.stockMonths = b;
    }
    return out;
  }

  // Columns Supabase adds that the app doesn't send back.
  function strip(r) {
    const { user_id, created_at, ...rest } = r;
    return rest;
  }

  /** Only the columns each table has, so imported files with extra fields still save. */
  const COLUMNS = {
    ingredients: ["id", "name", "category", "base", "yield", "each_kg", "preferred_offer_id", "notes", "review", "in_inventory", "prep_id", "locked_price", "locked_at", "allergens", "allergen_contact", "measures", "count_unit", "container_kg", "empty_g", "full_g", "created_by", "needs_check"],
    offers: ["id", "ingredient_id", "supplier", "supplier_item", "pack_cost", "pack_qty", "pack_unit", "updated_at"],
    price_history: ["id", "offer_id", "ingredient_id", "supplier", "pack_cost", "pack_qty", "pack_unit", "date", "source"],
    recipes: ["id", "name", "kind", "menu", "category", "yield_qty", "yield_unit", "menu_price", "multiplier", "notes", "ack_cost", "review", "method", "ready_in", "card_doc_id", "in_inventory", "alt_qty", "alt_unit", "locked_cost", "locked_at", "measures", "count_unit", "container_kg", "created_by"],
    counts: ["id", "month", "ingredient_id", "recipe_id", "qty", "unit", "containers", "full_bottles", "open_g"],
    lines: ["id", "recipe_id", "pos", "ingredient_id", "sub_recipe_id", "qty", "unit", "offer_id", "yield"],
    closed_months: ["id", "month", "closed_at", "reopened_at", "source", "total", "items", "groups", "rows"],
    saved_invoices: ["id", "supplier", "date", "file", "total", "lines", "saved_at"],
  };
  // What an empty value becomes, matching the database's "not null" columns.
  const DEFAULTS = {
    ingredients: { category: "", base: "kg", yield: 1, notes: "", review: "", in_inventory: true, allergen_contact: "", needs_check: false },
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
      if (part19Old && (PART19_COLUMNS[table] || []).includes(c)) continue;
      if (part20Old && (PART20_COLUMNS[table] || []).includes(c)) continue;
      const v = row[c] === undefined ? null : row[c];
      out[c] = v == null && c in DEFAULTS[table] ? DEFAULTS[table][c] : v;
    }
    return out;
  }

  /* ---------- projects: the kitchen and Barback ---------- */
  // Two sets of records in one account. Every row says which it's in (part 19); no project on a row means the kitchen's. The app
  // works on one set, its `data`. The other is here to read: Barback's cocktails use the kitchen's items and preps at their
  // prices today, and the kitchen needs to know what Barback relies on before deleting or merging anything.
  let project = "kitchen", allSettings = {};
  const inProjects = () => barbackOn() && !part19Old;
  let borrowed = Object.fromEntries([...TABLES, ...RECORDS].map((t) => [t, []]));

  function inProject(base) {
    const s = { kind: base.kind };
    for (const k of Object.keys(base)) if (typeof base[k] === "function" && !k.startsWith("_")) s[k] = base[k].bind(base);
    // Everything written says which side it's on, and whose account it's in when that's not my own.
    const tag = (rows) => (!inProjects() && part20Old ? rows : [].concat(rows).map((r) => ({ ...r, ...(inProjects() ? { project } : {}), ...(!part20Old && account && account !== myId ? { user_id: account } : {}) })));
    // Who I am and which accounts I'm in. Nothing here until part 20 has been run, and the site then works as it always has.
    s.loadTeam = async () => {
      if (base.kind !== "supabase" || !teamsOn()) { part20Old = true; account = null; return { joined: [], invited: [] }; }
      const token = await Auth.token();
      myId = token ? JSON.parse(decodeURIComponent(escape(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))))).sub : null;
      let rows;
      try { rows = await base.myMemberships(); part20Old = false; } catch { part20Old = true; account = null; return { joined: [], invited: [] }; }
      const mail = String(Auth.email() || "").toLowerCase();
      const joined = rows.filter((r) => r.user_id === myId), invited = rows.filter((r) => !r.user_id && r.email === mail);
      if (!joined.some((r) => r.account_id === account)) account = myId;
      return { joined, invited };
    };
    s.loadAll = async () => {
      const all = await base.loadAll();
      if (!inProjects()) project = "kitchen"; // part 19 hasn't been run, or this site has no Barback
      const of = (name) => Object.fromEntries(Object.keys(all).map((t) => [t, all[t].filter((r) => (r.project || "kitchen") === name)]));
      borrowed = of(project === "barback" ? "kitchen" : "barback");
      return of(project);
    };
    s.insert = (table, rows) => base.insert(table, tag(rows));
    s.upsert = (table, rows) => base.upsert(table, tag(rows));
    s.replaceAll = (d) => (inProjects() ? base.replaceAll(Object.fromEntries(Object.keys(d).map((t) => [t, tag(d[t])])), project) : base.replaceAll(d));
    // One row of settings per account: Barback's sit inside it, under "barback".
    s.getSettings = async () => {
      allSettings = await base.getSettings();
      if (!barbackOn()) return allSettings;
      const { barback, ...kitchen } = allSettings;
      return project === "barback" ? { ...(barback || {}) } : kitchen;
    };
    s.saveSettings = async (next) => {
      if (!barbackOn()) return base.saveSettings(next);
      allSettings = project === "barback" ? { ...allSettings, barback: next } : { ...next, ...(allSettings.barback ? { barback: allSettings.barback } : {}) };
      return base.saveSettings(allSettings);
    };
    return s;
  }

  function current() {
    const cfg = window.COSTING_CONFIG || {};
    return inProject(cfg.supabaseUrl && cfg.supabaseAnonKey && Auth.signedIn() ? remote : local);
  }

  return { TABLES, COLUMNS, shape, current, local, remote, schemaOld: () => schemaOld, part5Old: () => part5Old, part7Old: () => part7Old, part9Old: () => part9Old, part10Old: () => part10Old, part12Old: () => part12Old, part16Old: () => part16Old, part17Old: () => part17Old, part18Old: () => part18Old, part19Old: () => part19Old,
    teamsOn, teamsReady: () => teamsOn() && !part20Old, account: () => account, setAccount: (id) => { account = id; }, me: () => myId, part20Old: () => part20Old,
    barbackOn, barbackReady: inProjects, project: () => project, setProject: (p) => { project = p === "barback" ? "barback" : "kitchen"; }, borrowed: () => borrowed };
})();
