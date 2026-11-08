/* Kitchen Costing: the screens.
 * All data sits in `data` (loaded once from the store); every edit goes to the store and the page redraws.
 * Costs are never stored, always worked out by Costing from today's prices.
 */
(() => {
  const main = document.getElementById("main");
  // Which site this is (config.js): one restaurant's own, or Commis, the copy other restaurants sign up to. Same app;
  // Commis has its own name, sign-ups, "Send us this invoice", and none of My Kitchen's sheets or Sundae Atelier.
  const SITE = (() => {
    const s = (window.COSTING_CONFIG || {}).site || {}, commis = s.edition === "commis";
    return { commis, name: s.name || (commis ? "Commis" : "My Kitchen"), sub: s.sub || (commis ? "Costing & inventory" : "Kitchen Costing"),
      app: commis ? "Commis" : "Kitchen Costing", support: tipLink(s.support) };
  })();
  // Commis's "Buy us a soda" link (config.js), only a real https one; none means it stays hidden.
  function tipLink(u) { return typeof u === "string" && u.startsWith("https://") ? u : ""; }
  // Barback (config.js: site.barback): a bar's own records in the same account, on these same screens, in blue. True while it's showing.
  let BAR = false;
  const PROJECT_KEY = "commis.project";
  let wantedProject = (() => { try { return localStorage.getItem(PROJECT_KEY) === "barback" ? "barback" : "kitchen"; } catch { return "kitchen"; } })();
  const say = (s) => (BAR ? Barback.say(s) : s);
  // Whose account is showing (config.js: site.teams, schema part 20). null: your own, as it's always been. Otherwise your place in
  // someone else's: { id, name, role, kitchen, barback, can_count }. The database enforces all of this; the screens just follow it.
  let ACCOUNT = null;
  let joined = [], invited = [], people = [];
  const ACCOUNT_KEY = "commis.account";
  let wantedAccount = (() => { try { return localStorage.getItem(ACCOUNT_KEY) || null; } catch { return null; } })();
  const isAdmin = () => !ACCOUNT || ACCOUNT.role === "admin";
  const isEmployee = () => !isAdmin();
  const canCount = () => isAdmin() || !!ACCOUNT.can_count;
  const mine = (row) => !!row && row.created_by === Store.me();
  const estimateNote = () => `Estimated price from ${Auth.email() || "an employee"}: an administrator needs to double check it.`;
  let data = { ingredients: [], offers: [], price_history: [], recipes: [], lines: [], counts: [], closed_months: [], saved_invoices: [] };
  let coster = null;
  let lineGuess = null;       // the best guess of an invoice line's group, made fresh when items change
  let store = null;
  let settings = {};          // saved per account: { drive: { folder, sheet } }
  let settingsProblem = "";   // set when the settings table isn't there yet

  /* ---------- small helpers ---------- */
  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now().toString(36) + Math.random().toString(36).slice(2));
  // Local date, not UTC: in Montréal UTC is already tomorrow after 8 p.m. (wrong price dates, wrong inventory month on the 31st).
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  // Accepts "1,5" as well as "1.5".
  const parseNum = (v) => { const s = String(v == null ? "" : v).trim().replace(",", "."); return s === "" || !isFinite(+s) ? null : +s; };
  const money = (n, small) => (n == null || !isFinite(n) ? "—" : "$" + n.toFixed(small && Math.abs(n) < 1 && n !== 0 ? 3 : 2));
  const pct = (n) => (n == null || !isFinite(n) ? "—" : (n * 100).toFixed(1) + "%");
  const numText = (n) => (n == null ? "" : String(+(+n).toFixed(6)));
  const unitLabel = (u) => (BAR && u === "oz" ? "oz (weight)" : u === "portion" ? "portion" : Units.UNITS[u] ? Units.UNITS[u].label : u || "");
  // "portions", "recipes", or the unit as it is (kg, L…).
  const plural = (u) => (u === "portion" || u === "recipe" || u === "bottle" ? u + "s" : u === "bunch" ? "bunches" : unitLabel(u));
  const per = (u) => "/" + unitLabel(u);
  // A price box with the $ in front of it.
  const moneyInput = (attrs) => `<span class="in-money"><span class="in-money__sign" aria-hidden="true">$</span><input class="in in--num" inputmode="decimal" placeholder="0.00" ${attrs} /></span>`;
  const byName = (a, b) => a.name.localeCompare(b.name, "fr", { sensitivity: "base" });
  const KITCHEN_UNITS = ["kg", "g", "L", "ml", "unit", "dozen", "portion", "recipe", "bunch"]; // no lb/oz in recipes
  const KITCHEN_PACKS = Object.keys(Units.UNITS).filter((u) => !Units.UNITS[u].bar); // the bar's own measures stay in Barback
  let RECIPE_UNITS = KITCHEN_UNITS;
  let ALL_UNITS = KITCHEN_PACKS;

  /** A short message at the bottom. `action` ({ label, run }) adds a button, such as Undo. */
  function toast(msg, bad, action) {
    const t = $("#toast");
    t.textContent = say(msg);
    if (action) {
      const b = document.createElement("button");
      b.className = "toast__btn";
      b.textContent = action.label;
      b.onclick = () => { t.hidden = true; action.run(); };
      t.append(" ", b);
    }
    t.className = "toast" + (bad ? " toast--bad" : "");
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (t.hidden = true), action ? 12000 : bad ? 7000 : 2500);
  }

  /** In-page replacement for confirm()/prompt(), which some browsers block.
   * Resolves true/false; the typed text (null if cancelled) when `input` is set;
   * or the picked value (null if cancelled) when `choices` ([{ value, label, main }]) is set. */
  // Enter in the question's box answers it: without this, the browser presses the form's first button, Cancel.
  // (A suggestion picked with Enter stops there first, see the suggestions.)
  document.getElementById("askInput").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    e.preventDefault();
    document.querySelector("#askActions .btn:last-child").click();
  });
  function ask(message, { ok = "OK", danger = false, input = false, placeholder = "", choices = null, list = "", value = "", optional = false } = {}) {
    const dlg = $("#ask"), field = $("#askInput");
    $("#askText").textContent = say(message);
    const buttons = choices || [{ value: "ok", label: ok, main: true }];
    $("#askActions").innerHTML = `<button class="btn" value="cancel" formnovalidate>Cancel</button>` +
      buttons.map((b) => `<button class="btn ${b.main ? (danger ? "btn--solid-danger" : "btn--main") : ""}" value="${esc(b.value)}">${esc(say(b.label))}</button>`).join("");
    field.hidden = !input;
    field.value = value;
    field.placeholder = placeholder;
    if (list) { field.dataset.list = list; field.setAttribute("data-suggest-all", ""); } else { delete field.dataset.list; field.removeAttribute("data-suggest-all"); }
    // An optional answer can be left empty (it comes back as "", not null).
    field.required = input && !optional;
    return new Promise((resolve) => {
      dlg.addEventListener("close", () => {
        const v = dlg.returnValue;
        const picked = v && v !== "cancel" ? v : null;
        if (choices) resolve(picked);
        else if (input) resolve(picked ? field.value.trim() || (optional ? "" : null) : null);
        else resolve(!!picked);
      }, { once: true });
      dlg.returnValue = "";
      dlg.showModal();
      (input ? field : $("#askActions .btn:last-child")).focus();
    });
  }

  function rebuild() {
    lineGuess = null;
    coster = Costing.create(BAR ? withKitchen() : data);
    const n = data.recipes.filter((r) => coster.summary(r.id).change !== 0).length;
    const badge = $("#changeCount");
    badge.textContent = n;
    badge.hidden = !n || isEmployee();
    fillLists();
  }

  function fillLists() {
    const opt = (v) => `<option value="${esc(v)}"></option>`;
    const uniq = (arr) => [...new Set(arr.filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr"));
    $("#dl-items").innerHTML = data.ingredients.slice().sort(byName).map((i) => opt(i.name)).join("") +
      data.recipes.filter((r) => r.kind === "prep").sort(byName).map((r) => opt(r.name + " (prep)")).join("") +
      // Barback can also use what's in the kitchen.
      (BAR ? Store.borrowed().ingredients.slice().sort(byName).map((i) => opt(`${i.name} (${SITE.name})`)).join("") +
        Store.borrowed().recipes.filter((r) => r.kind === "prep").sort(byName).map((r) => opt(`${r.name} (${SITE.name} prep)`)).join("") : "");
    $("#dl-ingredients").innerHTML = data.ingredients.slice().sort(byName).map((i) => opt(i.name)).join("");
    $("#dl-preps").innerHTML = data.recipes.filter((r) => r.kind === "prep").sort(byName).concat(data.recipes.filter((r) => r.kind === "dish").sort(byName)).map((r) => opt(r.name)).join("");
    $("#dl-suppliers").innerHTML = uniq(data.offers.map((o) => o.supplier)).map(opt).join("");
    $("#dl-categories").innerHTML = categoryNames("ingredients").map(opt).join("");
    $("#dl-menus").innerHTML = uniq(data.recipes.filter((r) => r.kind === "dish").map((r) => r.menu)).map(opt).join("");
    $("#dl-dish-cats").innerHTML = categoryNames("dishes").map(opt).join("");
    $("#dl-bottle-sizes").innerHTML = Barback.BOTTLE_SIZES.map(opt).join("");
  }

  /* ---------- suggestions while typing ---------- */
  // Boxes tied to a list (list="dl-…") get the app's own suggestions instead of the browser's, which matched too
  // loosely: only the names that contain what you typed (capitals and accents don't matter), the ones starting with
  // it first. Arrows and Enter (or a click) pick one; Enter with none picked keeps what you typed.
  const fold = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const sugg = { box: null, input: null, list: [], at: -1 };
  const ownList = (el) => { if (el && el.matches && el.matches("input[list]")) { el.dataset.list = el.getAttribute("list"); el.removeAttribute("list"); el.autocomplete = "off"; } };
  function suggestionsFor(input, all) {
    const q = fold(input.value.trim()), dl = document.getElementById(input.dataset.list);
    if (!dl) return [];
    // Short lists (categories, menus, suppliers) show all their choices before you type (or when you tap into the box,
    // filled in or not), in their own order.
    if (!q || all) return input.hasAttribute("data-suggest-all") ? [...dl.options].map((o) => o.value).slice(0, 50) : [];
    const rank = (f) => { const k = f.indexOf(q); return k < 0 ? -1 : k === 0 ? 0 : /[a-z0-9]/.test(f[k - 1]) ? 2 : 1; };
    return [...dl.options].map((o) => ({ v: o.value, r: rank(fold(o.value)) })).filter((x) => x.r >= 0)
      .sort((a, b) => a.r - b.r || a.v.localeCompare(b.v, "fr", { sensitivity: "base" })).slice(0, 50).map((x) => x.v);
  }
  function closeSuggestions() {
    if (sugg.box) sugg.box.remove();
    Object.assign(sugg, { box: null, input: null, list: [], at: -1, above: false });
  }
  function placeSuggestions() {
    const r = sugg.input.getBoundingClientRect(), box = sugg.box;
    box.style.minWidth = Math.max(r.width, 220) + "px";
    // The part of the window you can see: not under the scroll bar, the keyboard on a phone (visualViewport), or the
    // phone's tab bar at the bottom.
    const vv = window.visualViewport, nav = $(".nav"), bar = nav && getComputedStyle(nav).position === "fixed" ? nav.offsetHeight : 0;
    const right = document.documentElement.clientWidth - 8, top = (vv ? vv.offsetTop : 0) + 8;
    const bottom = Math.min(vv ? vv.offsetTop + vv.height : innerHeight, innerHeight - bar) - 8;
    box.style.left = Math.max(8, Math.min(r.left, right - box.offsetWidth)) + "px";
    // Below the box if it fits, else on the side with more room; never taller than that room (it scrolls instead of
    // running off the screen).
    box.style.maxHeight = "";
    const want = box.offsetHeight, below = bottom - r.bottom - 4, above = r.top - 4 - top;
    sugg.above = below < want && above > below;
    box.style.maxHeight = Math.max(80, Math.min(want, sugg.above ? above : below)) + "px";
    // Above the box, the best match sits nearest it (at the bottom) and ↑ goes through the list, like ↓ does below.
    box.classList.toggle("suggest--above", sugg.above);
    box.style.top = (sugg.above ? r.top - box.offsetHeight - 4 : r.bottom + 4) + "px";
  }
  function showSuggestions(input, all) {
    const list = suggestionsFor(input, all), now = fold(input.value.trim());
    // Nothing to suggest, or what's typed is already the one match.
    if (!list.length || (!all && list.length === 1 && fold(list[0]) === now)) return closeSuggestions();
    if (sugg.input !== input) {
      closeSuggestions();
      sugg.box = document.createElement("ul");
      sugg.box.className = "suggest";
      sugg.box.setAttribute("role", "listbox");
      (input.closest("dialog") || document.body).appendChild(sugg.box);
      sugg.input = input;
    }
    // All the choices: the one already in the box is lit, so ↑/↓ start from it and Enter keeps it.
    const q = all ? "" : now;
    Object.assign(sugg, { list, at: all ? list.findIndex((v) => fold(v) === now) : -1 });
    sugg.box.innerHTML = list.map((v, k) => {
      const i = fold(v).indexOf(q);
      const text = q && fold(v).length === v.length ? `${esc(v.slice(0, i))}<mark>${esc(v.slice(i, i + q.length))}</mark>${esc(v.slice(i + q.length))}` : esc(v);
      return `<li role="option" data-k="${k}"${k === sugg.at ? ` class="on"` : ""}>${text}</li>`;
    }).join("");
    placeSuggestions();
    const on = sugg.box.querySelector("li.on");
    if (on) on.scrollIntoView({ block: "nearest" });
  }
  function pickSuggestion(k, byEnter) {
    const input = sugg.input, v = sugg.list[k];
    closeSuggestions();
    input.value = v;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    // A field of the app saves when you leave it, like after typing a name and pressing Enter (leaving it is what
    // saves it, once); Enter also moves on to the next box to fill in. The question box keeps the cursor, so Enter
    // answers it.
    if (!input.dataset.act) return;
    // The browser only reports a change you typed: a pick with no typing (a click on a category in a box you just
    // tapped into) has to report its own, or it's never saved.
    let reported = false;
    const seen = () => { reported = true; };
    input.addEventListener("change", seen);
    byEnter ? enterMove(input) : input.blur();
    input.removeEventListener("change", seen);
    if (!reported && input.value !== input.defaultValue) input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  document.addEventListener("focusin", (e) => ownList(e.target), true);
  // Tapping into a category, menu or supplier box shows all its choices straight away, like a drop-down, even with
  // one already in it (to change it without typing).
  const offerAll = (el) => { if (el && el.dataset && el.dataset.list && el.hasAttribute("data-suggest-all") && sugg.input !== el) showSuggestions(el, true); };
  document.addEventListener("focusin", (e) => setTimeout(() => { if (document.activeElement === e.target) offerAll(e.target); }), false);
  document.addEventListener("click", (e) => { if (e.target === document.activeElement) offerAll(e.target); });
  // Only your typing opens it (not the app filling in a pick).
  document.addEventListener("input", (e) => { if (e.isTrusted && e.target.dataset && e.target.dataset.list) showSuggestions(e.target); });
  document.addEventListener("keydown", (e) => {
    if (!sugg.box || e.target !== sugg.input) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      // The arrow pointing away from the box goes to the next match: ↓ when the list is below it, ↑ when it's above.
      const next = (e.key === "ArrowDown") !== !!sugg.above;
      sugg.at = next ? Math.min(sugg.list.length - 1, sugg.at + 1) : Math.max(-1, sugg.at - 1);
      sugg.box.querySelectorAll("li").forEach((li, k) => li.classList.toggle("on", k === sugg.at));
      const on = sugg.box.querySelector("li.on");
      if (on) on.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && sugg.at >= 0) {
      e.preventDefault();
      e.stopImmediatePropagation();
      pickSuggestion(sugg.at, true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      closeSuggestions();
    } else if (e.key === "Enter" || e.key === "Tab") closeSuggestions();
  }, true);
  // A click picks without the box losing focus first.
  document.addEventListener("mousedown", (e) => {
    const li = e.target.closest && e.target.closest(".suggest li");
    if (li) { e.preventDefault(); pickSuggestion(+li.dataset.k); }
  }, true);
  // On a phone a tap picks as soon as the finger lifts, rather than waiting on the mouse events phones make up after a
  // tap (which can come late, after the box has lost focus, or not at all). A finger that moved was scrolling the list.
  let tapStart = null;
  document.addEventListener("touchstart", (e) => { tapStart = e.target.closest && e.target.closest(".suggest li") ? e.touches[0] : null; }, { capture: true, passive: true });
  document.addEventListener("touchend", (e) => {
    const li = tapStart && e.target.closest(".suggest li"), end = e.changedTouches[0];
    if (li && Math.hypot(end.clientX - tapStart.clientX, end.clientY - tapStart.clientY) < 10) { e.preventDefault(); pickSuggestion(+li.dataset.k); }
    tapStart = null;
  }, true);
  document.addEventListener("focusout", (e) => { if (e.target === sugg.input) closeSuggestions(); });
  window.addEventListener("resize", () => { if (sugg.box) placeSuggestions(); });
  // A phone's keyboard opening or closing changes what you can see without resizing the window.
  if (window.visualViewport) for (const t of ["resize", "scroll"]) visualViewport.addEventListener(t, () => { if (sugg.box) placeSuggestions(); });
  document.addEventListener("scroll", (e) => { if (sugg.box && !sugg.box.contains(e.target)) placeSuggestions(); }, true);

  /* ---------- Enter moves on ---------- */
  // Enter saves a box and puts the cursor in the next one still empty: first in the same line (after it, then before
  // it), then in the nearest line that has one, below or above (below when they're as close). With everything filled
  // in, it goes to the same box a line down (handy in the inventory and the Dishes and Ingredients lists), and at the
  // end it just saves. Boxes where empty means something (a line's own yield, "1 unit weighs"…) don't count as empty,
  // and the "+ Add…" boxes move the cursor themselves.
  const OPTIONAL = '[data-act="line-field"][data-field="yield"], [data-act="measure"], [data-act="container"], [data-act="count-containers"], [data-act="sum-month"], [data-field="each_kg"], [data-field="prep_id"]';
  const ADDS = '[data-act="add-line"], [data-act="cat-add"]';
  const fillable = (x) => x.matches("input.in[data-k]:not([type=checkbox]):not([type=radio]), textarea.in[data-k]") && !x.disabled && !x.readOnly && x.getClientRects().length > 0;
  const toFill = (x) => fillable(x) && !x.value.trim() && !x.matches(OPTIONAL) && !x.matches(ADDS);
  const boxesIn = (row) => [...row.querySelectorAll("input, textarea")].filter(fillable);
  function nextBox(el) {
    const tr = el.closest("tr");
    const mine = boxesIn(tr || el.closest(".scale, .head, .totals, .lock, .card, section") || main), at = mine.indexOf(el);
    const same = [...mine.slice(at + 1), ...mine.slice(0, Math.max(at, 0))].find(toFill);
    if (same || !tr) return same || null;
    // The lines of the same list: the rows with the same kind of box (the inventory's sections are separate tables).
    const rows = [...main.querySelectorAll("tr")].filter((r) => r.getClientRects().length && r.querySelector(`[data-act="${CSS.escape(el.dataset.act)}"]`));
    const i = rows.indexOf(tr);
    for (let d = 1; d < rows.length; d++) {
      for (const r of [rows[i + d], rows[i - d]]) { const x = r && boxesIn(r).find(toFill); if (x) return x; }
    }
    const below = rows[i + 1];
    return (below && boxesIn(below).find((x) => x.dataset.act === el.dataset.act && x.dataset.field === el.dataset.field)) || null;
  }
  // Leaving the box is what saves it (its change event); the page drawn after the save then puts the cursor in the
  // next box (render.nextFocus), or looks again if the save filled that one in (see render).
  function enterMove(el) {
    const next = main.contains(el) && !el.matches(ADDS) && nextBox(el);
    if (!next) return el.blur();
    if (el.value === el.defaultValue) { next.focus(); next.select(); return; }
    render.nextFocus = next.dataset.k;
    render.enterFrom = el.dataset.k;
    el.blur();
    // Straight into the next box, so typing can go on while the save finishes (the redraw keeps it, see render).
    if (main.contains(next)) { next.focus(); next.select(); }
  }

  /* ---------- writing ---------- */
  async function write(fn) {
    write.busy = (write.busy || 0) + 1; // switching to the other records waits for this
    try {
      try {
        await fn();
      } catch (e) {
        write.failed = true; // the change listener keeps the draft, so "Put it back" can retry it
        toast(e.message || String(e), true);
        // Whatever the store has is the truth: reload it so the screen doesn't show unsaved changes.
        data = await store.loadAll();
      }
    } finally { write.busy--; }
    rebuild();
    render();
  }
  // In Barback, a kitchen item or prep can be looked up too (a cocktail uses it); it can't be changed from here.
  const get = (table, id) => data[table].find((r) => r.id === id) || (BAR ? (Store.borrowed()[table] || []).find((r) => r.id === id) : undefined);
  const fromKitchen = (table, id) => BAR && !data[table].some((r) => r.id === id) && (Store.borrowed()[table] || []).some((r) => r.id === id);

  /** Who made a new row. What an employee adds to a restaurant's list is flagged, and stays theirs to correct until it's checked. */
  function stamp(table, row) {
    if (Store.part20Old() || (table !== "ingredients" && table !== "recipes")) return row;
    const out = { ...row, created_by: isEmployee() ? Store.me() : row.created_by || Store.me() };
    if (isEmployee() && table === "ingredients") Object.assign(out, { needs_check: true, review: estimateNote(), in_inventory: false, locked_price: null, locked_at: null });
    return out;
  }
  async function insert(table, row) {
    const r = Store.shape(table, stamp(table, row));
    data[table].push(r);
    await store.insert(table, r);
    return r;
  }
  async function patch(table, id, changes) {
    if (fromKitchen(table, id)) throw new Error(`That belongs to ${SITE.name}: open it there to change it.`);
    // From the kitchen, a merge also moves the Barback lines that use what it's merging.
    const row = get(table, id) || (Store.borrowed()[table] || []).find((r) => r.id === id);
    if (row) Object.assign(row, changes);
    await store.update(table, id, changes);
  }
  async function removeRows(table, ids) {
    const set = new Set([].concat(ids).filter((id) => !fromKitchen(table, id)));
    data[table] = data[table].filter((r) => !set.has(r.id));
    if (set.size) await store.remove(table, [...set]);
  }

  /** Records a price in the history, so you can see how it moved. */
  async function logPrice(offer, source) {
    const ing = get("ingredients", offer.ingredient_id);
    if (!ing || parseNum(offer.pack_cost) == null || !parseNum(offer.pack_qty)) return;
    const fields = { supplier: offer.supplier, pack_cost: offer.pack_cost, pack_qty: offer.pack_qty, pack_unit: offer.pack_unit };
    // Typing a new cost and then its pack size is one change: today's typed row follows along instead of leaving half-done ones behind.
    const todays = source === "Typed in" && data.price_history.find((h) => h.offer_id === offer.id && h.date === today() && h.source === source);
    if (todays) return patch("price_history", todays.id, fields);
    await insert("price_history", { id: uid(), offer_id: offer.id, ingredient_id: ing.id, ...fields, date: today(), source });
  }

  /* ---------- failsafes: drafts and recently deleted ---------- */
  // Everything typed is copied to this device as you type. A copy is dropped once that field has saved;
  // if the save failed, or the page closed first, the page offers to put it back.
  const DRAFTS = "costing.drafts";
  let TRASH = "costing.trash"; // each set of records has its own (see applyProject)
  const readJSON = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || "null"); return v == null ? d : v; } catch { return d; } };
  const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } };
  const draftable = (el) => el && el.dataset && el.dataset.k && el.dataset.act && el.dataset.act !== "add-line" && el.matches("input:not([type=checkbox]):not([type=radio]):not([type=file]), textarea, select");
  const draftKey = (el) => location.hash + "|" + el.dataset.k;
  function fieldLabel(el) {
    if (el.getAttribute("aria-label")) return el.getAttribute("aria-label");
    const lab = el.closest("label");
    return lab ? lab.textContent.trim().split(/\s{2,}|\n/)[0] : el.dataset.field || "a field";
  }
  function keepDraft(el) {
    const d = readJSON(DRAFTS, {});
    d[draftKey(el)] = { value: el.value, label: fieldLabel(el), at: Date.now() };
    writeJSON(DRAFTS, d);
  }
  function dropDraft(key) {
    const d = readJSON(DRAFTS, {});
    if (key in d) { delete d[key]; writeJSON(DRAFTS, d); }
  }
  /** Drafts for this page that differ from what's saved. Drafts that match, or are over 30 days old, are cleared. */
  const saving = new Set();
  function pendingDrafts() {
    const d = readJSON(DRAFTS, {});
    const out = [];
    let changed = false;
    for (const [key, v] of Object.entries(d)) {
      if (Date.now() - v.at > 30 * 864e5) { delete d[key]; changed = true; continue; }
      if (!key.startsWith(location.hash + "|") || saving.has(key)) continue;
      const el = main.querySelector(`[data-k="${CSS.escape(key.slice(location.hash.length + 1))}"]`);
      if (!el || el.value === v.value) { delete d[key]; changed = true; continue; }
      out.push({ key, el, ...v });
    }
    if (changed) writeJSON(DRAFTS, d);
    return out;
  }
  function showDrafts() {
    const list = pendingDrafts();
    if (!list.length) return;
    const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
    main.querySelectorAll("[data-drafts]").forEach((b) => b.remove());
    const bar = document.createElement("div");
    bar.className = "alert alert--check";
    bar.dataset.drafts = "";
    bar.innerHTML = `<div>Text you typed here wasn't saved: ${list.map((x) => `<strong>${esc(x.label)}</strong> (${ago(x.at)})`).join(", ")}.</div>
      <div class="actions" style="margin:0"><button class="btn btn--main" data-act="draft-restore">Put it back</button><button class="btn" data-act="draft-discard">Discard</button></div>`;
    main.prepend(bar);
  }

  /** Keeps what's deleted on this device (last 50), so it can be put back. */
  function toTrash(label, kind, rows, extra = {}) {
    const entry = { id: uid(), at: Date.now(), label, kind, rows, extra };
    writeJSON(TRASH, [entry, ...readJSON(TRASH, [])].slice(0, 50));
    return entry;
  }
  async function restoreFromTrash(entryId) {
    const entry = readJSON(TRASH, []).find((x) => x.id === entryId);
    if (!entry) return;
    const has = (t, id) => !!get(t, id);
    write.failed = false;
    if (entry.kind === "merge") {
      const recipe = entry.rows.recipes && entry.rows.recipes[0];
      await write(() => (recipe ? undoMergeRecipe(entry) : undoMerge(entry)));
      if (!write.failed) { writeJSON(TRASH, readJSON(TRASH, []).filter((e) => e.id !== entry.id)); toast(`Split back out: ${(recipe || entry.rows.ingredients[0]).name}.`); }
      return;
    }
    await write(async () => {
      const R = entry.rows;
      const ings = (R.ingredients || []).filter((r) => !has("ingredients", r.id));
      for (const r of ings) await insert("ingredients", { ...r, preferred_offer_id: null });
      for (const r of (R.recipes || []).filter((r) => !has("recipes", r.id))) await insert("recipes", r);
      for (const r of (R.offers || []).filter((r) => !has("offers", r.id) && has("ingredients", r.ingredient_id))) await insert("offers", r);
      const hist = (R.price_history || []).filter((r) => !has("price_history", r.id) && (!r.offer_id || has("offers", r.offer_id)));
      if (hist.length) { const s = hist.map((r) => Store.shape("price_history", r)); data.price_history.push(...s); await store.insert("price_history", s); }
      // A line comes back only if what it points at is still there.
      for (const r of (R.lines || []).filter((l) => !has("lines", l.id) && has("recipes", l.recipe_id) && (l.ingredient_id ? has("ingredients", l.ingredient_id) : has("recipes", l.sub_recipe_id)))) {
        await insert("lines", { ...r, offer_id: r.offer_id && has("offers", r.offer_id) ? r.offer_id : null });
      }
      if (!Store.schemaOld()) for (const r of (R.counts || []).filter((c) => !has("counts", c.id) && (c.recipe_id ? has("recipes", c.recipe_id) : has("ingredients", c.ingredient_id)))) await insert("counts", r);
      for (const r of ings) if (r.preferred_offer_id && has("offers", r.preferred_offer_id)) await patch("ingredients", r.id, { preferred_offer_id: r.preferred_offer_id });
      const x = entry.extra || {};
      if (x.preferredOf && has("ingredients", x.preferredOf)) await patch("ingredients", x.preferredOf, { preferred_offer_id: R.offers[0].id });
      for (const id of x.linesUsing || []) if (has("lines", id)) await patch("lines", id, { offer_id: R.offers[0].id });
      writeJSON(TRASH, readJSON(TRASH, []).filter((e) => e.id !== entry.id));
    });
    if (!write.failed) toast(`Put back: ${entry.label}.`);
  }
  const undoFor = (entry) => ({ label: "Undo", run: () => restoreFromTrash(entry.id) });

  /* ---------- merging duplicate ingredients ---------- */
  // Same thing, different spelling: accents, punctuation and word order don't count; sizes in brackets do.
  const nameKey = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/&/g, " et ").replace(/\([^)0-9]*\)/g, " ").split(/[^a-z0-9]+/).filter(Boolean).sort().join(" ");
  const lookAlikes = (i) => data.ingredients.filter((x) => x.id !== i.id && nameKey(x.name) === nameKey(i.name));

  /** Moves everything from one ingredient onto another (prices, history, recipe lines, counts), then removes it. */
  async function mergeIngredient(from, into) {
    const offers = data.offers.filter((o) => o.ingredient_id === from.id).map((o) => o.id);
    const history = data.price_history.filter((h) => h.ingredient_id === from.id).map((h) => h.id);
    const lines = [...data.lines.filter((l) => l.ingredient_id === from.id), ...barLines("ingredient_id", from.id)].map((l) => ({ id: l.id, unit: l.unit }));
    const counts = data.counts.filter((c) => c.ingredient_id === from.id).map((c) => ({ ...c }));
    // A copy with no price of its own was a placeholder: its quantities were meant in the real item's unit.
    const adoptUnit = !offers.length && from.base !== into.base;
    const setPreferred = !into.preferred_offer_id && from.preferred_offer_id ? from.preferred_offer_id : null;
    const carry = {};
    for (const f of ["measures", "container_kg", "count_unit"]) if (into[f] == null && from[f] != null) carry[f] = from[f];
    const entry = toTrash(`${from.name} (merged into ${into.name})`, "merge", { ingredients: [{ ...from }] }, { into: into.id, offers, history, lines, counts, setPreferred, carry: Object.keys(carry) });
    await write(async () => {
      for (const id of offers) await patch("offers", id, { ingredient_id: into.id });
      for (const id of history) await patch("price_history", id, { ingredient_id: into.id });
      for (const l of lines) await patch("lines", l.id, adoptUnit ? { ingredient_id: into.id, unit: into.base } : { ingredient_id: into.id });
      for (const c of counts) {
        // Both counted the same month: add them up (same unit only), otherwise just move the count over.
        const there = data.counts.find((d) => d.month === c.month && d.ingredient_id === into.id);
        if (there && from.base === into.base && (c.unit || from.base) === (there.unit || into.base)) { await patch("counts", there.id, { qty: (parseNum(there.qty) || 0) + (parseNum(c.qty) || 0) }); await removeRows("counts", c.id); }
        else if (!there) await patch("counts", c.id, { ingredient_id: into.id });
        else await removeRows("counts", c.id);
      }
      if (setPreferred) await patch("ingredients", into.id, { preferred_offer_id: setPreferred });
      if (Object.keys(carry).length) await patch("ingredients", into.id, carry);
      // Counted under the old name: keep it on the monthly count under the new one.
      if (from.in_inventory !== false && into.in_inventory === false) await patch("ingredients", into.id, { in_inventory: true });
      await patch("ingredients", from.id, { preferred_offer_id: null });
      await removeRows("ingredients", from.id);
    });
    return entry;
  }
  async function undoMerge(entry) {
    const x = entry.extra, from = entry.rows.ingredients[0];
    await insert("ingredients", { ...from, preferred_offer_id: null });
    for (const id of x.offers) if (get("offers", id)) await patch("offers", id, { ingredient_id: from.id });
    for (const id of x.history) if (get("price_history", id)) await patch("price_history", id, { ingredient_id: from.id });
    for (const l of x.lines) if (lineThere(l.id)) await patch("lines", l.id, { ingredient_id: from.id, unit: l.unit });
    for (const c of x.counts) {
      if (get("counts", c.id)) { await patch("counts", c.id, { ingredient_id: from.id }); continue; }
      const there = data.counts.find((d) => d.month === c.month && d.ingredient_id === x.into);
      if (there) await patch("counts", there.id, { qty: (parseNum(there.qty) || 0) - (parseNum(c.qty) || 0) });
      await insert("counts", c);
    }
    if (x.setPreferred && get("ingredients", x.into)) await patch("ingredients", x.into, { preferred_offer_id: null });
    if ((x.carry || []).length && get("ingredients", x.into)) await patch("ingredients", x.into, Object.fromEntries(x.carry.map((f) => [f, null])));
    if (from.preferred_offer_id && get("offers", from.preferred_offer_id)) await patch("ingredients", from.id, { preferred_offer_id: from.preferred_offer_id });
  }

  /* ---------- merging versions of a prep or dish ---------- */
  // "Gravy" and "Gravy (EMPORTER Chicken, Roast)": the same name once the bracket at the end is left out.
  const versionKey = (r) => nameKey(String(r.name || "").replace(/\s*\([^)]*\)\s*$/, ""));
  const otherVersions = (r) => (versionKey(r) ? data.recipes.filter((x) => x.id !== r.id && x.kind === r.kind && versionKey(x) === versionKey(r)) : []);
  // Can a line measured in this unit use this recipe? Portions only match portions; kg, L and units convert.
  const measureFits = (unit, m) => !!m && (["portion", "recipe", "bunch"].includes(unit) || ["portion", "recipe", "bunch"].includes(m) ? unit === m : Units.convert(1, unit, m) != null);
  const lineFits = (unit, r) => measureFits(unit, r.yield_unit) || (parseNum(r.alt_qty) > 0 && measureFits(unit, r.alt_unit)) || Costing.savedMeasures(r).some((m) => measureFits(unit, m.unit));
  // What the kept one takes from the other when it has none of its own.
  const FILL_FIELDS = ["menu", "category", "menu_price", "ready_in", "method", "notes", "card_doc_id", "container_kg", "count_unit"];

  /** Puts one recipe in place of another everywhere (recipe lines, "Made in-house" links, monthly counts),
   * keeping the amounts, fills in card text the kept one is missing, then removes the other one. */
  async function mergeRecipe(from, into) {
    const lines = [...data.lines.filter((l) => l.sub_recipe_id === from.id), ...barLines("sub_recipe_id", from.id)].map((l) => l.id);
    const links = data.ingredients.filter((i) => i.prep_id === from.id).map((i) => i.id);
    const own = data.lines.filter((l) => l.recipe_id === from.id).map((l) => ({ ...l }));
    const fill = {};
    for (const f of FILL_FIELDS) if (!String(into[f] ?? "").trim() && String(from[f] ?? "").trim()) fill[f] = from[f];
    if (from.in_inventory === true && into.in_inventory !== true) fill.in_inventory = true;
    // Flagged only because the other version existed: once it's the only one, there's nothing left to merge.
    if (/^Several versions of/.test(into.review || "") && !otherVersions(into).some((x) => x.id !== from.id)) fill.review = "";
    const before = Object.fromEntries(Object.keys(fill).map((f) => [f, into[f] ?? null]));
    // Counts are in what each one makes: carried over when that converts, dropped when it doesn't (portions vs kg).
    const conv = (q, u) => (u === into.yield_unit ? q : measureFits(u, into.yield_unit) ? (q == null ? q : Units.convert(q, u, into.yield_unit)) : undefined);
    const counts = data.counts.filter((c) => c.recipe_id === from.id).map((c) => ({ row: { ...c }, qty: conv(parseNum(c.qty), c.unit || from.yield_unit) }));
    for (const c of counts) c.added = c.qty !== undefined && data.counts.some((d) => d.month === c.row.month && d.recipe_id === into.id) ? c.qty || 0 : null;
    const entry = toTrash(`${from.name} (merged into ${into.name})`, "merge", { recipes: [{ ...from }], lines: own }, { into: into.id, lines, links, counts, before });
    await write(async () => {
      for (const id of lines) await patch("lines", id, { sub_recipe_id: into.id });
      for (const id of links) await patch("ingredients", id, { prep_id: into.id });
      for (const c of counts) {
        // Both counted the same month: add them up.
        const there = data.counts.find((d) => d.month === c.row.month && d.recipe_id === into.id);
        if (c.added != null && there) await patch("counts", there.id, { qty: (parseNum(there.qty) || 0) + c.added });
        if (c.added != null || c.qty === undefined) await removeRows("counts", c.row.id);
        else await patch("counts", c.row.id, Store.part16Old() ? { recipe_id: into.id, qty: c.qty } : { recipe_id: into.id, qty: c.qty, unit: null });
      }
      if (Object.keys(fill).length) await patch("recipes", into.id, fill);
      await removeRows("lines", own.map((l) => l.id));
      await removeRows("recipes", from.id);
    });
    return entry;
  }
  async function undoMergeRecipe(entry) {
    const x = entry.extra, from = entry.rows.recipes[0];
    await insert("recipes", from);
    for (const l of entry.rows.lines) {
      if (get("lines", l.id) || !(l.ingredient_id ? get("ingredients", l.ingredient_id) : get("recipes", l.sub_recipe_id))) continue;
      await insert("lines", { ...l, offer_id: l.offer_id && get("offers", l.offer_id) ? l.offer_id : null });
    }
    for (const id of x.lines) if (lineThere(id)) await patch("lines", id, { sub_recipe_id: from.id });
    for (const id of x.links) if (get("ingredients", id)) await patch("ingredients", id, { prep_id: from.id });
    for (const c of x.counts) {
      if (get("counts", c.row.id)) { await patch("counts", c.row.id, Store.part16Old() ? { recipe_id: from.id, qty: c.row.qty } : { recipe_id: from.id, qty: c.row.qty, unit: c.row.unit || null }); continue; }
      const there = c.added != null && data.counts.find((d) => d.month === c.row.month && d.recipe_id === x.into);
      if (there) await patch("counts", there.id, { qty: (parseNum(there.qty) || 0) - c.added });
      await insert("counts", c.row);
    }
    if (Object.keys(x.before).length && get("recipes", x.into)) await patch("recipes", x.into, x.before);
  }

  /* ---------- Barback: the same screens, with a bar's own records ---------- */
  const BAR_NAV = { dishes: ["Cocktails", "M5 4h14l-7 8ZM12 12v8M8 20h8"], ingredients: ["Bottles", "M10 3h4v4l2 3v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10l2-3V3ZM8 13h8"], inventory: ["Count"] };
  const TAB_COLOUR = { light: ["#1b4537", "#14365f"], dark: ["#0f1312", "#0c1118"] };

  /** Everything that follows which set of records is showing. The store has the final say: without part 19 it stays on the kitchen. */
  function applyProject() {
    const was = BAR;
    BAR = Store.project() === "barback";
    if (BAR) document.documentElement.setAttribute("data-project", "barback"); else document.documentElement.removeAttribute("data-project");
    RECIPE_UNITS = BAR ? Barback.RECIPE_UNITS : KITCHEN_UNITS;
    ALL_UNITS = BAR ? Barback.PACK_UNITS : KITCHEN_PACKS;
    // What's deleted, and invoices being worked on, stay with the records they came from.
    const whose = ACCOUNT ? "." + ACCOUNT.id : "";
    TRASH = (BAR ? "costing.trash.barback" : "costing.trash") + whose;
    const keyWas = INV_KEY;
    INV_KEY = (BAR ? "costing.invoiceWork.barback" : "costing.invoiceWork") + whose;
    if (was !== BAR || keyWas !== INV_KEY) invoiceWork = readJSON(INV_KEY, []);
    $(".brand__name").textContent = BAR ? "Barback" : SITE.name;
    $(".brand__sub").textContent = (ACCOUNT && ACCOUNT.name) || (SITE.commis && Auth.signedIn() && Auth.restaurant()) || (BAR ? "Cocktails & liquor" : SITE.sub);
    document.title = BAR ? "Barback" : SITE.app;
    document.querySelectorAll(".nav a[data-nav]").forEach((a) => {
      const long = a.querySelector(".nav__long"), short = a.querySelector(".nav__short"), path = a.querySelector("path");
      if (!a.dataset.long) { a.dataset.long = long.textContent; a.dataset.short = short.textContent; a.dataset.path = path.getAttribute("d"); }
      const bar = BAR && BAR_NAV[a.dataset.nav];
      long.textContent = bar ? bar[0] : a.dataset.long;
      short.textContent = bar ? bar[0] : a.dataset.short;
      path.setAttribute("d", (bar && bar[1]) || a.dataset.path);
    });
    for (const [scheme, colours] of Object.entries(TAB_COLOUR)) {
      const tag = document.querySelector(`meta[name="theme-color"][media*="${scheme}"]`);
      if (tag) tag.content = colours[BAR ? 1 : 0];
    }
    const icon = document.querySelector('link[rel="icon"]');
    if (icon) icon.setAttribute("href", BAR ? "favicon-barback.svg" : "favicon.svg");
    const box = $("#projectSwitch");
    // Only the sides this person has here. With one, there's nothing to switch.
    box.hidden = !Store.barbackReady() || (!!ACCOUNT && !(ACCOUNT.kitchen && ACCOUNT.barback));
    box.querySelector('[data-project="kitchen"]').textContent = SITE.name;
    box.querySelectorAll("[data-project]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.project === Store.project())));
    // What an employee doesn't use: invoices and price changes are for administrators, the count for those with inventory access.
    document.querySelectorAll(".nav a[data-nav]").forEach((a) => { a.hidden = isEmployee() && (a.dataset.nav === "invoices" || a.dataset.nav === "changes" || (a.dataset.nav === "inventory" && !canCount())); });
    const pick = $("#accountSwitch");
    pick.hidden = !joined.length;
    pick.innerHTML = joined.length ? `<option value="${esc(Store.me())}">My account</option>` + joined.map((m) => `<option value="${esc(m.account_id)}">${esc(m.account_name || "A restaurant")} · ${m.role === "admin" ? "Administrator" : "Employee"}</option>`).join("") : "";
    if (joined.length) pick.value = Store.account();
    showInvites();
  }

  /** Which account to show: the one asked for if you're still in it, else your own. Which side: the one asked for if you have it. */
  function chooseAccount(team) {
    joined = team.joined; invited = team.invited;
    const m = joined.find((x) => x.account_id === wantedAccount);
    ACCOUNT = m ? { id: m.account_id, name: m.account_name, role: m.role, kitchen: m.kitchen, barback: m.barback, can_count: m.can_count, email: m.email } : null;
    if (Store.teamsReady()) Store.setAccount(ACCOUNT ? ACCOUNT.id : Store.me());
    if (!ACCOUNT) return wantedProject;
    if (wantedProject === "barback" && !ACCOUNT.barback) return "kitchen";
    if (wantedProject === "kitchen" && !ACCOUNT.kitchen) return "barback";
    return wantedProject;
  }

  /* ---------- what an employee can do here ---------- */
  const EMPLOYEE_PAGES = new Set(["dishes", "preps", "recipe", "ingredients", "ingredient", "menu", "settings", "bring"]);
  const pageAllowed = (page) => !isEmployee() || EMPLOYEE_PAGES.has(page) || (page === "inventory" && canCount());
  const ALWAYS_OK = new Set(["draft-restore", "draft-discard", "dish-group", "hist-period", "sign-out", "back-to", "new-recipe", "duplicate", "new-ingredient", "open-in-kitchen", "inv-print", "leave-account", "bring-from", "bring-pick", "bring-go"]);
  const COUNTING = new Set(["count", "count-open", "count-unit", "count-containers", "count-same"]);
  const OWN_RECIPE = new Set(["recipe-field", "dish-cat", "dish-menu", "measure", "measure-costper", "container", "add-line", "line-field", "delete-line", "delete-recipe", "ack", "recipe-checked", "scale-open", "scale-pick", "scale-qty", "scale-unit", "scale-close", "scale-save", "scale-clear", "download-card", "save-card", "lock", "unlock", "lock-field"]);
  const OWN_ITEM = new Set(["ing-field", "allergen", "offer-field", "prefer", "add-offer", "delete-offer", "delete-ingredient", "measure", "container", "bottle-field"]);
  function employeeMay(act, el) {
    if (ALWAYS_OK.has(act)) return true;
    if (COUNTING.has(act)) return canCount();
    const r = route();
    if (r.page === "recipe") return OWN_RECIPE.has(act) && mine(get("recipes", r.id));
    if (r.page === "ingredient") { const i = get("ingredients", r.id); return OWN_ITEM.has(act) && mine(i) && !!i.needs_check; }
    if (act === "dish-cat" || act === "dish-menu") return mine(get("recipes", el.dataset.id));
    return false;
  }
  /** Over a drawn page: what this employee can't do is greyed out or gone. */
  function lockDown() {
    main.querySelectorAll("[data-act]").forEach((el) => {
      if (employeeMay(el.dataset.act, el)) return;
      if (el.matches("input, select, textarea")) el.disabled = true; else el.hidden = true;
    });
    const r = route();
    if (r.page !== "recipe" || !mine(get("recipes", r.id))) main.querySelectorAll("[data-drag-line]").forEach((el) => { el.hidden = true; });
    // Buttons to pages they can't open (the count's summary, a month's invoices) go too.
    main.querySelectorAll('a[href^="#/"]').forEach((a) => { const page = a.getAttribute("href").slice(2).split("/")[0]; if (page && !pageAllowed(page)) a.hidden = true; });
  }

  /* ---------- people in an account ---------- */
  function showInvites() {
    const box = $("#invites");
    box.hidden = !invited.length;
    box.innerHTML = invited.map((m) => `<div class="invite"><span><strong>${esc(m.account_name || "A restaurant")}</strong> gave you access as ${m.role === "admin" ? "an administrator" : "an employee"}. Your own account stays as it is.</span>
      <span class="invite__buttons"><button class="btn btn--small btn--main" type="button" data-invite="accept" data-account="${esc(m.account_id)}">Accept</button>
      <button class="btn btn--small" type="button" data-invite="decline" data-account="${esc(m.account_id)}" data-email="${esc(m.email)}">No thanks</button></span></div>`).join("");
  }
  async function answerInvite(b) {
    try {
      if (b.dataset.invite === "accept") {
        await store.acceptInvite(b.dataset.account);
        await goTo(b.dataset.account);
        toast(`You're in. The list at the top goes back to your own account, which stays as it was.`);
      } else {
        await store.removePerson(b.dataset.account, b.dataset.email);
        await start();
      }
    } catch (e) { toast(e.message, true); }
  }
  /** Over to another account (or back to my own). */
  async function goTo(id) {
    if (switching) return;
    switching = true;
    wantedAccount = id === Store.me() ? null : id;
    try { if (wantedAccount) localStorage.setItem(ACCOUNT_KEY, wantedAccount); else localStorage.removeItem(ACCOUNT_KEY); } catch { /* this visit only */ }
    await goOver();
  }
  const accessWords = (m) => [m.kitchen && SITE.name, m.barback && Store.barbackReady() && "Barback", m.role !== "admin" && m.can_count && "inventory"].filter(Boolean).join(", ");

  /** Administrators: who's in this account, and letting someone new in. */
  function peopleCard() {
    if (!Store.teamsReady() || !isAdmin()) return "";
    const bar = Store.barbackReady();
    const tick = (m, field, label, on, off = false) => `<label class="check"><input type="checkbox" data-k="p-${field}-${esc(m.email)}" data-act="person-field" data-field="${field}" data-email="${esc(m.email)}" ${on ? "checked" : ""} ${off ? "disabled" : ""} /> ${label}</label>`;
    const rows = people.map((m) => `<tr>
      <td><strong>${esc(m.email)}</strong><div class="muted small">${m.user_id ? "Joined" : "Waiting for them to sign in with this email"}</div></td>
      <td><select class="in" data-k="p-role-${esc(m.email)}" data-act="person-field" data-field="role" data-email="${esc(m.email)}" aria-label="Role of ${esc(m.email)}">
        <option value="employee"${m.role === "employee" ? " selected" : ""}>Employee</option><option value="admin"${m.role === "admin" ? " selected" : ""}>Administrator</option></select></td>
      <td class="people__access">${tick(m, "kitchen", esc(SITE.name), m.kitchen)}${bar ? tick(m, "barback", "Barback", m.barback) : ""}${tick(m, "can_count", "Inventory", m.role === "admin" || m.can_count, m.role === "admin")}</td>
      <td><button class="icon icon--x" data-act="person-remove" data-email="${esc(m.email)}" aria-label="Remove ${esc(m.email)}">×</button></td></tr>`).join("");
    return `<section class="card">
      <h2>People in this account</h2>
      <p><strong>Administrators</strong> can change anything on the sides they have, and give people access. <strong>Employees</strong> can see prices and costs, make and change their own recipes, and add new items with an estimated price for an administrator to double check. Tick <strong>Inventory</strong> to let an employee do the count.</p>
      ${rows ? `<div class="table-wrap"><table class="list people"><thead><tr><th>Who</th><th>Role</th><th>Access</th><th><span class="vh">Remove</span></th></tr></thead><tbody>${rows}</tbody></table></div>` : ""}
      <div class="people__add">
        <label class="block">Their email<input class="in" type="email" id="inviteEmail" autocomplete="off" placeholder="name@example.com" /></label>
        <label class="block">Role<select class="in" id="inviteRole"><option value="employee">Employee</option><option value="admin">Administrator</option></select></label>
        <div class="people__access"><label class="check"><input type="checkbox" id="inviteKitchen" checked /> ${esc(SITE.name)}</label>${bar ? `<label class="check"><input type="checkbox" id="inviteBarback" /> Barback</label>` : ""}<label class="check"><input type="checkbox" id="inviteCount" /> Inventory</label></div>
        <button class="btn btn--main" data-act="person-invite">Give access</button>
      </div>
      <p class="hint">We don't send an email, so let them know. They'll see it when they sign in or sign up with that address, and their own account stays separate. What they make here stays here if they leave.</p>
    </section>`;
  }
  /** Someone in another person's account: where they stand, and leaving. */
  function myPlaceCard() {
    if (!ACCOUNT) return "";
    return `<section class="card">
      <h2>${esc(ACCOUNT.name || "This account")}</h2>
      <p>You're here as ${ACCOUNT.role === "admin" ? "an administrator" : "an employee"}, with access to ${esc(accessWords(ACCOUNT))}. Your own account is separate: the list at the top goes back to it. Whatever you make here stays here.</p>
      <button class="btn btn--danger" data-act="leave-account">Leave this account</button>
    </section>`;
  }

  /* ---------- bringing recipes in from another account ---------- */
  const bring = { from: null, rows: null, recipes: new Set(), items: new Set() };
  const bringSources = () => (Store.teamsReady() ? Transfer.sources(joined, Store.me(), Store.account()) : []);
  const bringLink = () => (bringSources().length ? `<a class="btn" href="#/bring">Import from…</a>` : "");
  function bringPage() {
    const list = bringSources();
    const back = `<p class="crumbs"><a href="#/dishes">← Dishes</a></p>`;
    if (!list.length) return back + `<h1>Import</h1><p class="muted">There's nothing you can import from here. You can always bring your own account's recipes into a restaurant's. Taking a restaurant's out takes being its administrator.</p>`;
    const name = (s) => (s.own ? "My account" : s.name || "A restaurant");
    const side = Store.project();
    const picker = `<label class="block">Import from <select class="in" data-k="bring-from" data-act="bring-from"><option value="">Pick one…</option>${list.map((s) => `<option value="${esc(s.id)}"${bring.from === s.id ? " selected" : ""}>${esc(name(s))}</option>`).join("")}</select></label>`;
    if (!bring.rows) return back + `<h1>Import</h1><section class="card card--flat">${picker}</section>`;
    const onSide = (r) => (r.project || "kitchen") === side;
    const row = (x, kind, what) => `<tr data-search="${esc(x.name.toLowerCase())}"><td><label class="check"><input type="checkbox" data-k="bp-${esc(x.id)}" data-act="bring-pick" data-kind="${kind}" data-id="${esc(x.id)}" ${bring[kind].has(x.id) ? "checked" : ""} /> ${esc(x.name)}</label></td><td class="muted">${what}</td></tr>`;
    const dishes = bring.rows.recipes.filter((r) => onSide(r) && r.kind === "dish").sort(byName), preps = bring.rows.recipes.filter((r) => onSide(r) && r.kind === "prep").sort(byName), items = bring.rows.ingredients.filter(onSide).sort(byName);
    const n = bring.recipes.size + bring.items.size;
    return `${back}
      <div class="bar"><h1>Import</h1><button class="btn btn--main" data-act="bring-go" ${n ? "" : "disabled"}>Import ${n || ""} into ${esc(ACCOUNT ? ACCOUNT.name || "this account" : "my account")}</button></div>
      <section class="card card--flat">${picker}
        <p class="hint">Copies, so the original stays as it is. A recipe brings along what it needs: its preps and items. An item or prep with the same name that's already here is used instead. ${isEmployee() ? "New items keep their price as an estimate, flagged for an administrator to double check." : ""}</p></section>
      <div class="filters"><input type="search" placeholder="Search" data-filter aria-label="Search" /></div>
      <div class="table-wrap"><table class="list cards"><thead><tr><th>Name</th><th>Kind</th></tr></thead><tbody>
        ${dishes.map((x) => row(x, "recipes", "dish")).join("")}${preps.map((x) => row(x, "recipes", "prep")).join("")}${items.map((x) => row(x, "items", "ingredient")).join("") || ""}
        ${dishes.length + preps.length + items.length ? "" : `<tr><td colspan="2" class="muted">Nothing there on this side yet.</td></tr>`}
      </tbody></table></div>`;
  }

  /** Over to the other records. `then`: the page to open there (else the same page, when there's one on both sides). */
  let switching = false;
  async function switchProject(name, then) {
    if (switching || name === Store.project()) return;
    switching = true;
    wantedProject = name;
    try { localStorage.setItem(PROJECT_KEY, name); } catch { /* this visit only */ }
    await goOver(then);
  }
  /** The other records, or someone else's account: wait for saves, then draw everything again from there. */
  async function goOver(then) {
    // Anything still saving goes in the records it was typed for.
    for (let k = 0; k < 100 && write.busy; k++) await new Promise((r) => setTimeout(r, 50));
    listFilters.clear(); cameFrom.clear(); scrolled.clear();
    bring.from = null; bring.rows = null; bring.recipes.clear(); bring.items.clear();
    main.setAttribute("aria-busy", "true");
    const page = route().page, onBoth = ["dishes", "preps", "ingredients", "inventory", "invoices", "changes", "settings"];
    const to = then || (onBoth.includes(page) ? null : page === "ingredient" ? "#/ingredients" : page === "summary" || page === "spending" ? "#/inventory" : "#/dishes");
    if (to && to !== location.hash) location.hash = to;
    try { await start(); }
    finally { main.removeAttribute("aria-busy"); switching = false; }
    window.scrollTo(0, 0);
    backupToDrive(false);
  }

  /** The kitchen's words become the bar's, over a page once it's drawn. Names and what's typed stay as they are. */
  function sayAll(el) {
    const leave = 'a[href^="#/recipe/"], a[href^="#/ingredient/"], textarea, option:not([value])';
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!/[A-Za-z×]/.test(n.nodeValue) || n.parentElement.closest(leave)) continue;
      const s = Barback.say(n.nodeValue);
      if (s !== n.nodeValue) n.nodeValue = s;
    }
    el.querySelectorAll("[placeholder], [aria-label], [title]").forEach((x) => {
      for (const a of ["placeholder", "aria-label", "title"]) {
        const v = x.getAttribute(a);
        if (v && !x.closest('a[href^="#/recipe/"], a[href^="#/ingredient/"]')) { const s = Barback.say(v); if (s !== v) x.setAttribute(a, s); }
      }
    });
  }

  /** What Barback's costs are worked out from: its own rows and the kitchen's, so a kitchen price moves a cocktail's cost. */
  function withKitchen() {
    const k = Store.borrowed();
    return { ingredients: [...data.ingredients, ...k.ingredients], offers: [...data.offers, ...k.offers], recipes: [...data.recipes, ...k.recipes], lines: [...data.lines, ...k.lines] };
  }
  // From the kitchen: the Barback lines that use something of the kitchen's, and the cocktails or preps they're in.
  const barLines = (field, id) => (BAR ? [] : Store.borrowed().lines.filter((l) => l[field] === id));
  const barUses = (field, id) => [...new Set(barLines(field, id).map((l) => l.recipe_id))].map((rid) => Store.borrowed().recipes.find((r) => r.id === rid)).filter(Boolean).sort(byName);
  const lineThere = (id) => get("lines", id) || Store.borrowed().lines.find((l) => l.id === id);
  const barTag = `<span class="tag tag--bar">Barback</span>`;
  const estimatedTag = `<span class="tag tag--est" title="An estimated price, waiting for an administrator to double check it">estimated</span>`;
  const kitchenTag = () => `<span class="tag tag--kitchen">${esc(SITE.name)}</span>`;

  /** What's typed on a cocktail line, found in the kitchen: "Lime (Commis)", "Syrup (Commis prep)", or a plain name that's only there. */
  function kitchenPick(text) {
    const k = Store.borrowed(), lower = text.trim().toLowerCase();
    const asItem = ` (${SITE.name})`.toLowerCase(), asPrep = ` (${SITE.name} prep)`.toLowerCase();
    const named = (list, name) => list.find((x) => x.name.toLowerCase() === name);
    const preps = k.recipes.filter((r) => r.kind === "prep");
    if (lower.endsWith(asPrep)) return { sub: named(preps, lower.slice(0, -asPrep.length)) };
    if (lower.endsWith(asItem)) return { ing: named(k.ingredients, lower.slice(0, -asItem.length)) };
    const ing = named(k.ingredients, lower);
    return ing ? { ing } : { sub: named(preps, lower) };
  }

  /** A kitchen item or prep, seen from Barback: read only, with a way over to it. */
  function kitchenPage(isPrep, x, from) {
    const offer = isPrep ? null : coster.defaultOffer(x.id);
    const price = isPrep ? coster.recipeCost(x.id).perYield : offer ? offer.price : null, unit = isPrep ? x.yield_unit : x.base;
    const field = isPrep ? "sub_recipe_id" : "ingredient_id";
    const users = [...new Set(data.lines.filter((l) => l[field] === x.id).map((l) => l.recipe_id))].map((id) => data.recipes.find((r) => r.id === id)).filter(Boolean).sort(byName);
    return `
      <p class="crumbs"><a href="#/${isPrep ? "preps" : "ingredients"}">← ${isPrep ? "Preps" : "Ingredients"}</a>${backLink(from)}</p>
      <div class="bar">
        <h1>${esc(x.name)} ${kitchenTag()}</h1>
        <button class="btn" data-act="open-in-kitchen" data-page="${isPrep ? "recipe" : "ingredient"}" data-id="${esc(x.id)}">Open in ${esc(SITE.name)}</button>
      </div>
      <section class="card card--flat">
        <p><strong>${price == null ? "No price yet" : money(price, true) + per(unit)}</strong>${offer && offer.offer.supplier ? ` · ${esc(offer.offer.supplier)}` : ""}</p>
        <p class="hint">This lives in ${esc(SITE.name)}, so Barback only reads it. When its price changes there, every cocktail using it follows. To change it, open it in ${esc(SITE.name)}.</p>
      </section>
      <h2>Used in (${users.length})</h2>
      ${users.length ? `<ul class="plain">${users.map((r) => `<li><a href="#/recipe/${encodeURIComponent(r.id)}">${esc(r.name)}</a> <span class="tag">${r.kind}</span></li>`).join("")}</ul>` : `<p class="muted">Nothing in Barback uses it yet.</p>`}`;
  }

  /** On Barback's lists: what can also be used from the kitchen, out of the way until you want it. */
  function kitchenFold(isPrep) {
    if (!BAR) return "";
    const k = Store.borrowed(), list = (isPrep ? k.recipes.filter((r) => r.kind === "prep") : k.ingredients).slice().sort(byName);
    if (!list.length) return "";
    const key = isPrep ? "kitchen-preps" : "kitchen-items";
    const row = (x) => {
      const price = isPrep ? coster.recipeCost(x.id).perYield : (coster.defaultOffer(x.id) || {}).price;
      return `<li><a href="#/${isPrep ? "recipe" : "ingredient"}/${encodeURIComponent(x.id)}">${esc(x.name)}</a> <span class="muted small nowrap">${price == null ? "no price" : money(price, true) + per(isPrep ? x.yield_unit : x.base)}</span></li>`;
    };
    return `<section class="card card--flat kitchen-fold"><details class="fold" data-k="${key}"${detailsOpen.get(key) ? " open" : ""}>
      <summary><h2>From ${esc(SITE.name)}</h2><span class="small muted">${list.length} ${isPrep ? "preps" : "items"} your cocktails can use</span></summary>
      <p class="hint">Read only. Type one's name on a cocktail and it uses ${esc(SITE.name)}'s price, today's and any later one.</p>
      <ul class="plain kitchen-fold__list">${list.map(row).join("")}</ul>
    </details></section>`;
  }

  /** What a bottle and an ounce of it cost, under the price per litre. */
  function pourLine(i, perLitre) {
    if (i.base !== "L") return "";
    const ml = Barback.bottleMl(i), p = Barback.pours(perLitre, ml);
    return `<div class="muted small">${p.bottle != null ? money(p.bottle) + " a bottle · " : ""}${money(p.oz, true)}/oz</div>`;
  }

  /** A bottle's size, and what it weighs empty and full so opened ones can go on the scale. */
  function bottleCard(i) {
    const ml = Barback.bottleMl(i), def = coster.defaultOffer(i.id), empty = parseNum(i.empty_g), full = parseNum(i.full_g);
    const box = (field, label, value, unit, more = "") => `<label>${label} <span class="bottle__box"><input class="in in--num" inputmode="decimal" ${more} data-k="b-${field}" data-act="bottle-field" data-field="${field}" data-id="${esc(i.id)}" value="${esc(numText(value))}" aria-label="${label}, in ${unit}" /> ${unit}</span></label>`;
    const p = def && ml ? Barback.pours(def.price, ml) : null;
    return `<section class="card card--flat bottle">
      <h2>The bottle</h2>
      <div class="bottle__boxes">
        ${box("size", "Size", ml, "ml", `list="dl-bottle-sizes" data-suggest-all`)}
        ${box("empty_g", "Empty", empty, "g")}
        ${box("full_g", "Full", full, "g")}
      </div>
      ${p ? `<p class="bottle__price"><strong>${money(p.bottle)}</strong> a bottle · <strong>${money(p.oz, true)}</strong>/oz</p>` : ""}
      ${empty && full && full <= empty ? `<p class="note note--bad">Full has to be heavier than empty.</p>` : ""}
      <p class="hint">The size lets you count it in bottles. Weigh an empty one and a full one once, with the pourer you use, and on the count you can count the full bottles and weigh the opened ones.</p>
    </section>`;
  }

  /** The first price the size of one bottle gives a bottle its size, and the size follows that price while it was the same. */
  async function sizeBottle(ingId, qty, unit, was = null) {
    const i = BAR && get("ingredients", ingId);
    if (!i || i.base !== "L" || fromKitchen("ingredients", ingId)) return;
    const now = Barback.bottleMl(i), ml = Barback.sizeFromPack(qty, unit);
    if (ml && ml !== now && (now == null || now === was)) await patch("ingredients", i.id, { measures: Barback.withBottleSize(i, ml) });
  }

  /** Beside a bottle's full count on the inventory: what its opened bottles weigh. */
  function openBox(r, month) {
    const i = r.item;
    return `<span class="count-tare count-open">+ <input class="in in--open" data-k="cnt-o-${i.id}" data-act="count-open" data-id="${esc(i.id)}" data-month="${month}" value="${esc(r.openG)}" aria-label="What the opened bottles of ${esc(i.name)} weigh, in grams. Two opened: 840+700" /> g opened${r.openG && r.qty != null ? ` = <strong>${esc(numText(+r.qty.toFixed(2)))} bottles</strong>` : ""}</span>`;
  }

  /* ---------- routing ---------- */
  function route() {
    // "#/recipe/<prep>/from/<dish>" (or "#/ingredient/<item>/from/<dish>"): opened from a dish or prep, with a way back
    // to it. "#/recipe/<prep>/new/<dish>": a prep just made for that dish.
    const [page, id, word, from] = location.hash.replace(/^#\/?/, "").split("/");
    return { page: page || "dishes", id: id ? decodeURIComponent(id) : null, from: (word === "from" || word === "new") && from ? decodeURIComponent(from) : null, isNew: word === "new" };
  }
  // Where each recipe page was opened from, so "Back to" keeps working two levels down (dish → prep → its prep).
  const cameFrom = new Map();
  const scrolled = new Map(); // page → how far down it was scrolled when you left it
  const backHref = (r) => `#/recipe/${encodeURIComponent(r.id)}${cameFrom.has(r.id) ? "/from/" + encodeURIComponent(cameFrom.get(r.id)) : ""}`;
  const backLink = (from) => (from ? ` <a class="btn btn--small btn--back" href="${backHref(from)}">← Back to ${esc(from.name)}</a>` : "");

  function render() {
    closeSuggestions();
    // Commis: nothing but the welcome page until you're signed in (no "this browser only" mode).
    const out = SITE.commis && Auth.configured() && (!Auth.signedIn() || authView.mode === "reset");
    document.body.classList.toggle("signed-out", out);
    if (out) { document.documentElement.classList.remove("home-wait"); main.innerHTML = authPage(); return; }
    const r = route();
    document.querySelectorAll("[data-nav]").forEach((a) => {
      const on = a.dataset.nav === r.page || (r.page === "recipe" && a.dataset.nav === kindNav()) || (r.page === "ingredient" && a.dataset.nav === "ingredients") || (r.page === "import" && a.dataset.nav === "preps") || (r.page === "summary" && a.dataset.nav === "inventory") || (r.page === "spending" && a.dataset.nav === "invoices");
      a.classList.toggle("on", on);
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    // Typing in a box while a save is still under way (online it takes a moment): the redraw keeps that text, the box
    // and the cursor, rather than wiping it.
    const active = document.activeElement;
    const typed = active && main.contains(active) && active.matches("input, textarea") && draftable(active) && active.value !== active.defaultValue
      ? { k: active.dataset.k, value: active.value, a: active.selectionStart, b: active.selectionEnd } : null;
    const focusKey = (typed && typed.k) || render.nextFocus || (active && active.dataset ? active.dataset.k : null);
    const enterFrom = typed ? null : render.enterFrom;
    render.nextFocus = render.enterFrom = null;
    const scroll = window.scrollY;
    // Leaving a page: remember where it was scrolled, for "Back to" (which returns there, not to the top).
    const key = (rr) => rr.page + "/" + (rr.id || "");
    if (render.samePage && render.samePage !== location.hash && render.lastKey) scrolled.set(render.lastKey, scroll);
    const views = { dishes: () => recipeList("dish"), preps: () => recipeList("prep"), recipe: () => recipePage(r.id), ingredients: ingredientList,
      ingredient: () => ingredientPage(r.id), inventory: () => inventoryPage(r.id), summary: () => summaryPage(r.id), spending: () => spendingPage(r.id), invoices: invoicesPage, changes: changesPage, settings: settingsPage,
      menu: () => menuPage(r.id), bring: bringPage,
      ...(SITE.commis ? {} : { import: importPage }) };
    main.innerHTML = ((pageAllowed(r.page) && views[r.page]) || views.dishes)();
    if (isEmployee()) lockDown();
    if (BAR) sayAll(main);
    if (focusKey) {
      let el = main.querySelector(`[data-k="${CSS.escape(focusKey)}"]`);
      // After Enter: if the save filled in the box it was going to (an invoice line's pack), look again from there.
      const from = enterFrom && (!el || el.value.trim()) && main.querySelector(`[data-k="${CSS.escape(enterFrom)}"]`);
      if (from) el = nextBox(from) || el;
      if (el) { el.focus(); if (enterFrom && el.select) el.select(); }
    }
    if (typed) {
      const el = main.querySelector(`[data-k="${CSS.escape(typed.k)}"]`);
      if (el && el.value !== typed.value) { el.value = typed.value; try { el.setSelectionRange(typed.a, typed.b); } catch { /* not a text box */ } }
    }
    render.restored = false;
    if (render.samePage === location.hash) window.scrollTo(0, scroll);
    else if (render.goingBack && scrolled.has(key(r))) { window.scrollTo(0, scrolled.get(key(r))); render.restored = true; }
    render.goingBack = false;
    render.samePage = location.hash;
    render.lastKey = key(r);
    afterRender();
  }
  function kindNav() {
    const rec = get("recipes", route().id);
    return rec && rec.kind === "prep" ? "preps" : "dishes";
  }

  // Filters in lists work on the drawn rows, so typing doesn't redraw the page.
  const listFilters = new Map(); // per page, this visit only (see afterRender)
  /** A recipe's lines are a table when it fits and one card per line when it doesn't, so they never scroll sideways. */
  function fitLines() {
    const table = main.querySelector(".lines--recipe");
    if (!table) return;
    table.classList.remove("lines--stack");
    const box = table.closest(".table-wrap");
    if (window.innerWidth <= 760 || box.scrollWidth > box.clientWidth + 1) table.classList.add("lines--stack");
  }
  function afterRender() {
    fitLines();
    main.querySelectorAll("input[list]").forEach(ownList);
    drawHistChart();
    // On a phone, tables marked .cards show one card per row: each value is labelled with its column's heading.
    main.querySelectorAll("table.cards").forEach((t) => {
      const heads = [...t.querySelectorAll("thead th")].map((th) => th.textContent.trim());
      t.querySelectorAll("tbody tr").forEach((tr) => {
        if (tr.children.length !== heads.length) return;
        // (not on an empty cell: a label over nothing)
        [...tr.children].forEach((td, k) => { if (k && heads[k] && !td.dataset.label && (td.textContent.trim() || td.querySelector("input, select, button"))) td.dataset.label = heads[k]; });
      });
    });
    showDrafts();
    const box = $("[data-filter]", main);
    if (!box) return;
    const secs = $("[data-filter-sections]", main);
    const sel = $("[data-filter-group]", main), flagged = $("[data-filter-flag]", main), noPrice = $("[data-filter-noprice]", main);
    // The search, menu and ticks as they were on this page: a change that redraws it (a dish moved from "Noel" to
    // "Noel 2026") leaves the list filtered, so you can carry on down it without searching again.
    const was = listFilters.get(location.hash);
    if (was) {
      box.value = was.q;
      if (sel && [...sel.options].some((o) => o.value === was.g)) sel.value = was.g;
      if (flagged) flagged.checked = was.flag;
      if (noPrice) noPrice.checked = was.noPrice;
    }
    const apply = () => {
      listFilters.set(location.hash, { q: box.value, g: sel ? sel.value : "", flag: !!(flagged && flagged.checked), noPrice: !!(noPrice && noPrice.checked) });
      const q = box.value.trim().toLowerCase();
      const g = sel ? sel.value : "";
      const picked = new Set(secs ? [...secs.querySelectorAll("[data-sec][aria-pressed=true]")].map((b) => b.dataset.sec) : []);
      let shown = 0;
      main.querySelectorAll("tr[data-search]").forEach((tr) => {
        const ok = (!q || tr.dataset.search.includes(q)) && (!g || tr.dataset.group === g) && (!picked.size || picked.has(tr.dataset.sec != null ? tr.dataset.sec : tr.dataset.group))
          && (!flagged || !flagged.checked || tr.dataset.flag === "1") && (!noPrice || !noPrice.checked || tr.dataset.noprice === "1");
        tr.hidden = !ok;
        if (ok) shown++;
      });
      // A section heading shows only while something under it does.
      main.querySelectorAll("tr[data-section]").forEach((head) => {
        let tr = head.nextElementSibling, any = false;
        while (tr && !tr.dataset.section) { if (!tr.hidden) { any = true; break; } tr = tr.nextElementSibling; }
        head.hidden = !any;
      });
      const c = $("[data-count]", main);
      if (c) c.textContent = shown;
      // Inventory: what the picked sections are worth together.
      const sum = $("[data-picked-total]", main);
      if (sum) {
        const heads = [...main.querySelectorAll("tr[data-section][data-value]")].filter((h) => picked.has(h.dataset.section));
        sum.hidden = !heads.length;
        sum.textContent = heads.length ? `${heads.map((h) => h.dataset.section).join(" + ")}: ${money(heads.reduce((s, h) => s + +h.dataset.value, 0))}` : "";
      }
      // A printed sheet of some sections says so, so it isn't taken for the whole count.
      const onPaper = $("[data-picked-print]", main);
      if (onPaper) onPaper.textContent = picked.size ? `Sections: ${[...picked].join(", ")}` : "";
    };
    main.querySelectorAll("[data-filter], [data-filter-group], [data-filter-flag], [data-filter-noprice]").forEach((el) => el.addEventListener(el.tagName === "INPUT" && el.type !== "checkbox" ? "input" : "change", apply));
    if (secs) secs.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      // A section switches on or off, so several can be on at once; "All" switches them all off.
      if (b.hasAttribute("data-sec-all")) secs.querySelectorAll("[data-sec]").forEach((x) => x.setAttribute("aria-pressed", "false"));
      else b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true"));
      const on = [...secs.querySelectorAll("[data-sec][aria-pressed=true]")].map((x) => x.dataset.sec);
      secs.querySelector("[data-sec-all]").setAttribute("aria-pressed", String(!on.length));
      writeJSON(SECTIONS, { ...readJSON(SECTIONS, {}), [secs.dataset.filterSections]: on });
      apply();
    });
    apply();
  }

  /* ---------- shared bits ---------- */
  function changeChip(s) {
    if (!s.change) return "";
    const up = s.change > 0;
    return `<span class="chip ${up ? "chip--up" : "chip--down"}" title="Cost per portion was ${money(s.ack)}, now ${money(s.perPortion)}">${up ? "▲" : "▼"} ${money(Math.abs(s.change))}${s.changePct != null ? ` (${up ? "+" : "−"}${((p) => p.toFixed(p < 1 ? 1 : 0))(Math.abs(s.changePct * 100))}%)` : ""}</span>`;
  }
  function foodCostCell(s) {
    if (s.foodCost == null) return `<span class="muted">—</span>`;
    return `<span class="fc ${s.over ? "fc--over" : "fc--ok"}">${pct(s.foodCost)}</span>`;
  }
  const flagIcon = (text) => (text ? `<span class="flag" title="${esc(text)}" aria-label="Needs checking">!</span>` : "");

  /* ---------- dishes and preps ---------- */
  // Dish categories, in your order (Settings → Categories; menu order until you set one); any other one typed comes
  // after them (A to Z), then dishes without one.
  const DISH_CATS = ["Grignoter", "Entrée", "Plats", "Dessert", "Extra"];
  const dishCatList = () => (settings.categories && settings.categories.dishes) || DISH_CATS;
  const NO_CAT = "No category";
  const dishCat = (r) => (r.category || "").trim() || NO_CAT;
  const catRank = (c) => { const k = dishCatList().findIndex((x) => fold(x) === fold(c)); return k >= 0 ? k : c === NO_CAT ? 1e6 : 1e5; };
  const byCat = (a, b) => catRank(dishCat(a)) - catRank(dishCat(b)) || dishCat(a).localeCompare(dishCat(b), "fr", { sensitivity: "base" }) || byName(a, b);
  // "entree", "plat" and "pl" become "Entrée" and "Plats": the standard spelling or the one already in use (capitals,
  // accents and a final s don't matter, and a start that fits only one category is enough), so a category never splits in two.
  function catSpelling(v) {
    const t = v.trim(), key = (c) => fold(c).replace(/s$/, "");
    if (!t) return "";
    const known = dishCatList().concat(data.recipes.map((r) => (r.category || "").trim()).filter((c) => c && !dishCatList().some((d) => key(d) === key(c))));
    const same = known.find((c) => key(c) === key(t));
    if (same) return same;
    const starts = [...new Set(known.filter((c) => fold(t).length >= 2 && fold(c).startsWith(fold(t))))];
    return starts.length === 1 ? starts[0] : t;
  }

  // Dishes grouped by the menu they're on: dated menus newest first ("Menu 2026-10-08"), then the others A to Z.
  const NO_MENU = "No menu";
  const dishMenu = (r) => (r.menu || "").trim() || NO_MENU;
  const menuDate = (m) => { const d = m.match(/(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/); return d ? +d[1] * 10000 + +d[2] * 100 + +(d[3] || 0) : 0; };
  const byMenu = (a, b) => { const x = dishMenu(a), y = dishMenu(b); return (x === NO_MENU) - (y === NO_MENU) || menuDate(y) - menuDate(x) || x.localeCompare(y, "fr", { sensitivity: "base" }) || byName(a, b); };
  // A menu typed like one already in use ("menu, extra") takes its spelling; anything else is a new menu.
  const menuSpelling = (v) => { const t = v.trim(); return data.recipes.map((r) => (r.menu || "").trim()).find((m) => m && fold(m) === fold(t)) || t; };
  const DISH_GROUP = "costing.dishGroup";

  function recipeList(kind) {
    const isDish = kind === "dish";
    const byMenuNow = isDish && readJSON(DISH_GROUP, "category") === "menu";
    const groupOf = byMenuNow ? dishMenu : dishCat;
    const list = data.recipes.filter((r) => r.kind === kind).sort(!isDish ? byName : byMenuNow ? byMenu : byCat);
    const menus = [...new Set(list.map((r) => r.menu).filter(Boolean))].sort((a, b) => b.localeCompare(a));
    let current = null;
    const rows = list.map((r) => {
      const s = coster.summary(r.id);
      const flag = r.review || s.problems.length ? "1" : "0";
      const group = isDish ? groupOf(r) : null;
      const head = isDish && group !== current ? `<tr class="section-row" data-section="${esc(group)}"><th colspan="8" scope="colgroup">${esc(group)}${byMenuNow && group !== NO_MENU
        ? ` <a class="section-row__link" href="#/menu/${encodeURIComponent(group)}">Open menu →</a>` : ""}</th></tr>` : "";
      current = group;
      return head + `<tr data-search="${esc((r.name + " " + (r.menu || "") + " " + (r.category || "")).toLowerCase())}" data-group="${esc(r.menu || "")}" ${isDish ? `data-sec="${esc(group)}"` : ""} data-flag="${flag}">
        <td><a href="#/recipe/${encodeURIComponent(r.id)}">${esc(r.name)}</a> ${flagIcon(r.review)}${s.problems.length ? `<span class="warn" title="${esc([...new Set(s.problems)].join(", "))}">missing prices</span>` : ""}</td>
        ${isDish ? `<td class="hide-sm"><input class="in in--cat" list="dl-dish-cats" data-suggest-all data-k="dcat-${esc(r.id)}" data-act="dish-cat" data-id="${esc(r.id)}" value="${esc(r.category || "")}" placeholder="Category" aria-label="Category of ${esc(r.name)}" /></td>
          <td class="hide-sm"><input class="in in--menu" list="dl-menus" data-suggest-all data-k="dmenu-${esc(r.id)}" data-act="dish-menu" data-id="${esc(r.id)}" value="${esc(r.menu || "")}" placeholder="Menu" aria-label="Menu of ${esc(r.name)}" /></td>` : ""}
        <td class="num">${money(s.perPortion)}${isDish ? "" : `<span class="muted">${per(r.yield_unit)}</span>`}</td>
        ${isDish ? `<td class="num">${money(s.suggested)}</td><td class="num">${money(s.menuPrice)}</td><td class="num">${foodCostCell(s)}</td>` : `<td class="num">${money(s.total)}</td><td class="num muted">${numText(r.yield_qty)} ${esc(unitLabel(r.yield_unit))}</td>`}
        <td>${changeChip(s)}</td>
      </tr>`;
    }).join("");
    return `
      <div class="bar">
        <h1>${isDish ? "Dishes" : "Preps"} <span class="muted small">(<span data-count>${list.length}</span>)</span></h1>
        <div class="actions" style="margin:0">${bringLink()}<button class="btn btn--main" data-act="new-recipe" data-kind="${kind}">+ New ${isDish ? "dish" : "prep"}</button></div>
      </div>
      <div class="filters">
        <input type="search" placeholder="Search" data-filter aria-label="Search" />
        ${isDish && !byMenuNow ? `<select data-filter-group aria-label="Menu"><option value="">All menus</option>${menus.map((m) => `<option>${esc(m)}</option>`).join("")}</select>` : ""}
        <label class="check"><input type="checkbox" data-filter-flag /> Needs checking</label>
        ${isDish ? `<span class="group-by" role="group" aria-label="Group dishes by"><span class="muted">Group by</span>
          <button type="button" class="sec" data-act="dish-group" data-by="category" aria-pressed="${!byMenuNow}">Category</button>
          <button type="button" class="sec" data-act="dish-group" data-by="menu" aria-pressed="${byMenuNow}">Menu</button></span>` : ""}
      </div>
      ${isDish ? sectionChips(byMenuNow ? "dishes-menu" : "dishes", list.map(groupOf)) : ""}
      ${isDish && Store.part9Old() ? `<p class="note note--bad">Run part 9 of supabase/schema.sql in Supabase (SQL Editor) to save dish categories.</p>` : ""}
      ${isDish ? `<p class="hint">Target: cost × multiplier (×4 by default, a 25% food cost). <span class="fc fc--ok">on target</span> = at or under target, <span class="fc fc--over">over</span> = over it.</p>` : `<p class="hint">${SITE.commis ? "Preps are the things you make ahead (sauces, doughs, stocks…): cost them once, then use them in any dish." : `Preps are the "Recipe 1–6" tabs of your costing sheets. Use them in any dish.`}</p>`}
      <div class="table-wrap"><table class="list cards">
        <thead><tr><th>Name</th>${isDish ? "<th class=hide-sm>Category</th><th class=hide-sm>Menu</th><th class=num>Cost / portion</th><th class=num>Target</th><th class=num>Menu price</th><th class=num>Food cost</th>" : "<th class=num>Cost / portion</th><th class=num>Batch cost</th><th class=num>Makes</th>"}<th>Since last check</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="8" class="muted">${SITE.commis ? `Nothing yet: add your first one with “+ New ${isDish ? "dish" : "prep"}”.` : "Nothing yet. Import your sheets in Settings, or add one."}</td></tr>`}</tbody>
      </table></div>
      ${isDish ? "" : kitchenFold(true)}`;
  }

  /* ---------- scaling a recipe to a standard ---------- */
  // "Set the pork to 1 kg": every line, what it makes and its other measure follow by the same factor.
  let scaling = null; // { id: recipe, line: line id, qty, unit } while the Scale box is open
  function lineUnit(l) {
    if (l.unit) return l.unit;
    const ing = l.ingredient_id && get("ingredients", l.ingredient_id), sub = l.sub_recipe_id && get("recipes", l.sub_recipe_id);
    return ing ? ing.base : sub ? sub.yield_unit : "unit";
  }
  const lineName = (l) => { const x = l.ingredient_id ? get("ingredients", l.ingredient_id) : get("recipes", l.sub_recipe_id); return x ? x.name : "(deleted)"; };
  // Amounts after scaling: whole numbers from 100 up, else 3 significant figures (102 g, 9.18 g, 11.4 g).
  const scaled = (v) => (v == null ? null : Math.abs(v) >= 100 ? Math.round(v) : +v.toPrecision(3));
  // What a standard is set in: kg for a weight, L for a volume, else the line's own unit.
  const scaleUnit = (l) => ({ kg: "kg", L: "L" }[Units.baseOf(lineUnit(l))] || lineUnit(l));
  function scalePlan(r, sc) {
    const lines = data.lines.filter((l) => l.recipe_id === r.id).sort((a, b) => (a.pos || 0) - (b.pos || 0));
    const base = lines.find((l) => l.id === sc.line);
    if (!base) return { error: "Pick the ingredient to set." };
    const now = parseNum(base.qty), want = parseNum(sc.qty);
    if (!(now > 0)) return { error: `${lineName(base)} has no amount yet.` };
    if (!(want > 0)) return { error: "Type the amount it should be." };
    const target = Units.convert(want, sc.unit, lineUnit(base));
    if (target == null) return { error: `${lineName(base)} is in ${plural(lineUnit(base))}: set it in ${plural(lineUnit(base))} too.` };
    const f = target / now;
    const rows = lines.map((l) => ({ l, name: lineName(l), unit: lineUnit(l), now: parseNum(l.qty), after: l.id === base.id ? +target.toPrecision(6) : scaled(parseNum(l.qty) == null ? null : parseNum(l.qty) * f) }));
    const y = parseNum(r.yield_qty) || 1, alt = parseNum(r.alt_qty);
    const more = Costing.savedMeasures(r).map((m) => ({ unit: m.unit, now: m.qty, after: +(m.qty * f).toPrecision(4) }));
    return { f, base, rows, yieldNow: y, yieldAfter: +(y * f).toPrecision(4), altNow: alt, altAfter: alt ? +(alt * f).toPrecision(4) : null, more };
  }
  // The standard saved for a recipe's card (settings.cardScale[recipe id] = { line, qty, unit }), worked out, or null.
  const cardStandard = (r) => { const sc = (settings.cardScale || {})[r.id]; const p = sc && scalePlan(r, sc); return p && !p.error ? { sc, p } : null; };
  function scaleBox(r) {
    const amounts = data.lines.filter((l) => l.recipe_id === r.id && parseNum(l.qty) > 0);
    if (!amounts.length) return "";
    const saved = cardStandard(r);
    const amt = (q, u) => (q == null ? "—" : `${esc(numText(q))} ${esc(unitLabel(u))}`);
    const table = (p) => `<div class="table-wrap"><table class="list small"><thead><tr><th>Item</th><th class="num">Recipe</th><th class="num">On the card</th></tr></thead><tbody>
        ${p.rows.map((x) => `<tr${x.l.id === p.base.id ? ` class="scale__base"` : ""}><td>${esc(x.name)}</td><td class="num">${amt(x.now, x.unit)}</td><td class="num"><strong>${amt(x.after, x.unit)}</strong></td></tr>`).join("")}
        <tr><td>Yield</td><td class="num">${amt(p.yieldNow, r.yield_unit)}</td><td class="num"><strong>${amt(p.yieldAfter, r.yield_unit)}</strong></td></tr>
        ${p.altNow ? `<tr><td>${r.yield_unit === "portion" ? "Batch weighs" : "Gives"}</td><td class="num">${amt(p.altNow, r.alt_unit)}</td><td class="num"><strong>${amt(p.altAfter, r.alt_unit)}</strong></td></tr>` : ""}
        ${p.more.map((m) => `<tr><td>Gives</td><td class="num">${amt(m.now, m.unit)}</td><td class="num"><strong>${amt(m.after, m.unit)}</strong></td></tr>`).join("")}
      </tbody></table></div>`;
    // Not being changed: what the card shows now.
    if (!scaling || scaling.id !== r.id) {
      if (!saved) return `<div class="scale-open"><button class="btn btn--small" data-act="scale-open" data-id="${esc(r.id)}">Scale the card…</button>
        <span class="hint">Write the card for a standard amount of one ingredient (e.g. 1 kg of pork); the recipe and its costs don't change.</span></div>`;
      return `<div class="scale scale--saved">
        <p>On the card, everything is scaled so <strong>${esc(saved.p.rows.find((x) => x.l.id === saved.p.base.id).name)}</strong> is <strong>${esc(numText(saved.sc.qty))} ${esc(unitLabel(saved.sc.unit))}</strong> (× ${esc(numText(+saved.p.f.toPrecision(4)))}). The recipe and its costs stay as they are.</p>
        <details><summary>See the card's amounts</summary>${table(saved.p)}</details>
        <div class="actions"><button class="btn btn--small" data-act="scale-open" data-id="${esc(r.id)}">Change</button><button class="btn btn--small" data-act="scale-clear" data-id="${esc(r.id)}">Use the recipe's amounts on the card</button></div>
      </div>`;
    }
    const sc = scaling, p = scalePlan(r, sc);
    const baseUnit = p.base ? lineUnit(p.base) : "kg";
    const units = RECIPE_UNITS.filter((u) => Units.baseOf(u) === Units.baseOf(baseUnit));
    return `<div class="scale">
      <h3>Scale the card</h3>
      <div class="scale__form">
        <label>Set <select class="in" data-k="sc-line" data-act="scale-pick">${amounts.map((l) => `<option value="${esc(l.id)}"${l.id === sc.line ? " selected" : ""}>${esc(lineName(l))} (${esc(numText(l.qty))} ${esc(unitLabel(lineUnit(l)))})</option>`).join("")}</select></label>
        <label>to <input class="in in--num" inputmode="decimal" data-k="sc-qty" data-act="scale-qty" value="${esc(sc.qty)}" />
          <select class="in" data-k="sc-unit" data-act="scale-unit">${units.map((u) => `<option value="${u}"${u === sc.unit ? " selected" : ""}>${esc(unitLabel(u))}</option>`).join("")}</select></label>
      </div>
      ${p.error ? `<p class="problem">${esc(p.error)}</p>` : `<p class="hint">Everything × ${esc(numText(+p.f.toPrecision(4)))}. Only the card changes: the recipe and its costs stay as they are. Steps that mention amounts aren't changed.</p>${table(p)}`}
      <div class="actions"><button class="btn btn--main" data-act="scale-save" ${p.error ? "disabled" : ""}>Use on the card</button><button class="btn" data-act="scale-close">Cancel</button></div>
    </div>`;
  }

  function recipePage(id) {
    const r = get("recipes", id);
    if (!r) return `<p>Not found. <a href="#/dishes">Back to dishes</a></p>`;
    if (fromKitchen("recipes", id)) return kitchenPage(true, r, get("recipes", route().from));
    const s = coster.summary(r.id);
    const isDish = r.kind === "dish";
    const usedIn = coster.usedBy(r.id).filter((x) => x !== r.id).map((x) => get("recipes", x)).filter(Boolean).sort(byName);
    const lineRows = s.lines.map((row) => lineRow(row, s.lines.length)).join("");

    // A price other than per portion says what it's per.
    const perWhat = r.yield_unit === "portion" ? "" : ` per ${esc(unitLabel(r.yield_unit))}`;
    const totals = `
      <div class="totals">
        <div><span>Batch cost</span><strong>${money(s.total)}</strong></div>
        <div><span>Cost per ${esc(unitLabel(r.yield_unit))}</span><strong>${money(s.perPortion, true)}</strong></div>
        ${isDish ? `
        <div><span>Multiplier</span><input class="in in--num" inputmode="decimal" data-k="r-mult" data-act="recipe-field" data-field="multiplier" value="${esc(numText(r.multiplier || 4))}" aria-label="Multiplier" /></div>
        <div class="big"><span>Target price (×${esc(numText(s.multiplier))})${perWhat}</span><strong>${money(s.suggested)}</strong></div>
        <div><span>Menu price${perWhat}</span>${moneyInput(`data-k="r-price" data-act="recipe-field" data-field="menu_price" value="${esc(numText(r.menu_price))}" aria-label="Menu price"`)}</div>
        <div class="big"><span>Food cost</span>${s.foodCost == null ? `<strong class="muted">—</strong>` : `<strong class="fc ${s.over ? "fc--over" : "fc--ok"}">${pct(s.foodCost)}</strong>`}</div>
        <div><span>Menu price ÷ cost</span><strong>${s.actualMultiplier ? "×" + s.actualMultiplier.toFixed(2) : "—"}</strong></div>
        ${s.over ? `<p class="note note--bad">Over target: the ×${esc(numText(s.multiplier))} price is ${money(s.suggested)}, ${money(s.suggested - s.menuPrice)} more than the menu price.</p>` : s.menuPrice ? `<p class="note note--ok">At or under the ${pct(s.target)} target.</p>` : ""}` : ""}
      </div>`;

    const rt = route(), from = rt.from !== r.id ? get("recipes", rt.from) : null;
    if (from) cameFrom.set(r.id, from.id); else cameFrom.delete(r.id);
    return `
      ${isEmployee() && !mine(r) ? `<div class="alert alert--check"><div>You can read this recipe but not change it. To work on your own version, press <strong>Duplicate</strong>: the copy is yours.</div></div>` : ""}
      ${from && rt.isNew ? `<p class="crumbs"><button class="btn btn--main" data-act="back-to" data-id="${esc(from.id)}">← Back to ${esc(from.name)}</button></p>
        ${!s.lines.length ? `<div class="alert alert--check"><div>New prep for <strong>${esc(from.name)}</strong>. Add its ingredients below and set how much it makes, then go back: the dish uses 1 portion of it, which you can change there.</div></div>` : ""}`
        : `<p class="crumbs"><a href="#/${isDish ? "dishes" : "preps"}">← ${isDish ? "Dishes" : "Preps"}</a>${backLink(from)}</p>`}
      ${s.change ? `<div class="alert ${s.change > 0 ? "alert--up" : "alert--down"}">
        <div>Since you last checked, the cost per ${esc(unitLabel(r.yield_unit))} went <strong>${s.change > 0 ? "up" : "down"} ${money(Math.abs(s.change), true)}</strong>${s.changePct != null ? ` (${(s.changePct * 100).toFixed(1)}%)` : ""}: ${money(s.ack, true)} → ${money(s.perPortion, true)}.
        ${isDish ? `The ×${esc(numText(s.multiplier))} price is now ${money(s.suggested)} (was ${money(s.ack * s.multiplier)}).` : ""}</div>
        <button class="btn" data-act="ack" data-id="${esc(r.id)}">Got it</button></div>` : ""}
      ${r.review ? `<div class="alert alert--check"><div>${esc(r.review)}</div><button class="btn" data-act="recipe-checked" data-id="${esc(r.id)}">Mark as checked</button></div>` : ""}
      ${otherVersions(r).map((x) => `<div class="alert alert--check"><div>Another version: <a href="#/recipe/${encodeURIComponent(x.id)}"><strong>${esc(x.name)}</strong></a>
        (${money(coster.summary(x.id).perPortion, true)} per ${esc(unitLabel(x.yield_unit))}, used in ${coster.usedBy(x.id).filter((u) => u !== x.id).length} recipe(s)).</div>
        <button class="btn" data-act="merge-recipe" data-id="${esc(r.id)}" data-into="${esc(x.id)}">Merge into ${esc(x.name)}</button></div>`).join("")}
      <div class="head">
        <input class="in in--title" data-k="r-name" data-act="recipe-field" data-field="name" value="${esc(r.name)}" aria-label="Name" />
        <div class="head__meta">
          <label>Type <select class="in" data-k="r-kind" data-act="recipe-field" data-field="kind"><option value="dish"${isDish ? " selected" : ""}>Dish</option><option value="prep"${!isDish ? " selected" : ""}>Prep</option></select></label>
          ${isDish ? `<label>Category <input class="in" list="dl-dish-cats" data-suggest-all data-k="r-cat" data-act="recipe-field" data-field="category" value="${esc(r.category || "")}" placeholder="Plats, Dessert…" /></label>
          <label>Menu <input class="in" list="dl-menus" data-suggest-all data-k="r-menu" data-act="recipe-field" data-field="menu" value="${esc(r.menu || "")}" />${(r.menu || "").trim()
            ? ` <a class="small" href="#/menu/${encodeURIComponent(r.menu.trim())}">Open menu</a>` : ""}</label>` : ""}
          ${!isDish ? `<label class="check" title="Counted in the monthly inventory, at what it costs to make"><input type="checkbox" data-k="r-inv" data-act="recipe-field" data-field="in_inventory" ${r.in_inventory === true ? "checked" : ""} /> On the monthly count</label>
          ${r.in_inventory === true ? containerBox("recipe", r) : ""}` : ""}
        </div>
        ${measureBoxes("recipe", r.id, Costing.recipeMeasures(r), { costPer: r.yield_unit })}
      </div>

      <div class="grid2">
        <section>
          <div class="table-wrap"><table class="lines lines--recipe">
            <thead><tr><th>Item</th><th class="num">Qty</th><th>Unit</th><th class="num" title="The item's yield in this recipe, if it's trimmed differently here (empty = its usual yield)">Yield</th><th>Supplier</th><th class="num">Price</th><th class="num">Cost</th><th><span class="vh">Actions</span></th></tr></thead>
            <tbody>${lineRows}
              <tr class="addrow"><td colspan="8"><input class="in in--wide" list="dl-items" data-k="add-line" data-act="add-line" data-id="${esc(r.id)}" placeholder="+ Add an ingredient or a prep (start typing, then pick)" /></td></tr>
            </tbody>
          </table></div>
          <section class="card card--flat">
            <h2>Recipe card</h2>
            <label class="block">Ready in<input class="in" data-k="r-ready" data-act="recipe-field" data-field="ready_in" value="${esc(r.ready_in || "")}" placeholder="e.g. 1.5 hrs" /></label>
            <label class="block">Preparation <span class="small">(one step per line)</span><textarea class="in" rows="6" data-k="r-method" data-act="recipe-field" data-field="method">${esc(r.method || "")}</textarea></label>
            <label class="block">Notes<textarea class="in" rows="3" data-k="r-notes" data-act="recipe-field" data-field="notes">${esc(r.notes || "")}</textarea></label>
            ${scaleBox(r)}
            <div class="actions">
              ${!GDrive.configured() ? `<button class="btn btn--main" data-act="download-card" data-id="${esc(r.id)}">Download card (Word)</button>`
                : settings.drive && settings.drive.folder && settings.drive.template ? `<button class="btn btn--main" data-act="save-card" data-id="${esc(r.id)}">${r.card_doc_id ? "Update card on Drive" : "Save card to Drive"}</button>`
                : `<span class="muted"><a href="#/settings">Pick your recipe cards folder and card template</a> to save cards to Drive.</span>`}
              ${r.card_doc_id ? `<a class="btn" href="${esc(cardUrl(r.card_doc_id))}" target="_blank" rel="noopener">Open card</a>` : ""}
            </div>
          </section>
          ${usedIn.length ? `<p class="muted">Used in: ${usedIn.map((u) => `<a href="#/recipe/${encodeURIComponent(u.id)}">${esc(u.name)}</a>`).join(", ")}</p>` : ""}
          ${barUses("sub_recipe_id", r.id).length ? `<p class="muted">Used in ${barTag}: ${barUses("sub_recipe_id", r.id).map((u) => esc(u.name)).join(", ")}</p>` : ""}
          <div class="actions">
            <button class="btn" data-act="duplicate" data-id="${esc(r.id)}">Duplicate</button>
            <button class="btn" data-act="merge-recipe" data-id="${esc(r.id)}">Merge into another…</button>
            <button class="btn btn--danger" data-act="delete-recipe" data-id="${esc(r.id)}">Delete</button>
          </div>
        </section>
        <aside>${totals}
          ${allergenSide(r)}
          ${!isDish || parseNum(r.locked_cost) != null ? (() => {
            const rc = coster.recipeCost(r.id);
            return `<section class="card card--side"><h2>Cost lock</h2>${lockBox({ kind: "recipe", id: r.id, unit: r.yield_unit, locked: parseNum(r.locked_cost), at: r.locked_at, live: rc.live ? rc.live.perYield : rc.perYield })}
              ${rc.locked ? `<p class="hint">The lines on the left show today's prices: ${money(rc.live.total)} a batch.</p>` : ""}</section>`;
          })() : ""}
          ${GDrive.configured() ? `<div class="actions">${settings.drive && settings.drive.costsheet
            ? `<button class="btn" data-act="download-sheet" data-id="${esc(r.id)}">Download costing sheet (Excel)</button>`
            : `<span class="muted small"><a href="#/settings">Pick your recipe cost template</a> to download this as your costing sheet.</span>`}</div>` : ""}
        </aside>
      </div>`;
  }

  function lineRow(row, count) {
    const l = row.line;
    let item = "", units = [], supplier = "";
    if (l.ingredient_id) {
      const ing = get("ingredients", l.ingredient_id);
      item = ing ? `<a href="#/ingredient/${encodeURIComponent(ing.id)}/from/${encodeURIComponent(l.recipe_id)}">${esc(ing.name)}</a>${fromKitchen("ingredients", ing.id) ? " " + kitchenTag() : ""}${ing.needs_check ? " " + estimatedTag : ""}` : `<span class="muted">(deleted)</span>`;
      // Its own kind of unit, plus by weight for something counted (or by the piece for something weighed) once "1 unit weighs" is set.
      const byWeight = (u) => parseNum(ing.each_kg) && (ing.base === "kg" ? Units.baseOf(u) === "unit" : Units.countable(ing.base) && Units.baseOf(u) === "kg");
      // …and anything it has a measure for (1 recipe = 12 kg = 66 portions).
      const measured = ing ? coster.countChoices(ing, false).map((m) => Units.baseOf(m)) : [];
      units = ing ? RECIPE_UNITS.filter((u) => Units.baseOf(u) === ing.base || byWeight(u) || measured.includes(Units.baseOf(u))) : RECIPE_UNITS;
      if (BAR && ing && Barback.bottleMl(ing)) units = units.filter((u) => u !== "recipe"); // a bottle is the measure, not a batch
      const offers = ing ? coster.offersFor(ing.id) : [];
      const def = ing ? coster.defaultOffer(ing.id) : null;
      const label = (x) => `${x.offer.supplier || "No supplier"} · ${money(x.price, true)}${per(ing.base)}`;
      supplier = offers.length > 1
        ? `<select class="in in--sup" data-k="l-sup-${l.id}" data-act="line-field" data-field="offer_id" data-id="${esc(l.id)}">
            <option value="">${def ? "Preferred: " + esc(label(def)) : "Preferred"}</option>
            ${offers.filter((x) => x.price != null).map((x) => `<option value="${esc(x.offer.id)}"${l.offer_id === x.offer.id ? " selected" : ""}>${esc(label(x))}</option>`).join("")}
          </select>`
        : `<span class="muted">${esc(row.offer ? row.offer.supplier || "—" : "—")}</span>`;
      if (row.offer && row.offer.locked) supplier += " " + lockTag(row.offer.locked_at);
    } else if (l.sub_recipe_id) {
      const sub = get("recipes", l.sub_recipe_id);
      item = sub ? `<a href="#/recipe/${encodeURIComponent(sub.id)}/from/${encodeURIComponent(l.recipe_id)}">${esc(sub.name)}</a> <span class="tag">${sub.kind === "dish" ? "dish" : "prep"}</span>${fromKitchen("recipes", sub.id) ? " " + kitchenTag() : ""}` : `<span class="muted">(deleted)</span>`;
      // Either of the prep's measures: what it makes, and its other measure (e.g. portions or grams).
      const unitsFor = (m) => (m === "portion" ? ["portion"] : m ? RECIPE_UNITS.filter((u) => Units.baseOf(u) === Units.baseOf(m)) : []);
      // …or by the recipe (the whole batch).
      units = sub ? [...new Set([...unitsFor(sub.yield_unit), ...(parseNum(sub.alt_qty) ? unitsFor(sub.alt_unit) : []), ...Costing.savedMeasures(sub).flatMap((m) => unitsFor(m.unit)), "recipe"])] : ["portion"];
      supplier = sub && parseNum(sub.locked_cost) != null ? lockTag(sub.locked_at) : `<span class="muted">—</span>`;
    }
    if (l.unit && !units.includes(l.unit)) units = [l.unit, ...units];
    return `<tr class="${row.problem ? "has-problem" : ""}" data-line="${esc(l.id)}">
      <td>${item}${row.problem ? `<div class="problem">${esc(row.problem)}</div>` : ""}</td>
      <td class="num"><input class="in in--num" inputmode="decimal" data-k="l-qty-${l.id}" data-act="line-field" data-field="qty" data-id="${esc(l.id)}" value="${esc(numText(l.qty))}" aria-label="Quantity" /></td>
      <td><select class="in" data-k="l-unit-${l.id}" data-act="line-field" data-field="unit" data-id="${esc(l.id)}" aria-label="Unit">${units.map((u) => `<option value="${u}"${l.unit === u ? " selected" : ""}>${esc(unitLabel(u))}</option>`).join("")}</select></td>
      <td class="num nowrap">${l.ingredient_id && get("ingredients", l.ingredient_id) ? `<input class="in in--yield${row.lineYield ? " in--cut" : ""}" inputmode="decimal" data-k="l-yld-${l.id}" data-act="line-field" data-field="yield" data-id="${esc(l.id)}"
        value="${row.lineYield ? esc(yieldPct(row.lineYield)) : ""}" placeholder="${esc(yieldPct(get("ingredients", l.ingredient_id).yield))}" aria-label="Yield in this recipe, in %" title="Empty = the item's usual yield (${esc(yieldPct(get("ingredients", l.ingredient_id).yield))}%). Type another if it's trimmed differently in this recipe." /> %` : ""}</td>
      <td>${supplier}</td>
      <td class="num muted">${row.unitPrice == null ? "—" : money(row.unitPrice, true) + per(row.priceUnit)}${row.lineYield ? `<div class="small">at ${esc(yieldPct(row.lineYield))}% here</div>` : ""}</td>
      <td class="num"><strong>${money(row.cost)}</strong></td>
      <td class="row-actions">
        ${count > 1 ? `<button class="icon drag-handle" type="button" data-k="l-move-${l.id}" data-drag-line="${esc(l.id)}" title="Drag to move" aria-label="Move ${esc(lineName(l))}: drag it, or press the up and down arrow keys"><svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true"><circle cx="2.5" cy="3" r="1.5"/><circle cx="7.5" cy="3" r="1.5"/><circle cx="2.5" cy="8" r="1.5"/><circle cx="7.5" cy="8" r="1.5"/><circle cx="2.5" cy="13" r="1.5"/><circle cx="7.5" cy="13" r="1.5"/></svg></button>` : ""}
        <button class="icon icon--x" data-act="delete-line" data-id="${esc(l.id)}" aria-label="Remove">×</button>
      </td>
    </tr>`;
  }

  /* ---------- measures: what one recipe comes to ---------- */
  // 1 recipe = 12 kg = 66 portions. Any box can stay empty, and any two give the third.
  const isWeight = (u) => ["kg", "L"].includes(Units.baseOf(u));
  const PART16_NOTE = "Run part 16 of supabase/schema.sql in Supabase (SQL Editor) to save this.";
  // Which folded boxes are open (this visit only), so a save elsewhere on the page doesn't close them.
  const detailsOpen = new Map();

  /** What an item's boxes show: its prep's measures if it's made from one, else its own, with a "1 recipe weighs" or
   * "1 portion weighs" saved before these boxes existed. */
  function itemMeasureView(i) {
    const prep = i.prep_id && get("recipes", i.prep_id);
    if (prep) return Costing.recipeMeasures(prep);
    const list = Costing.savedMeasures(i), each = parseNum(i.each_kg), portions = list.find((m) => m.unit === "portion");
    if (each > 0 && !list.some((m) => Units.baseOf(m.unit) === "kg")) {
      if (i.base === "recipe") list.unshift({ qty: each, unit: "kg" });
      if (i.base === "portion" && portions) list.unshift({ qty: each * portions.qty, unit: "kg" });
    }
    return list;
  }

  /** The row of boxes. opts.costPer: what a prep's cost is shown per. opts.each: the weight of a portion known another way. */
  function measureBoxes(owner, id, list, { costPer = null, each = null } = {}) {
    const used = list.map((m) => m.unit);
    const weights = list.filter((m) => isWeight(m.unit)), pieces = list.filter((m) => !isWeight(m.unit));
    if (!weights.length) weights.push({ qty: null, unit: "kg" });
    if (!pieces.length) pieces.push({ qty: null, unit: "portion" });
    const label = (u) => (u === "portion" ? "portions" : u === "unit" ? "units" : unitLabel(u));
    const box = (m, kinds, what) => {
      const options = kinds.filter((u) => u === m.unit || !used.includes(u));
      if (!options.includes(m.unit)) options.unshift(m.unit);
      return `<span class="measures__eq" aria-hidden="true">=</span><span class="measures__box" data-measure>
        <input class="in in--num" inputmode="decimal" data-k="m-${owner}-${esc(m.unit)}" data-act="measure" data-owner="${owner}" data-id="${esc(id)}" data-field="qty" data-unit="${esc(m.unit)}" value="${esc(numText(m.qty))}" placeholder="—" aria-label="${what} in one recipe" />
        <select class="in" data-k="m-${owner}-${esc(m.unit)}-u" data-act="measure" data-owner="${owner}" data-id="${esc(id)}" data-field="unit" data-unit="${esc(m.unit)}" aria-label="Unit of ${what.toLowerCase()}">${options.map((u) => `<option value="${esc(u)}"${u === m.unit ? " selected" : ""}>${esc(label(u))}</option>`).join("")}</select></span>`;
    };
    const w = list.find((m) => isWeight(m.unit)), n = list.find((m) => m.unit === "portion");
    const small = w && Units.baseOf(w.unit) === "L" ? "ml" : "g";
    const one = w && n ? w.qty / n.qty : each;
    return `<div class="measures" role="group" aria-label="What one recipe comes to">
      <span class="measures__one">1 recipe</span>
      ${weights.map((m) => box(m, ["kg", "L"], "Weight or volume")).join("")}
      ${pieces.map((m) => box(m, ["portion", "unit"], "Portions or units")).join("")}
      <label class="measures__each">1 portion = <input class="in in--num" inputmode="decimal" data-k="m-${owner}-each" data-act="measure" data-owner="${owner}" data-id="${esc(id)}" data-field="portion" data-small="${small}" value="${one > 0 ? esc(numText(+(one * 1000).toPrecision(4))) : ""}" placeholder="—" /> ${small}</label>
      ${costPer ? `<label class="measures__per" title="Only what the price is shown per: the batch and every dish using it cost the same.">Cost per <select class="in" data-k="m-per" data-act="measure-costper" data-id="${esc(id)}">
        ${[...new Set(["recipe", ...used, costPer])].map((u) => `<option value="${esc(u)}"${u === costPer ? " selected" : ""}>${esc(unitLabel(u))}</option>`).join("")}</select></label>` : ""}
    </div>`;
  }

  /** What its empty container weighs, in grams. It's out of the way: a folded box on an item, a small box on a counted prep. */
  function containerBox(owner, x) {
    return `<label class="measures__tare" title="Counting by weight, type what the scale shows: this comes off by itself.">Empty container <input class="in in--num" inputmode="decimal" data-k="c-${owner}" data-act="container" data-owner="${owner}" data-id="${esc(x.id)}" value="${parseNum(x.container_kg) ? esc(numText(+(parseNum(x.container_kg) * 1000).toPrecision(6))) : ""}" placeholder="—" /> g</label>`;
  }

  function measuresCard(i) {
    const prep = i.prep_id && get("recipes", i.prep_id), list = itemMeasureView(i);
    const each = i.base === "portion" && parseNum(i.each_kg) > 0 ? parseNum(i.each_kg) : null;
    const canWeigh = i.base === "kg" || coster.countChoices(i, false).includes("kg");
    const k = "measures-" + i.id;
    const open = detailsOpen.has(k) ? detailsOpen.get(k) : list.length > 0 || parseNum(i.container_kg) > 0 || isPrepped(i) || i.base === "recipe" || i.base === "portion";
    // Its price is for its own pack size: said out loud if the prep's measure of the same kind is different.
    const size = prep ? coster.batchSize(i, prep) : null;
    const same = prep && list.find((m) => Units.convert(1, m.unit, i.base) != null);
    const inBase = same ? Units.convert(same.qty, same.unit, i.base) : null;
    const differs = size && inBase && Math.abs(size - inBase) > 0.005 * inBase;
    return `<section class="card card--flat">
      <details class="fold" data-k="${esc(k)}"${open ? " open" : ""}>
        <summary><h2>More ways to measure</h2><span class="small muted">weight, recipe, portions, container</span></summary>
        ${Store.part16Old() ? `<p class="note note--bad">${PART16_NOTE}</p>` : ""}
        <p class="hint">Fill in only what you know: any box can stay empty, and two of them give the third. Recipes can use any of them, and the inventory can count in them.</p>
        ${measureBoxes(prep ? "recipe" : "item", prep ? prep.id : i.id, list, { each })}
        ${prep ? `<p class="hint">Saved on the prep, <a href="#/recipe/${encodeURIComponent(prep.id)}">${esc(prep.name)}</a>, so the two always match.${differs ? ` Its price still uses the pack size below: ${esc(numText(size))} ${esc(unitLabel(i.base))} for one batch.` : ""}</p>` : ""}
        <div class="fold__row">${containerBox("item", i)}</div>
        <p class="hint">${canWeigh ? "Counting this by weight, you type what the scale shows and the container comes off by itself. No need to keep an empty one around."
          : "To use a container, this item also needs a weight (above, or \"1 unit weighs\"), so it can be counted in kg."}</p>
      </details>
    </section>`;
  }

  /** Saves a prep's measures: the one its cost is per goes in "makes" (one recipe if there's none), the rest after it. */
  async function saveRecipeMeasures(r, list, costPer, relabel = false) {
    const main = costPer === "recipe" ? null : list.find((m) => m.unit === costPer);
    const rest = list.filter((m) => m !== main);
    if (rest.length > 1 && Store.part16Old()) { toast(PART16_NOTE, true); return render(); }
    const oldUnit = r.yield_unit, oldQty = parseNum(r.yield_qty) || 1, unit = main ? main.unit : "recipe", qty = main ? main.qty : 1;
    const changes = { yield_qty: qty, yield_unit: unit, alt_qty: rest[0] ? rest[0].qty : null, alt_unit: rest[0] ? rest[0].unit : null };
    if (!Store.part16Old()) changes.measures = rest.length > 1 ? rest.slice(1) : null;
    const moved = unit !== oldUnit && !relabel;
    const lock = parseNum(r.locked_cost);
    if (moved && lock != null) changes.locked_cost = (lock * oldQty) / qty; // the batch keeps its locked cost
    await write(async () => {
      if (moved) {
        // Lines and counts with no unit of their own meant the old measure: they say so now, so they keep their value.
        for (const l of data.lines.filter((x) => x.sub_recipe_id === r.id && (!x.unit || parseNum(x.qty) == null))) await patch("lines", l.id, parseNum(l.qty) == null ? { qty: 1, unit: oldUnit } : { unit: oldUnit });
        if (!Store.part16Old()) for (const c of data.counts.filter((x) => x.recipe_id === r.id && !x.unit)) await patch("counts", c.id, { unit: oldUnit });
      }
      await patch("recipes", r.id, changes);
      if (qty !== oldQty || unit !== oldUnit) await settle(r.id);
    });
    if (!write.failed && moved && !main && costPer !== "recipe") toast(`Costs are shown per recipe now. The batch costs the same.`);
  }

  /** Saves an item's measures, keeping "1 recipe weighs" / "1 portion weighs" in step for everything that reads them. */
  async function saveItemMeasures(i, list) {
    if (Store.part16Old()) { toast(PART16_NOTE, true); return render(); }
    const changes = { measures: list.length ? list : null };
    const w = list.find((m) => Units.baseOf(m.unit) === "kg"), n = list.find((m) => m.unit === "portion");
    if (i.base === "recipe") changes.each_kg = w ? Units.convert(w.qty, w.unit, "kg") : null;
    if (i.base === "portion") changes.each_kg = w && n ? Units.convert(w.qty, w.unit, "kg") / n.qty : null;
    await write(() => patch("ingredients", i.id, changes));
  }

  /* ---------- ingredients ---------- */
  // Sections A to Z, then "Autre" and anything without a section, then single-use supplies ("Mono …") last.
  // Your own order (Settings → Categories) comes first when you've set one; sections not in it follow the usual rule.
  const section = (i) => (i.category || "").trim() || "No section";
  const sectionRank = (c) => (/^mono\b/i.test(c) ? 2 : /^(autre|no section)$/i.test(c) ? 1 : 0);
  const sectionList = () => (settings.categories && settings.categories.ingredients) || [];
  const ownRank = (c) => { const k = sectionList().indexOf(c); return k < 0 ? 1e5 : k; };
  const bySection = (a, b) => ownRank(a) - ownRank(b) || sectionRank(a) - sectionRank(b) || a.localeCompare(b, "fr", { sensitivity: "base" });
  const sortBySection = (list) => list.slice().sort((a, b) => bySection(section(a), section(b)) || byName(a, b));
  // A list in the order its sections come in one of your sheets (order: its section names, top to bottom; aliases:
  // other spellings a sheet has for a section). Sections the sheet doesn't have go last; inside a section the list
  // keeps its own order.
  function inSheetOrder(list, sec, order, aliases = {}) {
    const rank = (s) => { const k = order.findIndex((o) => o === s || (aliases[s] || []).includes(o)); return k < 0 ? Infinity : k; };
    return list.map((x, k) => ({ x, k, r: rank(sec(x)) })).sort((a, b) => a.r - b.r || a.k - b.k).map((y) => y.x);
  }

  // Yield (Master Data's "Rendement"): the usable part after trimming, which every price is divided by.
  // Typed as 65, 65% or 0.65 (all 65%); empty is 100%. Shown as a percent.
  const parseYield = (v) => {
    const s = String(v == null ? "" : v).replace("%", "").trim();
    if (!s) return 1;
    const n = parseNum(s);
    const y = n == null || !(n > 0) ? null : n > 1 ? n / 100 : n;
    return y != null && y <= 1 ? +y.toFixed(4) : null;
  };
  const yieldPct = (y) => numText(+((y == null ? 1 : +y) * 100).toFixed(2));
  const YIELD_HELP = "Yield is the usable part after trimming: 65 (or 65%, or 0.65) for 65%, up to 100.";

  // Section chips over a list: pick one or several sections (Volaile + Viande + Poisson) to see only those;
  // none picked shows everything. The pick is remembered on this device, per page.
  const SECTIONS = "costing.sections";
  function sectionChips(page, names) {
    const counts = new Map();
    names.forEach((s) => counts.set(s, (counts.get(s) || 0) + 1));
    const on = new Set(readJSON(SECTIONS, {})[page] || []);
    const any = [...counts.keys()].some((s) => on.has(s));
    return `<div class="sections no-print" data-filter-sections="${page}" role="group" aria-label="Sections">
      <button type="button" class="sec" data-sec-all aria-pressed="${!any}">All</button>
      ${[...counts].map(([s, n]) => `<button type="button" class="sec" data-sec="${esc(s)}" aria-pressed="${on.has(s)}">${esc(s)} <span class="sec-n">${n}</span></button>`).join("")}
    </div>`;
  }

  function ingredientList() {
    const list = sortBySection(data.ingredients);
    let current = null;
    const rows = list.map((i) => {
      const cat = section(i);
      const head = cat !== current ? `<tr class="section-row" data-section="${esc(cat)}"><th colspan="4" scope="colgroup">${esc(cat)}</th></tr>` : "";
      current = cat;
      const def = coster.defaultOffer(i.id), y = parseNum(i.yield) || 1;
      const n = data.offers.filter((o) => o.ingredient_id === i.id).length;
      return head + `<tr data-search="${esc((i.name + " " + i.category + " " + data.offers.filter((o) => o.ingredient_id === i.id).map((o) => o.supplier + " " + o.supplier_item).join(" ")).toLowerCase())}" data-group="${esc(cat)}" data-flag="${i.review || !def ? "1" : "0"}" data-noprice="${def ? "0" : "1"}">
        <td><a href="#/ingredient/${encodeURIComponent(i.id)}">${esc(i.name)}</a> ${flagIcon(i.review)}${i.needs_check ? " " + estimatedTag : ""}</td>
        <td class="num">${def ? (def.offer.locked ? lockTag(def.offer.locked_at, true) + " " : "") + money(def.price, true) + `<span class="muted">${per(i.base)}</span>` : `<span class="warn">no price</span>`}
          ${def && !def.offer.locked && y !== 1 ? `<div class="muted small">${money(def.price * y, true)} as bought</div>` : ""}${BAR && def ? pourLine(i, def.price) : ""}</td>
        <td>${def ? esc(def.offer.supplier || "") : ""}${n > 1 ? ` <span class="tag">${n} suppliers</span>` : ""}</td>
        <td class="num nowrap"><input class="in in--yield${y !== 1 ? " in--cut" : ""}" inputmode="decimal" data-k="iy-${esc(i.id)}" data-act="ing-yield" data-id="${esc(i.id)}" value="${esc(yieldPct(y))}" aria-label="Yield of ${esc(i.name)}, in %" /> %</td>
      </tr>`;
    }).join("");
    return `
      <div class="bar">
        <h1>Ingredients <span class="muted small">(<span data-count>${list.length}</span>)</span></h1>
        <div class="actions" style="margin:0">
          ${settings.drive && settings.drive.master ? `<button class="btn" data-act="master-sheet">Update “${esc(settings.drive.master.name)}”</button>` : ""}
          <button class="btn" data-act="master-csv">${SITE.commis ? "Download price list" : "Download Master Data"}</button>
          ${bringLink()}
          <button class="btn btn--main" data-act="new-ingredient">+ New ingredient</button>
        </div>
      </div>
      <div class="filters">
        <input type="search" placeholder="Search names, suppliers, invoice names" data-filter aria-label="Search" />
        <label class="check"><input type="checkbox" data-filter-flag /> Needs checking</label>
        <label class="check"><input type="checkbox" data-filter-noprice /> No price <span class="muted">(${list.filter((i) => !coster.defaultOffer(i.id)).length})</span></label>
      </div>
      ${sectionChips("ingredients", list.map(section))}
      ${(() => { const n = isAdmin() ? list.filter((i) => i.needs_check).length : 0; return n ? `<div class="alert alert--check"><div><strong>${n} estimated price${n === 1 ? "" : "s"}</strong> from your team to double check. Tick "Needs checking" below to see ${n === 1 ? "it" : "them"}, then press "Mark as checked" on each.</div></div>` : ""; })()}
      ${BAR ? `<p class="hint">Each price shows per litre, per bottle and per ounce. Give a bottle its size on its page to count it in bottles. Anything on your ${esc(SITE.name)} list can go in a cocktail too: type its name there.</p>` : ""}
      <p class="hint"${BAR ? " hidden" : ""}>Prices are per usable kg, L or unit: pack price ÷ (pack size × yield). <strong>Yield</strong> is ${SITE.commis ? "" : "Master Data's Rendement, "}the part left after trimming: type 65 for 65% (Enter goes to the next one). Anything bought in lb is converted.</p>
      <div class="table-wrap"><table class="list cards">
        <thead><tr><th>Name</th><th class="num">Price used</th><th>Supplier</th><th class="num" title="Usable part after trimming (Rendement)">Yield</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="4" class="muted">${SITE.commis ? "No ingredients yet: add one with “+ New ingredient”, or make them from an invoice." : "No ingredients yet. Import your Master Data in Settings."}</td></tr>`}</tbody>
      </table></div>
      ${kitchenFold(false)}`;
  }

  /* ---------- allergens ---------- */
  // Each item says what it contains and what it may have been in contact with (Canada's priority allergens, the
  // gluten grains together). An item nobody has looked at yet has allergens = null, "not checked"; ticking anything,
  // or "Contains none", marks it checked. A dish or prep has what its items have, through its preps and through items
  // made from a prep; a contact that's also contained counts as contained.
  const ALLERGENS = [["gluten", "Gluten", "wheat, barley, rye, oats, triticale"], ["milk", "Milk"], ["egg", "Eggs"], ["peanut", "Peanuts"],
    ["treenut", "Tree nuts"], ["sesame", "Sesame"], ["soy", "Soy"], ["fish", "Fish"], ["shellfish", "Shellfish", "crustaceans and molluscs"],
    ["mustard", "Mustard"], ["sulphite", "Sulphites"]];
  const allergenKeys = (v) => { const set = new Set(String(v || "").split(",").map((k) => k.trim())); return ALLERGENS.map((a) => a[0]).filter((k) => set.has(k)); };
  const allergenNames = (keys) => ALLERGENS.filter((a) => keys.includes(a[0])).map((a) => a[1].toLowerCase());
  function allergensOf(recipeId) {
    const has = new Set(), contact = new Set(), unchecked = new Map(), seen = new Set();
    let items = 0;
    (function walk(rid) {
      if (seen.has(rid)) return;
      seen.add(rid);
      for (const l of data.lines) {
        if (l.recipe_id !== rid) continue;
        if (l.sub_recipe_id) { walk(l.sub_recipe_id); continue; }
        const i = l.ingredient_id && get("ingredients", l.ingredient_id);
        if (!i) continue;
        items++;
        allergenKeys(i.allergens).forEach((k) => has.add(k));
        allergenKeys(i.allergen_contact).forEach((k) => contact.add(k));
        // An item made from a prep has what the prep has; one that isn't has to be checked itself.
        if (i.prep_id && get("recipes", i.prep_id)) walk(i.prep_id);
        else if (i.allergens == null) unchecked.set(i.id, i);
      }
    })(recipeId);
    const keys = ALLERGENS.map((a) => a[0]);
    return { items, contains: keys.filter((k) => has.has(k)), contact: keys.filter((k) => contact.has(k) && !has.has(k)), unchecked: [...unchecked.values()].sort(byName) };
  }
  /** "Contains gluten, milk. May contain sesame.", then the items not checked yet (unless left out); "" when nothing's known. */
  function allergenText(a, withUnchecked = true) {
    const parts = [];
    if (!a.items) return "";
    if (a.contains.length) parts.push(`Contains ${allergenNames(a.contains).join(", ")}.`);
    if (a.contact.length) parts.push(`May contain ${allergenNames(a.contact).join(", ")}.`);
    if (!parts.length && !a.unchecked.length) parts.push("None of the main allergens.");
    if (a.unchecked.length && withUnchecked) {
      const names = a.unchecked.slice(0, 3).map((i) => i.name).join(" · ");
      parts.push(`(Not checked yet: ${names}${a.unchecked.length > 3 ? ` and ${a.unchecked.length - 3} more` : ""}.)`);
    }
    return parts.join(" ");
  }
  function allergenCard(i) {
    const row = (field, label, note, keys) => `<p class="allergen-label">${label}${note ? ` <span class="muted small">${note}</span>` : ""}</p>
      <div class="sections sections--wrap" role="group" aria-label="${label}">${ALLERGENS.map(([k, name, sub]) => `<button type="button" class="sec" data-act="allergen" data-id="${esc(i.id)}"
        data-field="${field}" data-key="${k}" aria-pressed="${keys.includes(k)}"${sub ? ` title="${esc(sub)}"` : ""}>${name}</button>`).join("")}</div>`;
    const prep = i.prep_id && get("recipes", i.prep_id), fromPrep = prep ? allergensOf(prep.id) : null;
    const status = i.allergens != null ? (allergenKeys(i.allergens).length || allergenKeys(i.allergen_contact).length ? "" : `<p class="hint">Checked: contains none of these.</p>`)
      : `<p class="hint">Not checked yet. Tick what it contains, or <button type="button" class="linkish" data-act="allergen" data-id="${esc(i.id)}">it contains none of these</button>.</p>`;
    return `<section class="card card--flat">
        <h2>Allergens</h2>
        ${Store.part12Old() ? `<p class="note note--bad">Run part 12 of supabase/schema.sql in Supabase (SQL Editor) to save allergens.</p>` : ""}
        ${row("allergens", "Contains", "", allergenKeys(i.allergens))}
        ${row("allergen_contact", "May contain", "(contact: same fryer, board, factory…)", allergenKeys(i.allergen_contact))}
        ${prep ? `<p class="hint">Made from <a href="#/recipe/${encodeURIComponent(prep.id)}">${esc(prep.name)}</a>, which adds what its items have: ${esc(allergenText(fromPrep))}</p>` : status}
      </section>`;
  }

  // A dish's or prep's allergens, from its items; the items not checked yet link to their page, to tick them there.
  function allergenSide(r) {
    const a = allergensOf(r.id);
    if (!a.items) return "";
    const line = (label, keys) => (keys.length ? `<p><strong>${label}</strong> ${esc(allergenNames(keys).join(", "))}</p>` : "");
    return `<section class="card card--side allergens-side"><h2>Allergens</h2>
      ${line("Contains", a.contains)}${line("May contain", a.contact)}
      ${!a.contains.length && !a.contact.length && !a.unchecked.length ? `<p>None of the main allergens.</p>` : ""}
      ${a.unchecked.length ? `<p class="hint">Not checked yet (${a.unchecked.length}): ${a.unchecked.map((i) => `<a href="#/ingredient/${encodeURIComponent(i.id)}/from/${encodeURIComponent(r.id)}">${esc(i.name)}</a>`).join(" · ")}</p>` : ""}
    </section>`;
  }

  function ingredientPage(id) {
    const i = get("ingredients", id);
    if (!i) return `<p>Not found. <a href="#/ingredients">Back to ingredients</a></p>`;
    if (fromKitchen("ingredients", id)) return kitchenPage(false, i, get("recipes", route().from));
    const offers = coster.offersFor(i.id);
    // The ticked price is today's one, even while a locked price is what recipes use.
    const def = coster.liveOffer(i.id);
    const used = coster.usedBy(i.id).map((x) => get("recipes", x)).filter(Boolean).sort(byName);
    const inBar = barUses("ingredient_id", i.id);
    const estimatedHere = isEmployee() && mine(i) && i.needs_check;

    const offerRows = offers.map(({ offer: o, price }) => `
      <tr>
        <td><input type="radio" name="pref" data-act="prefer" data-id="${esc(o.id)}" ${def && def.offer.id === o.id ? "checked" : ""} aria-label="Use this price in recipes" /></td>
        <td><input class="in" list="dl-suppliers" data-suggest-all data-k="o-sup-${o.id}" data-act="offer-field" data-field="supplier" data-id="${esc(o.id)}" value="${esc(o.supplier || "")}" placeholder="Supplier" /></td>
        <td><input class="in" data-k="o-item-${o.id}" data-act="offer-field" data-field="supplier_item" data-id="${esc(o.id)}" value="${esc(o.supplier_item || "")}" placeholder="${BAR ? "e.g. GIN BEEFEATER 750 ML" : "e.g. OIGNON JAUNE 50LB"}" /></td>
        <td class="num">${moneyInput(`data-k="o-cost-${o.id}" data-act="offer-field" data-field="pack_cost" data-id="${esc(o.id)}" value="${esc(numText(o.pack_cost))}" aria-label="Pack price"`)}</td>
        <td class="num nowrap"><input class="in in--num" inputmode="decimal" data-k="o-qty-${o.id}" data-act="offer-field" data-field="pack_qty" data-id="${esc(o.id)}" value="${esc(numText(o.pack_qty))}" aria-label="Pack size" />
          <select class="in" data-k="o-unit-${o.id}" data-act="offer-field" data-field="pack_unit" data-id="${esc(o.id)}" aria-label="Pack unit">${ALL_UNITS.map((u) => `<option value="${u}"${o.pack_unit === u ? " selected" : ""}>${esc(unitLabel(u))}</option>`).join("")}</select></td>
        <td class="num"><strong>${price == null ? `<span class="warn">—</span>` : money(price, true) + per(i.base)}</strong></td>
        <td class="muted nowrap">${esc(o.updated_at || "")}</td>
        <td><button class="icon icon--x" data-act="delete-offer" data-id="${esc(o.id)}" aria-label="Delete this price">×</button></td>
      </tr>`).join("");

    return `
      <p class="crumbs"><a href="#/ingredients">← Ingredients</a>${backLink(get("recipes", route().from))}</p>
      ${i.review ? `<div class="alert alert--check"><div>${esc(i.review)}</div><button class="btn" data-act="ing-checked" data-id="${esc(i.id)}">Mark as checked</button></div>` : ""}
      ${lookAlikes(i).map((x) => `<div class="alert alert--check"><div>Looks like the same thing as <a href="#/ingredient/${encodeURIComponent(x.id)}"><strong>${esc(x.name)}</strong></a>
        (${data.offers.filter((o) => o.ingredient_id === x.id).length} price(s), used in ${coster.usedBy(x.id).length} recipe(s)).</div>
        <button class="btn" data-act="merge" data-id="${esc(i.id)}" data-into="${esc(x.id)}">Merge into ${esc(x.name)}</button></div>`).join("")}
      <div class="head">
        <input class="in in--title" data-k="i-name" data-act="ing-field" data-field="name" value="${esc(i.name)}" aria-label="Name" />
        <div class="head__meta">
          <label>Category <input class="in" list="dl-categories" data-suggest-all data-k="i-cat" data-act="ing-field" data-field="category" value="${esc(i.category || "")}" /></label>
          <label>Priced per <select class="in" data-k="i-base" data-act="ing-field" data-field="base">${Units.BASES.map((b) => `<option value="${b}"${i.base === b ? " selected" : ""}>${b}</option>`).join("")}</select></label>
          <label title="Usable part after trimming${SITE.commis ? "" : " (Rendement in Master Data)"}: 65 = 65%. Every price is divided by it.">Yield <input class="in in--num" inputmode="decimal" data-k="i-yield" data-act="ing-field" data-field="yield" value="${esc(yieldPct(i.yield))}" /> %</label>
          <label class="check"><input type="checkbox" data-k="i-inv" data-act="ing-field" data-field="in_inventory" ${i.in_inventory !== false ? "checked" : ""} /> On the monthly count</label>
          ${i.base === "recipe" || i.base === "portion" ? "" : `<label title="Lets recipes use this by weight when it's bought by the unit or bunch, or the other way round">1 ${Units.countable(i.base) ? unitLabel(i.base) : "unit"} weighs <input class="in in--num" inputmode="decimal" data-k="i-each" data-act="ing-field" data-field="each_kg" value="${esc(numText(i.each_kg))}" placeholder="—" /> kg</label>`}
        </div>
      </div>

      ${BAR && i.base === "L" ? bottleCard(i) : ""}

      <section class="card card--flat">
        <h2>Made in-house</h2>
        ${(() => {
          const prep = i.prep_id && get("recipes", i.prep_id);
          const linked = prep && coster.linkedOffer(i);
          const info = !prep ? `<p class="hint">If you make this yourself, pick the prep it's made from: its price will be what the prep costs today, and follow your ingredient prices.</p>`
            : linked ? `<p>Price comes from <a href="#/recipe/${encodeURIComponent(prep.id)}"><strong>${esc(prep.name)}</strong></a>: one batch costs ${money(linked.offer.pack_cost)} for ${esc(numText(linked.offer.pack_qty))} ${esc(unitLabel(linked.offer.pack_unit))}
                = <strong>${money(linked.price, true)}${per(i.base)}</strong>. ${data.offers.some((x) => x.ingredient_id === i.id) ? "The batch size is the pack size of the ticked price below (its price is kept but not used)." : "The batch size is what the prep makes."}</p>`
            : `<p class="note note--bad">Linked to <a href="#/recipe/${encodeURIComponent(prep.id)}">${esc(prep.name)}</a>, but its batch isn't measured in ${esc(i.base)}: give the prep its batch weight, or a pack size below.</p>`;
          return info + `<label class="block">Made from prep <input class="in" list="dl-preps" data-k="i-prep" data-act="ing-field" data-field="prep_id" value="${esc(prep ? prep.name : "")}" placeholder="Start typing a prep's name, or leave empty" /></label>`;
        })()}
      </section>

      ${BAR && i.base === "L" ? "" : measuresCard(i)}

      ${allergenCard(i)}

      ${isPrepped(i) ? `<section class="card card--flat"><h2>Price lock</h2>
        ${lockBox({ kind: "ingredient", id: i.id, unit: i.base, locked: parseNum(i.locked_price), at: i.locked_at, live: (coster.liveOffer(i.id) || {}).price })}</section>` : ""}

      ${estimatedHere ? `<p class="note">Type your best estimate below. It's used in costs right away, flagged until an administrator double checks it. After that, only they can change it.</p>` : ""}
      <h2>Supplier prices</h2>
      <p class="hint">The ticked price is the one recipes use (a recipe line can still pick another). "Name on invoice" is how the supplier writes it, for reading invoices later.</p>
      <div class="table-wrap"><table class="lines lines--offers">
        <thead><tr><th title="Used in recipes">Use</th><th>Supplier</th><th>Name on invoice</th><th class="num">Pack price</th><th class="num">Pack size</th><th class="num">Price${per(i.base)}</th><th>Updated</th><th><span class="vh">Actions</span></th></tr></thead>
        <tbody>${offerRows || `<tr><td colspan="8" class="muted">No prices yet.</td></tr>`}</tbody>
      </table></div>
      <button class="btn" data-act="add-offer" data-id="${esc(i.id)}">+ Add a supplier price</button>
      ${(() => {
        const y = parseNum(i.yield) || 1, d = coster.defaultOffer(i.id);
        if (y === 1) return `<p class="hint">Yield 100%: all of it is usable. If some is lost to trimming, type the usable part in Yield (e.g. 65) and every price follows.</p>`;
        return `<p class="hint">Yield ${yieldPct(y)}%: prices are per usable ${esc(unitLabel(i.base))}, pack price ÷ (pack size × ${numText(y)})${d && !d.offer.locked
          ? `: <strong>${money(d.price * y, true)}${per(i.base)}</strong> as bought is <strong>${money(d.price, true)}${per(i.base)}</strong> usable` : ""}.</p>`;
      })()}

      ${historyCard(i)}

      <div>
        <section>
          <h2>Used in (${used.length + inBar.length})</h2>
          ${used.length ? `<ul class="plain">${used.map((r) => `<li><a href="#/recipe/${encodeURIComponent(r.id)}">${esc(r.name)}</a> <span class="tag">${r.kind}</span></li>`).join("")}</ul>` : inBar.length ? "" : `<p class="muted">Not used in any recipe.</p>`}
          ${inBar.length ? `<ul class="plain">${inBar.map((r) => `<li>${esc(r.name)} ${barTag}</li>`).join("")}</ul>` : ""}
          <label class="block">Notes<textarea class="in" rows="3" data-k="i-notes" data-act="ing-field" data-field="notes">${esc(i.notes || "")}</textarea></label>
          <div class="actions">
            <button class="btn" data-act="merge" data-id="${esc(i.id)}">Merge into another…</button>
            <button class="btn btn--danger" data-act="delete-ingredient" data-id="${esc(i.id)}" ${used.length || inBar.length ? `disabled title="Remove it from its recipes first, or merge it into another ingredient"` : ""}>Delete ingredient</button>
          </div>
        </section>
      </div>`;
  }

  /* ---------- price history ---------- */
  // Every price change is kept with its date. Prices brought in as a starting point (Master Data, the Hector copy,
  // the inventory sheet) carry the day they were imported, not the day they were paid: they're shown as starting
  // prices and kept out of the trend. Prices compare at today's yield, per kg / L / unit.
  const STARTING = /^(Master Data import|Hector price copy|Inventory sheet|Pack size from the inventory sheet|Back to the Master Data)/;
  const HIST_PERIODS = [["2m", "2 months", 2], ["6m", "6 months", 6], ["1y", "1 year", 12], ["all", "All", null]];
  const HIST_KEY = "costing.histPeriod";
  const SERIES_MAX = 3; // the chart's validated colours; more suppliers stay in the list
  const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthsBefore = (iso, n) => { const [y, m, d] = iso.split("-").map(Number); const t = new Date(y, m - 1 - n, d); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`; };
  let histChart = null; // what afterRender draws: { unit, from, to, series: [{ name, start, points }] }

  function priceHistory(i, periodKey) {
    const period = HIST_PERIODS.find((p) => p[0] === periodKey) || HIST_PERIODS[1];
    const priceOf = (h) => coster.offerPrice({ pack_cost: h.pack_cost, pack_qty: h.pack_qty, pack_unit: h.pack_unit }, i);
    const rows = data.price_history.filter((h) => h.ingredient_id === i.id && h.date)
      .map((h) => ({ h, date: h.date, supplier: (h.supplier || "").trim() || "No supplier", price: priceOf(h), start: STARTING.test(h.source || "") }));
    // Each supplier price, day by day: where the day ended up, not the steps of typing it in.
    const finals = new Set();
    const perOffer = new Map();
    for (const x of rows) { if (x.start) continue; const k = x.h.offer_id || x.supplier; if (!perOffer.has(k)) perOffer.set(k, []); perOffer.get(k).push(x.h); }
    for (const list of perOffer.values()) Costing.lastOfEachDay(list).forEach((h) => finals.add(h));
    const dated = rows.filter((x) => !x.start && x.price != null && finals.has(x.h)).sort((a, b) => a.date.localeCompare(b.date) || 0);
    const to = today();
    const from = period[2] ? monthsBefore(to, period[2]) : dated.length ? dated[0].date : to;
    // Per supplier: the price going into the period (its last one before it), then each one in it.
    const names = [...new Set(dated.map((x) => x.supplier))];
    const suppliers = names.map((name) => {
      const mine = dated.filter((x) => x.supplier === name);
      const before = mine.filter((x) => x.date < from).pop() || null;
      const points = mine.filter((x) => x.date >= from);
      const span = (before ? [before] : []).concat(points);
      const first = span[0], last = span[span.length - 1];
      const low = span.reduce((a, x) => (x.price < a.price ? x : a), first), high = span.reduce((a, x) => (x.price > a.price ? x : a), first);
      return { name, before, points, first, last, low, high, count: points.length };
    }).filter((s) => s.points.length || s.before)
      .sort((a, b) => b.count - a.count || (b.last.date || "").localeCompare(a.last.date || ""));
    const listed = rows.filter((x) => !x.start && finals.has(x.h) && x.date >= from).sort((a, b) => b.date.localeCompare(a.date));
    // Change against the same supplier's price before it.
    for (const x of listed) { const prev = dated.filter((y) => y.supplier === x.supplier && y.date < x.date).pop(); x.prev = prev ? prev.price : null; }
    return { period, from, to, suppliers, listed, starting: rows.filter((x) => x.start) };
  }

  function historyCard(i) {
    const key = readJSON(HIST_KEY, "6m");
    const H = priceHistory(i, key);
    const u = per(i.base);
    const chip = (a, b) => { if (a == null || b == null || Math.abs(b - a) < 0.005) return `<span class="muted">same</span>`;
      const up = b > a; return `<span class="chip ${up ? "chip--up" : "chip--down"}">${up ? "▲" : "▼"} ${money(Math.abs(b - a), true)} (${up ? "+" : "−"}${a > 0 ? ((p) => p.toFixed(p < 1 ? 1 : 0))(Math.abs(((b - a) / a) * 100)) : "—"}%)</span>`; };
    const buttons = HIST_PERIODS.map(([k, label]) => `<button type="button" class="sec" data-act="hist-period" data-p="${k}" aria-pressed="${H.period[0] === k}">${label}</button>`).join("");
    const shown = H.suppliers.slice(0, SERIES_MAX);
    histChart = shown.length && shown.some((s) => s.points.length) ? { unit: u, from: H.from, to: H.to,
      series: shown.map((s) => ({ name: s.name, start: s.before ? s.before.price : null, points: s.points.map((x) => ({ date: x.date, price: x.price })) })) } : null;
    const since = H.period[2] ? `the last ${H.period[1]}` : "all the prices kept";
    const summary = H.suppliers.length ? `<div class="table-wrap"><table class="list small hist-sum cards">
      <thead><tr><th>Supplier</th><th class="num">Start</th><th class="num">Now</th><th>Change</th><th class="num">Lowest</th><th class="num">Highest</th><th class="num">Prices</th></tr></thead><tbody>
      ${H.suppliers.map((s, k) => `<tr><td>${k < SERIES_MAX && histChart ? `<span class="key key--${k + 1}" aria-hidden="true"></span>` : ""}${esc(s.name)}</td>
        <td class="num nowrap">${money(s.first.price, true)}${u} <span class="muted small">${esc(s.first.date)}</span></td>
        <td class="num nowrap"><strong>${money(s.last.price, true)}${u}</strong> <span class="muted small">${esc(s.last.date)}</span></td>
        <td>${chip(s.first.price, s.last.price)}</td>
        <td class="num nowrap">${money(s.low.price, true)} <span class="muted small">${esc(s.low.date)}</span></td>
        <td class="num nowrap">${money(s.high.price, true)} <span class="muted small">${esc(s.high.date)}</span></td>
        <td class="num">${s.count}</td></tr>`).join("")}
      </tbody></table></div>` : "";
    const list = H.listed.length ? `<details class="hist-list"${H.listed.length <= 12 ? " open" : ""}><summary>Every price in ${esc(since)} (${H.listed.length})</summary>
      <div class="table-wrap"><table class="list small cards"><thead><tr><th>Date</th><th>Supplier</th><th class="num">Pack</th><th class="num">Price${u}</th><th>Change</th><th>From</th></tr></thead><tbody>
      ${H.listed.map((x) => `<tr><td class="nowrap">${esc(x.date)}</td><td>${esc(x.supplier)}</td><td class="num nowrap">${money(+x.h.pack_cost)} / ${esc(numText(x.h.pack_qty))} ${esc(unitLabel(x.h.pack_unit))}</td>
        <td class="num">${money(x.price, true)}</td><td>${x.prev == null ? `<span class="muted">first</span>` : chip(x.prev, x.price)}</td><td class="muted">${esc(x.h.source || "")}</td></tr>`).join("")}
      </tbody></table></div></details>` : "";
    const starting = H.starting.length ? `<p class="hint">Starting price${H.starting.length > 1 ? "s" : ""} brought in from your sheets (date unknown, so not in the trend): ${H.starting.map((x) => `${esc(x.h.supplier || x.h.source || "")} ${money(x.price, true)}${u}`).join(" · ")}.</p>` : "";
    const empty = !H.suppliers.length ? `<p class="muted">No dated prices ${H.period[2] ? `in ${esc(since)}` : "yet"}. Each invoice you save, and each price you type in, is kept here with its date.</p>` : "";
    return `<section class="card card--flat hist">
      <div class="bar"><h2>Price history</h2><div class="hist-periods" role="group" aria-label="Period">${buttons}</div></div>
      ${empty}${histChart ? `<div class="hchart" data-hchart role="img" aria-label="Price ${esc(u)} over ${esc(since)}: see the table below"></div>` : ""}
      ${summary}${H.suppliers.length > SERIES_MAX ? `<p class="hint">The chart shows the ${SERIES_MAX} suppliers with the most prices; the others are in the tables.</p>` : ""}
      ${list}${starting}
    </section>`;
  }

  /** Draws the price chart at the width it actually has: a step line per supplier (a price holds until the next
   * one), a dot per price, a crosshair and readout on hover or with the arrow keys. */
  function drawHistChart() {
    const box = $("[data-hchart]", main);
    if (!box || !histChart) return;
    const C = histChart, W = Math.max(280, box.clientWidth), Hh = 200, m = { l: 58, r: 14, t: 12, b: 26 };
    const day = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
    const x0 = day(C.from), x1 = Math.max(day(C.to), x0 + 864e5);
    const vals = C.series.flatMap((s) => (s.start != null ? [s.start] : []).concat(s.points.map((p) => p.price)));
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (hi - lo < 0.01) { lo -= Math.max(0.5, lo * 0.1); hi += Math.max(0.5, hi * 0.1); }
    // Clean ticks: 1, 2 or 5 times a power of ten, about four of them.
    const raw = (hi - lo) / 4, pow = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 5, 10].map((k) => k * pow).find((k) => k >= raw);
    lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
    const X = (t) => m.l + ((t - x0) / (x1 - x0)) * (W - m.l - m.r), Y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (Hh - m.t - m.b);
    const ns = "http://www.w3.org/2000/svg", el = (tag, attrs, text) => { const e = document.createElementNS(ns, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; return e; };
    const svg = el("svg", { width: W, height: Hh, viewBox: `0 0 ${W} ${Hh}`, class: "hchart__svg" });
    for (let v = lo; v <= hi + step / 2; v += step) {
      svg.append(el("line", { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), class: "hchart__grid" }));
      svg.append(el("text", { x: m.l - 8, y: Y(v) + 4, "text-anchor": "end", class: "hchart__tick" }, "$" + v.toFixed(step < 1 ? 2 : 0)));
    }
    // Month ticks, thinned so they never crowd.
    const months = [];
    for (let d = new Date(Date.UTC(+C.from.slice(0, 4), +C.from.slice(5, 7), 1)); d.getTime() <= x1; d.setUTCMonth(d.getUTCMonth() + 1)) months.push(d.getTime());
    const every = Math.ceil(months.length / Math.max(2, Math.floor((W - m.l - m.r) / 70)));
    months.forEach((t, k) => { if (k % every) return; const d = new Date(t);
      svg.append(el("text", { x: X(t), y: Hh - 6, "text-anchor": "middle", class: "hchart__tick" }, SHORT_MONTHS[d.getUTCMonth()] + (d.getUTCMonth() === 0 || k === 0 ? " " + d.getUTCFullYear() : ""))); });
    // Step lines, then dots with a ring in the surface colour.
    C.series.forEach((s, k) => {
      const pts = s.points.map((p) => [X(day(p.date)), Y(p.price)]);
      let d = s.start != null ? `M${X(x0)},${Y(s.start)}` : pts.length ? `M${pts[0][0]},${pts[0][1]}` : "";
      pts.forEach(([px, py], j) => { d += j === 0 && s.start == null ? "" : `H${px}V${py}`; });
      d += `H${X(x1)}`;
      svg.append(el("path", { d, class: `hchart__line hchart__line--${k + 1}`, "stroke-linejoin": "round", "stroke-linecap": "round" }));
      pts.forEach(([px, py]) => svg.append(el("circle", { cx: px, cy: py, r: 4, class: `hchart__dot hchart__dot--${k + 1}` })));
    });
    const cross = el("line", { y1: m.t, y2: Hh - m.b, class: "hchart__cross", visibility: "hidden" });
    svg.append(cross);
    box.replaceChildren(svg);
    // Legend for two or more suppliers: a line key and the name in text colour.
    if (C.series.length > 1) {
      const leg = document.createElement("div"); leg.className = "hchart__legend";
      C.series.forEach((s, k) => { const it = document.createElement("span"); const key = document.createElement("span"); key.className = `key key--${k + 1}`; it.append(key, document.createTextNode(s.name)); leg.append(it); });
      box.prepend(leg);
    }
    // Hover and keys: the crosshair snaps to the nearest date with a price; the readout lists every supplier.
    const dates = [...new Set(C.series.flatMap((s) => s.points.map((p) => p.date)))].sort();
    const at = (s, iso) => { const p = s.points.filter((q) => q.date <= iso).pop(); return p ? p.price : s.start; };
    const tip = document.createElement("div"); tip.className = "hchart__tip"; tip.hidden = true; box.append(tip);
    let cur = -1;
    const show = (k) => {
      cur = Math.max(0, Math.min(dates.length - 1, k));
      const iso = dates[cur], px = X(day(iso));
      cross.setAttribute("x1", px); cross.setAttribute("x2", px); cross.setAttribute("visibility", "visible");
      tip.replaceChildren();
      const head = document.createElement("div"); head.className = "hchart__date"; head.textContent = iso; tip.append(head);
      C.series.forEach((s, j) => { const v = at(s, iso); if (v == null) return;
        const row = document.createElement("div"); row.className = "hchart__row";
        const key = document.createElement("span"); key.className = `key key--${j + 1}`;
        const val = document.createElement("strong"); val.textContent = money(v, true) + C.unit;
        const name = document.createElement("span"); name.className = "muted"; name.textContent = s.name;
        row.append(key, val, name); tip.append(row); });
      tip.hidden = false;
      const left = Math.min(px + 12, W - tip.offsetWidth - 4);
      tip.style.left = (px + 12 + tip.offsetWidth > W ? px - tip.offsetWidth - 12 : left) + "px";
    };
    const hide = () => { cross.setAttribute("visibility", "hidden"); tip.hidden = true; };
    const nearest = (clientX) => { const r = svg.getBoundingClientRect(), x = clientX - r.left;
      let best = 0; dates.forEach((iso, k) => { if (Math.abs(X(day(iso)) - x) < Math.abs(X(day(dates[best])) - x)) best = k; }); return best; };
    svg.addEventListener("pointermove", (e) => show(nearest(e.clientX)));
    svg.addEventListener("pointerleave", hide);
    box.tabIndex = 0;
    box.addEventListener("focus", () => show(dates.length - 1));
    box.addEventListener("blur", hide);
    box.addEventListener("keydown", (e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); show(cur + (e.key === "ArrowLeft" ? -1 : 1)); } else if (e.key === "Escape") hide(); });
  }

  /* ---------- locked prices ---------- */
  // A prepped item (or a prep) can keep the price you lock, so the inventory and the recipes using it don't move
  // with ingredient prices until you unlock it or lock it again at today's price.
  const isPrepped = (i) => !!(i.prep_id || /prep/i.test(i.category || "") || section(i) === prepSection() || parseNum(i.locked_price) != null);
  const lockTag = (at, short) => `<span class="tag tag--lock" title="Price locked${at ? " since " + esc(at) : ""}">🔒${short ? "" : " locked"}</span>`;
  function lockBox({ kind, id, unit, locked, at, live }) {
    const what = kind === "recipe" ? "cost" : "price";
    if (locked == null) {
      return `<div class="lock"><p class="lock__text">${live == null ? `No ${what} to lock yet.`
        : `Today's ${what}: <strong>${money(live, true)}${per(unit)}</strong>. Lock it to keep it for the inventory and every recipe using it, even when ingredient prices move.`}</p>
        ${live != null ? `<div><button class="btn" data-act="lock" data-kind="${kind}" data-id="${esc(id)}">🔒 Lock at ${money(live, true)}${per(unit)}</button></div>` : ""}</div>`;
    }
    const diff = live == null ? null : live - locked;
    const moved = diff != null && Math.abs(diff) >= 0.00005;
    return `<div class="lock lock--on">
      <p class="lock__text"><strong>🔒 Locked</strong>${at ? ` since ${esc(at)}` : ""}: the inventory and every recipe using it keep this ${what}.
        ${live == null ? "" : moved ? `Today it would be ${money(live, true)}${per(unit)} <span class="chip ${diff > 0 ? "chip--up" : "chip--down"}">${diff > 0 ? "▲" : "▼"} ${money(Math.abs(diff), true)}</span>` : `Today's ${what} is the same.`}</p>
      <div class="actions">
        <label class="lock__field">Locked at ${moneyInput(`data-k="lock-${esc(id)}" data-act="lock-field" data-kind="${kind}" data-id="${esc(id)}" value="${esc(numText(locked))}" aria-label="Locked ${what}"`)}<span class="muted">${esc(per(unit))}</span></label>
        ${moved ? `<button class="btn" data-act="lock" data-kind="${kind}" data-id="${esc(id)}">Lock at today's ${what}</button>` : ""}
        <button class="btn" data-act="unlock" data-kind="${kind}" data-id="${esc(id)}">Unlock</button>
      </div></div>`;
  }
  /** value: a price per unit, "today" (what it costs right now), or null to unlock. */
  async function setLock(kind, id, value) {
    if (Store.part7Old()) { toast("Run part 7 of supabase/schema.sql in Supabase (SQL Editor) to lock prices.", true); return render(); }
    const table = kind === "recipe" ? "recipes" : "ingredients", field = kind === "recipe" ? "locked_cost" : "locked_price";
    let v = value;
    if (value === "today") {
      if (kind === "recipe") { const rc = coster.recipeCost(id); v = rc.live ? rc.live.perYield : rc.perYield; }
      else v = (coster.liveOffer(id) || {}).price;
      if (v == null) { toast("There's no price to lock yet.", true); return; }
    }
    await write(() => patch(table, id, { [field]: v == null ? null : Math.round(v * 10000) / 10000, locked_at: v == null ? null : today() }));
    if (!write.failed) toast(v == null ? "Unlocked: it follows today's prices again." : `Locked at ${money(v, true)}.`);
  }

  /* ---------- recipe cards ---------- */
  // Made from your own template file (Settings → Recipe card template): see cardfill.js for what's filled in.
  function amountText(qty, unit) {
    if (qty == null) return "";
    const n = (v) => String(+(+v).toFixed(3)).replace(/\.0+$/, "");
    if (unit === "kg" && qty < 1) return n(qty * 1000) + "g";
    if (unit === "L" && qty < 1) return n(qty * 1000) + "ml";
    // A scaled card can turn grams into thousands: 87500g reads as 87.5kg.
    if (unit === "g" && qty >= 1000) return n(qty / 1000) + "kg";
    if (unit === "ml" && qty >= 1000) return n(qty / 1000) + "L";
    if (unit === "kg" || unit === "g" || unit === "ml") return n(qty) + unit;
    if (unit === "L") return n(qty) + "L";
    if (unit === "portion" || unit === "recipe") return n(qty) + " " + (qty === 1 ? unit : plural(unit)) + " of";
    if (unit === "bunch") return n(qty) + "b";
    if (unit === "dozen") return n(qty) + " dozen";
    return n(qty);
  }
  /** What goes on a recipe's card: "2.45kg Salt" lines, the steps and notes one per line, both batch measures. */
  function cardData(r) {
    // A standard set for the card (e.g. 1 kg of pork): the card shows those amounts, the recipe keeps its own.
    const std = cardStandard(r), after = std ? new Map(std.p.rows.map((x) => [x.l.id, x.after])) : null;
    const ingredients = (coster.linesByRecipe.get(r.id) || []).map((l) => {
      const item = l.ingredient_id ? get("ingredients", l.ingredient_id) : get("recipes", l.sub_recipe_id);
      const qty = after && after.has(l.id) ? after.get(l.id) : parseNum(l.qty);
      return item ? `${amountText(qty, l.unit)} ${item.name}`.trim() : null;
    }).filter(Boolean);
    const lines = (s) => String(s || "").split(/\n+/).map((x) => x.trim()).filter(Boolean);
    const measure = (q, u) => { const w = +q === 1 ? unitLabel(u) : plural(u); return `${numText(q)} ${u === "portion" || u === "recipe" ? w[0].toUpperCase() + w.slice(1) : w}`; };
    // Both measures on the card when there are two: "30 Portions / 3.2 kg".
    const yq = std ? std.p.yieldAfter : r.yield_qty, aq = std && std.p.altNow ? std.p.altAfter : r.alt_qty;
    const more = std ? std.p.more.map((m) => measure(m.after, m.unit)) : Costing.savedMeasures(r).map((m) => measure(m.qty, m.unit));
    const yieldText = [measure(yq, r.yield_unit), ...(parseNum(aq) && r.alt_unit ? [measure(aq, r.alt_unit)] : []), ...more].join(" / ");
    return { name: r.name, readyIn: r.ready_in || "", yieldText, ingredients, steps: lines(r.method), notes: lines(r.notes) };
  }

  /** Your template, as Word bytes, read fresh from Drive (so changes you make to it are used straight away). */
  async function cardTemplate() {
    const t = settings.drive && settings.drive.template;
    if (!t) throw new Error("Pick your recipe card template first (Settings → Google Drive).");
    const { file, bytes } = await GDrive.wordOf(t.id);
    return { bytes, asDoc: file.mimeType === GDrive.GOOGLE_DOC };
  }
  const cardUrl = (id) => "https://drive.google.com/open?id=" + encodeURIComponent(id);

  /** The app's own cards folder inside the folder you picked, so new cards never mix with the old ones. */
  async function cardsFolder() {
    const d = settings.drive || {};
    if (d.cards && (await GDrive.exists(d.cards.id))) return d.cards;
    const made = await GDrive.makeFolder(`Recipe cards (${SITE.app})`, d.folder.id);
    await saveSettings({ ...settings, drive: { ...d, cards: made } });
    return made;
  }

  async function saveCard(r, tpl) {
    const folder = await cardsFolder();
    const bytes = await CardFill.docx(tpl.bytes, cardData(r));
    // The card is the same kind of file as the template (Google Doc or Word). One already there is updated in
    // place, so its link stays the same; one of the other kind is replaced and moved to Drive's bin.
    const old = r.card_doc_id ? await GDrive.info(r.card_doc_id) : null;
    const keep = old && !old.trashed && old.mimeType === (tpl.asDoc ? GDrive.GOOGLE_DOC : GDrive.DOCX);
    const doc = await GDrive.saveWord({ name: r.name, bytes, folderId: folder.id, existingId: keep ? old.id : null, asDoc: tpl.asDoc });
    if (old && !old.trashed && !keep) await GDrive.trash(old.id);
    if (doc.id !== r.card_doc_id) await patch("recipes", r.id, { card_doc_id: doc.id });
    return doc;
  }

  /* ---------- monthly inventory ---------- */
  // Tab names match the existing inventory sheet ("Septembre 2026", "Aout 2026").
  const MONTHS = ["Janvier", "Fevrier", "Mars", "Avril", "Mai", "Juin", "Juillet", "Aout", "Septembre", "Octobre", "Novembre", "Decembre"];
  const thisMonth = () => today().slice(0, 7);
  const monthLabel = (m) => `${MONTHS[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;
  const shiftMonth = (m, n) => { const d = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 1 + n, 1)); return d.toISOString().slice(0, 7); };
  const onCount = (i) => i.in_inventory !== false;
  // Preps are only counted when ticked; they sit with the other prepared items and are worth what they cost to make.
  // Renaming the "Preppeds" section in Settings → Categories renames this too.
  const prepSection = () => (settings.categories && settings.categories.prepSection) || "Preppeds";
  const countKey = (c) => (c.recipe_id ? "r:" + c.recipe_id : c.ingredient_id);

  // How much of what the price is per this comes to. The unit it's priced in is always itself.
  const pricedAmount = (it, qty, unit) => (unit === it.base ? qty : it.kind === "prep" ? coster.subAmount(qty, unit, it.recipe) : coster.itemAmount(it.ing, qty, unit));
  // Containers typed for a row with no count yet (this visit only); a count keeps its own.
  const pendingContainers = new Map();
  const gramsText = (kg) => (kg < 1 ? numText(+(kg * 1000).toPrecision(4)) + " g" : numText(+kg.toPrecision(4)) + " kg");

  /** The record a month stands on, if it's closed. A reopened one stays saved but no longer counts. */
  const closedMonth = (month) => (data.closed_months || []).find((c) => c.month === month && !c.reopened_at) || null;
  /** A month's rows: its record once it's closed, so nothing that changes afterwards can move them; else today's numbers. */
  function inventoryRows(month) {
    const closed = closedMonth(month);
    return closed ? Summary.thaw(closed) : liveRows(month);
  }

  /** One row per counted ingredient or prep: what's in stock and what it's worth at today's prices. */
  function liveRows(month) {
    const counts = new Map(data.counts.filter((c) => c.month === month).map((c) => [countKey(c), c]));
    const before = new Map(data.counts.filter((c) => c.month === shiftMonth(month, -1)).map((c) => [countKey(c), c]));
    const items = data.ingredients.filter(onCount).map((i) => ({ kind: "ingredient", key: i.id, id: i.id, name: i.name, category: i.category, base: i.base, ing: i }))
      .concat(data.recipes.filter((r) => r.kind === "prep" && r.in_inventory === true)
        .map((r) => ({ kind: "prep", key: "r:" + r.id, id: r.id, name: r.name, category: prepSection(), base: r.yield_unit, recipe: r })));
    return sortBySection(items).map((it) => {
      let price = null, offer = null, batch = null, locked = null;
      if (it.kind === "ingredient") { const def = coster.defaultOffer(it.id); if (def) { price = def.price; offer = def.offer; if (offer.locked) locked = offer.locked_at || ""; } }
      else { const rc = coster.recipeCost(it.id); batch = rc.total; price = rc.perYield; if (rc.locked) locked = it.recipe.locked_at || ""; }
      const c = counts.get(it.key), p = before.get(it.key);
      const qty = c ? parseNum(c.qty) : null;
      // The unit it's counted in: what this count was typed in (older counts: the unit it's priced in), else the pick.
      const x = it.kind === "prep" ? it.recipe : it.ing;
      let choices = Store.part16Old() ? [it.base] : coster.countChoices(x, it.kind === "prep");
      // Barback: a bottle with a size is counted in bottles unless you picked otherwise.
      if (BAR && it.kind === "ingredient" && choices.includes("bottle")) choices = ["bottle", ...choices.filter((u) => u !== "bottle" && u !== "recipe")];
      const unit = qty != null ? c.unit || it.base : choices.includes(x.count_unit) ? x.count_unit : choices[0] === "bottle" ? "bottle" : it.base;
      if (!choices.includes(unit)) choices.unshift(unit);
      const one = pricedAmount(it, 1, unit); // how much of what the price is per one of these is
      const inPriced = qty == null ? null : pricedAmount(it, qty, unit);
      // Last month's, in this month's unit when it can be turned into it.
      const lastQty = p ? parseNum(p.qty) : null, lastFrom = p ? p.unit || it.base : null;
      const lastPriced = lastQty == null ? null : pricedAmount(it, lastQty, lastFrom);
      const lastHere = lastPriced != null && one ? +(lastPriced / one).toFixed(6) : null;
      // A container comes off when counting by weight (a past count keeps what it was saved at).
      const tare = unit === "kg" ? parseNum(x.container_kg) : null;
      const containers = c && c.containers != null ? parseNum(c.containers) : pendingContainers.has(it.key) ? pendingContainers.get(it.key) : 1;
      // Barback, a bottle with its weights: full ones are counted, opened ones weighed.
      const hybrid = BAR && it.kind === "ingredient" && unit === "bottle" && Barback.canWeigh(x);
      const full = !hybrid || !c ? null : c.full_bottles != null ? parseNum(c.full_bottles) : c.open_g ? null : qty;
      return { item: it, kind: it.kind, offer, batch, price, locked, count: c, qty, unit, choices, one, tare: tare > 0 ? tare : null, containers, hybrid, full, openG: hybrid && c ? c.open_g || "" : "",
        unitPrice: price != null && one != null ? price * one : price, problem: qty != null && inPriced == null,
        value: inPriced != null && price != null ? inPriced * price : 0,
        last: lastHere != null ? lastHere : lastQty, lastUnit: lastHere != null ? unit : lastFrom };
    });
  }

  /** Where a month stands: closed (the record, and how to reopen it), or a past month still following today's prices. */
  function monthStatus(month, anyCounted) {
    const c = closedMonth(month);
    if (c) {
      const when = String(c.closed_at || "").slice(0, 10);
      return `<div class="alert alert--closed"><div><strong>🔒 Closed.</strong> ${c.source ? `From your ${esc(c.source.toLowerCase())}.` : `Since ${esc(when)}.`} These are the numbers on record: amounts, prices and values stay as they are, whatever changes later.</div>
        ${c.source ? "" : `<button class="btn" data-act="month-reopen" data-month="${month}">Reopen</button>`}</div>
        <p class="print-only print-sign">Closed${c.source ? "" : " " + esc(when)}: these are the numbers on record.</p>`;
    }
    if (Store.part17Old()) return anyCounted && month < thisMonth() ? `<p class="note note--bad">Run part 17 of supabase/schema.sql in Supabase (SQL Editor) to close a month, so its numbers stop moving.</p>` : "";
    if (!anyCounted || month >= thisMonth()) return "";
    return `<div class="alert alert--check"><div>Still open: these numbers follow today's prices until you close the month.</div><button class="btn" data-act="month-close" data-month="${month}">Close this month</button></div>`;
  }

  function inventoryPage(monthParam) {
    const month = /^\d{4}-\d{2}$/.test(monthParam || "") ? monthParam : thisMonth();
    const rows = inventoryRows(month);
    const lastRows = inventoryRows(shiftMonth(month, -1));
    const total = rows.reduce((s, r) => s + r.value, 0);
    const lastTotal = lastRows.reduce((s, r) => s + r.value, 0);
    const counted = rows.filter((r) => r.qty != null).length;
    const closed = closedMonth(month), onTheCount = closed ? closed.items : rows.length;
    const sheet = settings.drive && settings.drive.sheet;
    const bySec = new Map();
    for (const r of rows) {
      const s = section(r.item);
      if (!bySec.has(s)) bySec.set(s, { value: 0, last: 0 });
      bySec.get(s).value += r.value;
    }
    for (const r of lastRows) { const s = bySec.get(section(r.item)); if (s) s.last += r.value; }
    let current = null;
    const body = rows.map((r) => {
      const s = section(r.item);
      const head = s !== current ? `<tr class="section-row" data-section="${esc(s)}" data-value="${bySec.get(s).value}"><th colspan="3" scope="colgroup">${esc(s)}</th><th class="num no-print" colspan="2">${money(bySec.get(s).value)}</th></tr>` : "";
      current = s;
      const i = r.item, u = plural(r.unit), lastU = r.lastUnit ? plural(r.lastUnit) : "";
      const shownQty = r.hybrid ? r.full : r.qty != null && r.tare ? r.qty + r.containers * r.tare : r.qty;
      const lastNote = `${esc(numText(r.last))} ${esc(lastU)}`;
      const href = r.kind === "prep" ? `#/recipe/${encodeURIComponent(i.id)}` : `#/ingredient/${encodeURIComponent(i.id)}`;
      // In a closed month an item can be long gone: its name stays, without a link to nowhere.
      const stillThere = i.id && get(r.kind === "prep" ? "recipes" : "ingredients", i.id);
      return head + `<tr data-search="${esc(i.name.toLowerCase())}" data-group="${esc(s)}" data-flag="${r.qty == null ? "1" : "0"}">
        <td>${stillThere ? `<a href="${href}">${esc(i.name)}</a>` : `<strong>${esc(i.name)}</strong>`}${r.kind === "prep" ? ` <span class="tag" title="Valued at what it costs to make">prep</span>` : ""}</td>
        <td class="num muted no-print">${r.price == null ? `<span class="warn">no price</span>` : (r.locked != null ? lockTag(r.locked, true) + " " : "") + money(r.unitPrice, true) + per(r.unit)}</td>
        <td class="num muted nowrap"><span class="count-last">${r.last == null ? `<span class="count-last__n"></span><span class="count-last__u"></span>` : `<span class="count-last__n">${esc(numText(r.last))}</span> <span class="count-last__u">${esc(lastU)}</span>`}<span class="count-last__same no-print">${r.last != null && r.qty == null ? `<button class="btn btn--small btn--same" data-act="count-same" data-kind="${r.kind}" data-id="${esc(i.id)}" data-month="${month}" data-qty="${esc(numText(r.last))}" data-unit="${esc(r.unit)}" data-last-unit="${esc(r.lastUnit)}" title="Nothing used: keep last month's ${lastNote}">Same</button>` : ""}</span></span></td>
        <td class="num nowrap count-cell"><span class="count-box">${r.frozen ? `<span class="count-frozen">${esc(numText(r.qty))}</span>` : `<input class="in in--num" inputmode="decimal" data-k="cnt-${i.id}" data-act="count" data-kind="${r.kind}" data-id="${esc(i.id)}" data-month="${month}" data-unit="${esc(r.unit)}" ${r.last != null ? `data-last="${esc(numText(r.last))}" data-last-unit="${esc(r.lastUnit)}"` : ""} value="${esc(numText(shownQty))}" aria-label="${r.hybrid ? "Full bottles" : r.tare ? "Scale reading" : "Stock"} of ${esc(i.name)} in ${esc(u)}" />`}
          ${r.choices.length > 1 ? `<select class="in count-unit no-print" data-k="cnt-u-${i.id}" data-act="count-unit" data-kind="${r.kind}" data-id="${esc(i.id)}" data-month="${month}" aria-label="Count ${esc(i.name)} in">${r.choices.map((c) => `<option value="${esc(c)}"${c === r.unit ? " selected" : ""}>${esc(r.hybrid && c === "bottle" ? "full bottles" : plural(c))}</option>`).join("")}</select><span class="count-unit count-unit--text print-text">${esc(r.hybrid ? "full bottles" : u)}</span>`
          : `<span class="count-unit count-unit--text muted">${esc(u)}</span>`}</span>
          ${r.tare ? `<span class="count-tare no-print">− <input class="in in--tare" inputmode="decimal" data-k="cnt-c-${i.id}" data-act="count-containers" data-kind="${r.kind}" data-id="${esc(i.id)}" data-month="${month}" value="${esc(numText(r.containers))}" aria-label="How many containers are on the scale for ${esc(i.name)}" /> × ${esc(gramsText(r.tare))} container${r.qty != null ? ` = <strong>${esc(numText(+r.qty.toFixed(4)))} kg</strong>` : ""}</span>
          <span class="count-tare print-text">with the container (${esc(gramsText(r.tare))} comes off)</span>` : ""}
          ${r.hybrid && !r.frozen ? openBox(r, month) : ""}
          ${r.problem ? `<span class="problem count-tare">${esc(i.name)} has no measure for ${esc(u)} now, so this has no value.</span>` : ""}</td>
        <td class="num no-print">${r.qty == null ? "" : money(r.value)}</td>
      </tr>`;
    }).join("");
    const diff = total - lastTotal;
    return `
      <div class="bar">
        <h1>Inventory: ${esc(monthLabel(month))}</h1>
        <div class="actions" style="margin:0">
          <a class="btn" href="#/inventory/${shiftMonth(month, -1)}">← ${esc(monthLabel(shiftMonth(month, -1)))}</a>
          ${month < thisMonth() ? `<a class="btn" href="#/inventory/${shiftMonth(month, 1)}">${esc(monthLabel(shiftMonth(month, 1)))} →</a>` : ""}
          <a class="btn" href="#/summary/${month}">Summary</a>
          <button class="btn" data-act="inv-print">Print count sheet</button>
          ${!closed && counted && month >= thisMonth() && !Store.part17Old() ? `<button class="btn" data-act="month-close" data-month="${month}">Close this month</button>` : ""}
        </div>
      </div>
      <p class="print-only print-sign">Counted by: ______________________ &nbsp;&nbsp; Date: ______________</p>
      <p class="print-only print-sign" data-picked-print></p>
      ${monthStatus(month, counted > 0)}
      ${Store.schemaOld() ? `<p class="note note--bad">Run the updated supabase/schema.sql once in Supabase before counting: it adds the table that keeps your counts.</p>` : ""}
      <div class="totals totals--row">
        <div><span>Counted</span><strong>${counted} of ${onTheCount}</strong></div>
        <div class="big"><span>Value</span><strong>${money(total)}</strong></div>
        <div><span>${esc(monthLabel(shiftMonth(month, -1)))}</span><strong>${lastTotal ? money(lastTotal) : "—"}</strong></div>
        <div><span>Difference</span><strong>${lastTotal ? `<span class="chip ${diff > 0 ? "chip--up" : "chip--down"}">${diff > 0 ? "+" : "−"}${money(Math.abs(diff))}</span>` : "—"}</strong></div>
        <div>${sheet ? `<button class="btn btn--main" data-act="inv-sheet" data-month="${month}">Send to “${esc(sheet.name)}”</button>` : GDrive.configured() ? `<a href="#/settings">Pick your inventory sheet</a> to send this to Drive.` : ""}</div>
      </div>
      <div class="filters">
        <input type="search" placeholder="Search" data-filter aria-label="Search" />
        ${closed ? "" : `<label class="check"><input type="checkbox" data-filter-flag /> Not counted yet</label>`}
        <span class="picked-total" data-picked-total hidden></span>
      </div>
      ${sectionChips("inventory", rows.map((r) => section(r.item)))}
      ${Store.part5Old() && data.recipes.some((r) => r.in_inventory) ? `<p class="note note--bad">Run the updated supabase/schema.sql (part 5) in Supabase to count preps.</p>` : ""}
      ${closed ? "" : BAR ? `<p class="hint">Count the full bottles in the first box. If a bottle has its empty and full weights, put the opened one on the scale and type the grams in the second box: the two add up. Two opened? <strong>840+700</strong>. With no weights saved, use tenths: <strong>3.4</strong> is three full and one four-tenths full. Press Enter to go on. Nothing used since last month? Press <strong>Same</strong>, or type <strong>=</strong> in the box. Values use today's prices.</p>` : `<p class="hint">Count in the unit shown. An item with other measures has a list beside its box: pick kg, portions, recipes… and the app remembers it for that item. Press Enter to go to the next item. Nothing used since last month?
        Press <strong>Same</strong>, or type <strong>=</strong> in the box, to keep last month's amount. Values use today's prices;
        preps are worth what they cost to make. Tick or untick "On the monthly count" on an ingredient or a prep to add or remove it.</p>`}
      <div class="table-wrap"><table class="list inv cards">
        <thead><tr><th>Item</th><th class="num no-print">Price</th><th class="num">${esc(monthLabel(shiftMonth(month, -1)))}</th><th class="num">${esc(monthLabel(month))}</th><th class="num no-print">Value</th></tr></thead>
        <tbody>${body || `<tr><td colspan="5" class="muted">No ingredients are on the count list.</td></tr>`}</tbody>
      </table></div>`;
  }

  /* ---------- the inventory's summary ---------- */
  const summaryOpen = new Set(); // the groups showing their sections (this visit only)
  const signedMoney = (n) => (Math.abs(n) < 0.005 ? money(0) : (n > 0 ? "+" : "−") + money(Math.abs(n)));

  function summaryPage(monthParam) {
    const month = /^\d{4}-\d{2}$/.test(monthParam || "") ? monthParam : thisMonth(), prev = shiftMonth(month, -1);
    const shape = (rows) => rows.map((r) => ({ section: section(r.item), value: r.value, counted: r.qty != null }));
    const closed = closedMonth(month), prevClosed = closedMonth(prev);
    // A closed month keeps the groups it was closed with; an open one uses your picks today.
    const saved = closed ? closed.groups : (settings.categories || {}).groups || {};
    const s = Summary.build(shape(inventoryRows(month)), shape(inventoryRows(prev)), saved, prevClosed ? prevClosed.groups : (settings.categories || {}).groups || {});
    const cells = (x) => `<td class="num">${money(x.now)}</td><td class="num">${money(x.last)}</td><td class="num">${signedMoney(x.change)}</td>`;
    const body = s.tiers.map((t) => `<tr class="section-row"><th colspan="4" scope="colgroup">${esc(t.label)}</th></tr>` + t.groups.map((g) => {
      const open = summaryOpen.has(g.key);
      return `<tr class="sum-group"><td><button class="sum-toggle" type="button" data-act="sum-toggle" data-key="${esc(g.key)}" aria-expanded="${open}">${esc(g.label)}</button></td>${cells(g)}</tr>`
        + (open ? g.sections.map((x) => `<tr class="sum-section"><td>${esc(x.name)} <span class="muted small nowrap">${x.counted ? `${x.counted} of ${x.items} counted` : x.items ? `<span class="warn">not counted</span>` : "off the count now"}</span></td>${cells(x)}</tr>`).join("") : "");
    }).join("")).join("");

    // The month's food cost, from the two numbers you type.
    const food = s.groups.find((g) => g.key === "food");
    const typed = (settings.stockMonths || {})[month] || {};
    const open = food && food.lastCounted ? food.last : null, shut = food && food.counted ? food.now : null;
    const bought = Summary.spent(data.saved_invoices || [], month), extra = parseNum(typed.purchases);
    const purchases = bought.food || extra != null ? bought.food + (extra || 0) : null;
    const lateCount = (data.saved_invoices || []).filter((x) => String(x.date).slice(0, 7) === month && savedAfterClosing(x, closed)).length;
    const fc = Summary.foodCost({ open, close: shut, purchases, sales: parseNum(typed.sales) });
    const box = (f, label) => moneyInput(`data-k="sum-${f}" data-act="sum-month" data-field="${f}" data-month="${month}" value="${esc(numText(typed[f]))}" aria-label="${esc(label)}"`);
    const showStock = (v, m) => (v == null ? `<span class="muted">not counted in ${esc(monthLabel(m))}</span>` : money(v));

    // Which section goes where: out of the way until you want to change one.
    const names = categoryNames("ingredients").filter((c) => catCount("ingredients", c) > 0 || saved[c]);
    return `
      <p class="crumbs no-print"><a href="#/inventory/${month}">← Back to the count</a></p>
      <div class="bar">
        <h1>Inventory summary: ${esc(monthLabel(month))}</h1>
        <div class="actions" style="margin:0">
          <a class="btn" href="#/summary/${prev}">← ${esc(monthLabel(prev))}</a>
          ${month < thisMonth() ? `<a class="btn" href="#/summary/${shiftMonth(month, 1)}">${esc(monthLabel(shiftMonth(month, 1)))} →</a>` : ""}
          <button class="btn" data-act="inv-print">Print</button>
        </div>
      </div>
      <p class="hint">What your stock is worth by kind of cost${closed ? ", as it stood when the month closed" : ", at today's prices like the count"}. Tap a group to see its sections.</p>
      ${monthStatus(month, s.groups.some((g) => g.counted))}
      ${s.notCounted.length && s.groups.every((g) => !g.counted) ? `<div class="alert alert--check"><div>Nothing has been counted for ${esc(monthLabel(month))} yet.</div></div>`
        : s.notCounted.length ? `<div class="alert alert--check"><div>Nothing counted yet in <strong>${s.notCounted.map(esc).join(", ")}</strong>, so ${s.notCounted.length === 1 ? "it shows" : "they show"} as $0.00 and the totals read low.</div></div>` : ""}
      <div class="table-wrap"><table class="list sum">
        <thead><tr><th>Group</th><th class="num">${esc(monthLabel(month))}</th><th class="num">${esc(monthLabel(prev))}</th><th class="num">Change</th></tr></thead>
        <tbody>${body || `<tr><td colspan="4" class="muted">No ingredients are on the count list.</td></tr>`}
          <tr class="sum-total"><td>Total</td>${cells(s.total)}</tr></tbody>
      </table></div>

      ${Store.part18Old() ? "" : `<section class="card card--flat sum-bought">
        <div class="bar"><h2>Bought in ${esc(monthLabel(month))}</h2><a class="btn btn--small" href="#/spending/${month}">See the invoices</a></div>
        ${bought.invoices ? `<div class="sum-fc__rows">${bought.groups.map((g) => `<div><span>${esc(g.label)}${g.tier === "other" ? ` <span class="muted small">not food cost</span>` : ""}</span><span>${money(g.total)}</span></div>`).join("")}
          ${bought.notSorted ? `<div><span class="warn">Not sorted yet</span><span>${money(bought.notSorted)}</span></div>` : ""}
          <div class="sum-fc__line"><strong>Total before taxes (${bought.invoices} invoice${bought.invoices === 1 ? "" : "s"})</strong><strong>${money(bought.total)}</strong></div></div>`
        : `<p class="hint">Nothing saved yet. Saving an invoice adds it here by itself.</p>`}
      </section>`}

      ${food ? `<section class="card card--flat sum-fc">
        <h2>Food cost for ${esc(monthLabel(month))}</h2>
        <p class="hint">${Store.part18Old() ? "Type the month's food purchases and food sales, before taxes." : "Food on your invoices adds up by itself. Type the month's food sales, and anything food bought without an invoice, before taxes."} Either can stay blank: it just means no percentage yet.${open != null && !prevClosed ? ` ${esc(monthLabel(prev))} isn't closed yet, so its stock still follows today's prices.` : ""}</p>
        <div class="sum-fc__rows">
          <div><span>Food stock at the end of ${esc(monthLabel(prev))}</span><span>${showStock(open, prev)}</span></div>
          ${Store.part18Old() ? "" : `<div><span>+ Food on invoices in ${esc(monthLabel(month))}</span><span>${money(bought.food)}</span></div>`}
          <label><span>${Store.part18Old() ? `+ Food bought in ${esc(monthLabel(month))}` : "+ Also bought, no invoice"}</span>${box("purchases", "Food bought in " + monthLabel(month))}</label>
          <div><span>− Food stock at the end of ${esc(monthLabel(month))}</span><span>${showStock(shut, month)}</span></div>
          <div class="sum-fc__line"><span>= Food used</span><strong>${fc.used == null ? "—" : money(fc.used)}</strong></div>
          <label><span>Food sales in ${esc(monthLabel(month))}</span>${box("sales", "Food sales in " + monthLabel(month))}</label>
          <div class="sum-fc__line big"><span>Food cost</span><strong>${fc.pct == null ? "—" : pct(fc.pct)}</strong></div>
        </div>
        ${lateCount ? `<p class="hint">Includes ${lateCount} invoice${lateCount === 1 ? "" : "s"} saved after this month closed. The stock numbers don't change.</p>` : ""}
        ${fc.used != null && fc.used < 0 ? `<p class="note note--bad">Food used is below zero: stock went up by more than was bought. Check the purchases, or a count that looks high.</p>` : ""}
      </section>` : ""}

      ${closed ? "" : `<section class="card card--flat no-print">
        <details class="fold" data-k="sum-groups"${detailsOpen.get("sum-groups") ? " open" : ""}>
          <summary><h2>Which section goes where</h2><span class="small muted">food cost or not</span></summary>
          <p class="hint">Move a section and the summary follows. An item that doesn't fit its section can go in a section of its own, and new sections are made on the item or in Settings → Categories.</p>
          <div class="sum-groups">${names.map((c) => `<label><span>${esc(c)}</span><select class="in" data-k="sum-g-${esc(c)}" data-act="sum-group" data-name="${esc(c)}" aria-label="Summary group of ${esc(c)}">${Summary.TIERS.map((t) => `<optgroup label="${esc(t.label)}">${Summary.GROUPS.filter((g) => g.tier === t.key).map((g) => `<option value="${esc(g.key)}"${Summary.groupOf(c, saved) === g.key ? " selected" : ""}>${esc(g.label)}</option>`).join("")}</optgroup>`).join("")}</select></label>`).join("")}</div>
        </details>
      </section>`}`;
  }

  /** The month's tab, in the same layout as the existing sheet: item rows, then section totals vs last month. */
  // The month's tab: the rows, and how its rows take on the look of last month's tab (prevA: that tab's column A).
  function inventorySheet(month, prevTab, prevA = []) {
    const rows = inventorySheetRows(month, prevTab, prevA);
    const head = rows.findIndex((r, k) => k > 1 && r[0] === "Category"), lastItem = head - 2, grand = rows.length - 1;
    // Last month's: an item row, its totals heading and Grand Total, and an empty row after them.
    const oldHead = prevA.indexOf("Category", 2), oldGrand = prevA.indexOf("Grand Total", oldHead + 1);
    if (prevA[1] !== "Category" || !prevA[2] || oldHead < 0 || oldGrand < 0) return { rows, looks: [] };
    return { rows, looks: [
      // Everything after the items starts out blank (last month's totals may have been lower down)…
      { from: oldGrand + 1, to: [lastItem + 1, Math.max(oldGrand, grand) + 1] },
      // …the items all look like a plain item row (a highlight on one item last month would land on another)…
      { from: 2, to: [2, lastItem + 1] },
      // …and the totals like last month's.
      { from: oldHead, to: [head, head + 1] },
      { from: oldHead + 1, to: [head + 1, grand] },
      { from: oldGrand, to: [grand, grand + 1] },
    ] };
  }
  // A row's Supplier, Cost, Volume, Unit and Yield on the sheet. A closed month's are in its record.
  function sheetCells(r) {
    if (r.sheet) return r.sheet;
    const it = r.item;
    // A prep: cost of one batch for what one batch makes.
    if (r.kind === "prep") return ["Made in-house", +r.batch.toFixed(2), r.one ? +((+it.recipe.yield_qty || 1) / r.one).toFixed(4) : +(+it.recipe.yield_qty || 1), unitLabel(r.one ? r.unit : it.base), 1];
    const i = it.ing, o = r.offer;
    const vol = o ? coster.packAmount(parseNum(o.pack_qty), o.pack_unit || i.base, i) : null;
    return [o ? o.supplier || "" : "", o && parseNum(o.pack_cost) != null ? +o.pack_cost : "", vol != null ? +(r.one ? vol / r.one : vol).toFixed(4) : "", r.one ? r.unit : i.base, i.yield == null ? 1 : +i.yield];
  }
  function inventorySheetRows(month, prevTab, prevA = []) {
    // Older tabs spell some sections differently.
    const ALIASES = { "Vegé": ["Veges"] };
    if (prepSection() !== "Preppeds") ALIASES[prepSection()] = ["Preppeds"];
    // Sections in last month's order, for the items and for the totals.
    const oldHead = prevA.indexOf("Category", 2), oldEnd = oldHead < 0 ? -1 : prevA.indexOf("Grand Total", oldHead + 1);
    const itemOrder = oldHead < 0 ? [] : [...new Set(prevA.slice(2, oldHead).filter(Boolean))];
    const totalOrder = oldEnd < 0 ? [] : prevA.slice(oldHead + 1, oldEnd);
    let list = inventoryRows(month);
    if (closedMonth(month)) {
      const keys = new Set(list.map((r) => r.item.key));
      list = [...list, ...liveRows(month).filter((r) => !keys.has(r.item.key)).map((r) => ({ ...r, qty: null, value: 0 }))]
        .sort((a, b) => bySection(section(a.item), section(b.item)) || byName(a.item, b.item));
    }
    const rows = inSheetOrder(list, (r) => section(r.item), itemOrder, ALIASES);
    const out = [[], ["Category", "Item", "Supplier", "Cost", "Volume", "Unit", "Yield", "Price /unit", "Stock", "Total Cost"]];
    rows.forEach((r, k) => {
      const n = k + 3, it = r.item, price = `=IFERROR(ROUND(D${n}/(E${n}*G${n}), 2), "")`, stock = r.qty == null ? "" : r.qty, total = `=IFERROR(H${n}*I${n}, 0)`;
      out.push([section(it), it.name, ...sheetCells(r), price, stock, total]);
    });
    const last = rows.length + 2;
    out.push([], ["Category", "Total Cost", "Prev. Month Total", "Difference"]);
    const first = out.length + 1;
    const prev = prevTab ? `'${prevTab.replace(/'/g, "''")}'` : null;
    inSheetOrder([...new Set(rows.map((r) => section(r.item)))], (s) => s, totalOrder, ALIASES).forEach((s, k) => {
      const n = first + k;
      const prevF = prev ? "=" + [s, ...(ALIASES[s] || [])].map((name, j) => `SUMIF(${prev}!$A:$A, ${j ? `"${name}"` : `A${n}`}, ${prev}!$J:$J)`).join("+") : "";
      out.push([s, `=SUMIF($A$3:$A$${last}, A${n}, $J$3:$J$${last})`, prevF, prev ? `=B${n}-C${n}` : ""]);
    });
    const end = out.length;
    out.push(["Grand Total", `=SUM(B${first}:B${end})`, prev ? `=SUM(C${first}:C${end})` : "", prev ? `=SUM(D${first}:D${end})` : ""]);
    return out;
  }

  /* ---------- invoices ---------- */
  // Invoices being reviewed are kept on this device until saved, so a closed tab doesn't lose the work.
  let INV_KEY = "costing.invoiceWork"; // each set of records has its own (see applyProject)
  let invoiceWork = readJSON(INV_KEY, []);
  const keepInvoices = () => writeJSON(INV_KEY, invoiceWork);
  const PACK_UNITS = ["kg", "g", "lb", "oz", "L", "ml", "unit", "dozen", "portion", "recipe", "bunch"];
  const alreadyImported = (file) => data.price_history.some((h) => h.source === "Invoice " + file.replace(/\.pdf$/i, ""));

  // Invoice wording: "6 units × $1.50 each", and whether one price pays for the whole case or one piece.
  const COUNTED = ["unit", "dozen", "portion", "recipe", "bunch"];
  const manyOf = (w, q) => (q === 1 || /^(lb|kg|g|oz|L|ml|dozen)$/.test(w) ? w : w === "box" ? "boxes" : w === "bunch" ? "bunches" : w + "s");
  function boughtText(l) {
    const b = Invoices.billedAs(l), q = +l.qty;
    if (b.weighed) return `Bought ${numText(q)} ${b.word} at ${money(l.price)} per ${b.word}` + (l.total != null ? ` = ${money(l.total)}` : "");
    return q === 1 ? `Bought 1 ${b.word} at ${money(l.price)}` : `Bought ${numText(q)} ${manyOf(b.word, q)} × ${money(l.price)} each` + (l.total != null ? ` = ${money(l.total)}` : "");
  }
  function priceIsFor(l) {
    const b = Invoices.billedAs(l);
    if (b.weighed) return `<div class="muted small inv-for">Priced by weight: ${money(l.price)} per ${b.word}.</div>`;
    const q = parseNum(l.packQty), u = l.packUnit;
    if (!q || !u) return `<div class="problem inv-for">Type what ${money(l.price)} pays for.</div>`;
    if (!b.pack && b.word === "unit" && q === 1 && COUNTED.includes(u)) return `<div class="muted small inv-for">${money(l.price)} is for <strong>one ${unitLabel(u)}</strong>.</div>`;
    const whole = b.pack ? `the whole ${b.word}` : b.word === "unit" ? (COUNTED.includes(u) ? "the whole pack" : "one unit") : `one ${b.word}`;
    const each = q !== 1 ? ` (${money(l.price / q, true)}${per(u)})` : "";
    const check = b.pack && q === 1 && COUNTED.includes(u) ? `<div class="problem inv-for">Billed per ${b.word}: if a ${b.word} holds several, type how many.</div>` : "";
    return `<div class="muted small inv-for">${money(l.price)} is for <strong>${whole}</strong>: ${numText(q)} ${manyOf(unitLabel(u), q)}${each}.</div>${check}`;
  }

  // Whether a pack goes into how the item is priced (kg ↔ lb always; kg ↔ unit only with "1 unit weighs").
  const packFits = (qty, unit, i) => parseNum(qty) > 0 && coster.packAmount(parseNum(qty), unit, i) != null;
  // The item's usual pack: this supplier's price, else the ticked one, else any that fits.
  function usualPack(i, supplier) {
    const offs = data.offers.filter((o) => o.ingredient_id === i.id && packFits(o.pack_qty, o.pack_unit, i));
    const ticked = offs.find((o) => o.id === i.preferred_offer_id);
    const o = offs.find((x) => x.supplier === supplier) || ticked || offs[0];
    return o ? { qty: +o.pack_qty, unit: o.pack_unit } : null;
  }
  // What to do when the pack can't be turned into the item's unit: say why, and offer its usual pack.
  function packHelp(inv, n, k, l, i) {
    const fix = usualPack(i, inv.supplier);
    return `<div class="problem inv-for">${esc(numText(l.packQty))} ${esc(manyOf(unitLabel(l.packUnit), parseNum(l.packQty)))} can't be turned into ${esc(manyOf(unitLabel(i.base), 2))} for ${esc(i.name)}.
      ${fix ? `<button class="btn btn--small" data-act="inv-usepack" data-inv="${n}" data-line="${k}" data-qty="${esc(numText(fix.qty))}" data-unit="${esc(fix.unit)}">Use ${esc(numText(fix.qty))} ${esc(manyOf(unitLabel(fix.unit), fix.qty))}</button> (how it's usually bought), or` : ""}
      type the pack in ${esc(manyOf(unitLabel(i.base), 2))}, or fill in "1 ${esc(unitLabel(i.base === "kg" ? "unit" : i.base))} weighs" on <a href="#/ingredient/${encodeURIComponent(i.id)}">its page</a>.</div>`;
  }

  /** One reviewed line: what it is in the app, the new price per kg/L/unit, and how that compares. */
  function invoiceLineView(inv, l) {
    const i = l.ingId && get("ingredients", l.ingId);
    const inBase = i && l.packQty ? coster.packAmount(+l.packQty, l.packUnit, i) : null;
    const price = inBase ? l.price / (inBase * (parseNum(i.yield) || 1)) : null;
    const cur = i ? coster.defaultOffer(i.id) : null;
    const diff = price != null && cur ? price - cur.price : null;
    return { i, price, cur, diff, ready: !!(i && price != null) };
  }

  function invoicesPage() {
    const cards = invoiceWork.map((inv, n) => {
      const views = inv.lines.map((l) => invoiceLineView(inv, l));
      const ready = inv.lines.filter((l, k) => l.include && views[k].ready).length;
      const rows = inv.lines.map((l, k) => {
        const v = views[k], i = v.i;
        const chip = v.diff == null ? "" : Math.abs(v.diff) < 0.01 ? `<span class="muted">same</span>`
          : `<span class="chip ${v.diff > 0 ? "chip--up" : "chip--down"}">${v.diff > 0 ? "▲" : "▼"} ${money(Math.abs(v.diff), true)}</span>`;
        const how = { remembered: "remembered", price: "same price", name: "by name", new: "new item" }[l.how] || "";
        const counts = Store.part18Old() ? "" : `<label class="inv-counts">Counts as ${groupPicker(lineGroup(inv, l), `data-k="invg-${n}-${k}" data-act="inv-group" data-inv="${n}" data-line="${k}" aria-label="What ${esc(l.item)} counts as"`)}</label>`;
        return `<tr class="${!l.include ? "row--off" : !v.ready ? "has-problem" : ""}">
          <td><input type="checkbox" data-act="inv-include" data-inv="${n}" data-line="${k}" ${l.include ? "checked" : ""} aria-label="Use this line" /></td>
          <td>${esc(l.item)}${l.format ? ` <span class="muted">${esc(l.format)}</span>` : ""}<div class="muted small">${esc(boughtText(l))}</div></td>
          <td><input class="in" list="dl-ingredients" data-k="inv-${n}-${k}" data-act="inv-item" data-inv="${n}" data-line="${k}" value="${esc(i ? i.name : "")}" placeholder="Pick your item" />
            ${how ? `<div class="muted small">${how}</div>` : !i ? `<div class="problem">New: pick your item once, it's remembered</div>
              <button class="btn btn--small inv-new" data-act="inv-new-item" data-inv="${n}" data-line="${k}">+ New item</button>` : ""}${counts}</td>
          <td class="nowrap"><input class="in in--num" inputmode="decimal" data-k="invq-${n}-${k}" data-act="inv-pack" data-field="packQty" data-inv="${n}" data-line="${k}" value="${esc(numText(l.packQty))}" aria-label="How much one price is for" />
            <select class="in" data-k="invu-${n}-${k}" data-act="inv-pack" data-field="packUnit" data-inv="${n}" data-line="${k}" aria-label="Unit">${PACK_UNITS.map((u) => `<option value="${u}"${l.packUnit === u ? " selected" : ""}>${unitLabel(u)}</option>`).join("")}</select>
            ${priceIsFor(l)}${i && v.price == null ? packHelp(inv, n, k, l, i) : ""}</td>
          <td class="num">${v.price == null ? (i ? `<span class="warn">pack doesn't fit</span>` : "") : money(v.price, true) + per(i.base)}</td>
          <td class="num muted">${v.cur ? money(v.cur.price, true) : "—"}</td>
          <td>${chip}</td>
        </tr>`;
      }).join("");
      return `<section class="card card--wide">
        <div class="bar"><h2>${esc(inv.supplier)} · ${esc(inv.date || "no date")}</h2>
          <div class="actions" style="margin:0"><span class="muted small">${esc(inv.file)}</span>${!canSendInvoices() ? "" : inv.sentToUs ? `<span class="chip chip--down">Sent, thank you</span>`
            : invoiceFiles.has(inv.file) ? `<button class="btn btn--small" data-act="inv-report" data-inv="${n}" title="Something read wrong? We'll fix it">Send it to us</button>` : ""}<button class="btn btn--small" data-act="inv-remove" data-inv="${n}">Remove</button></div></div>
        ${inv.already ? `<p class="note note--bad">This invoice was already imported. Saving it again adds the same prices to the history again.</p>` : ""}
        ${(() => { const same = recordedInvoice(inv); return same && !Store.part18Old() ? `<p class="note note--bad">Its spending is already recorded (${esc(same.supplier)}, ${esc(String(same.date).slice(0, 10))}, ${money(+same.total)}). Saving again replaces that record, so it isn't counted twice.</p>` : ""; })()}
        ${inv.missed ? `<p class="note note--bad">The lines below add up to ${money(Math.abs(inv.missed), true)} ${inv.missed > 0 ? "less" : "more"} than the subtotal printed on the invoice: a line may not have been read. Check the PDF.</p>` : ""}
        <div class="table-wrap"><table class="lines lines--inv">
          <thead><tr><th><span class="vh">Actions</span></th><th>On the invoice</th><th>Your item</th><th>One price is for</th><th class="num">New price</th><th class="num">Now</th><th><span class="vh">Actions</span></th></tr></thead>
          <tbody>${rows}</tbody></table></div>
        ${Store.part18Old() ? "" : (() => { const rec = recordOf(inv), by = spendWords(rec.lines); return `<p class="inv-spend"><strong>${money(rec.total)}</strong> before taxes${by ? `: ${esc(by)}` : ""}. Counts in ${esc(monthLabel(String(inv.date || today()).slice(0, 7)))}.</p>`; })()}
        <div class="actions"><button class="btn btn--main" data-act="inv-save" data-inv="${n}" ${ready || !Store.part18Old() ? "" : "disabled"}>${Store.part18Old() ? `Save ${ready} price${ready === 1 ? "" : "s"}` : ready ? `Save ${ready} price${ready === 1 ? "" : "s"} and the spending` : "Save the spending"}</button>
          ${ready && !Store.part18Old() ? `<button class="btn" data-act="inv-save-spend" data-inv="${n}" title="For an old invoice: nothing about your prices changes">Spending only</button>` : ""}
          <span class="hint">Unticked and unmatched lines don't change a price${Store.part18Old() ? "" : ", but every line counts toward the spending"}. The newest price becomes the one recipes use.</span></div>
      </section>`;
    }).join("");
    return `
      <div class="bar"><h1>Invoices</h1>
        <div class="actions" style="margin:0">
          ${invoiceWork.length > 1 && !Store.part18Old() ? `<button class="btn" data-act="inv-save-all" title="For old invoices: nothing about your prices changes">Save the spending for all ${invoiceWork.length}</button>` : ""}
          <a class="btn" href="#/spending">Spending by month</a>
        </div></div>
      ${Store.part18Old() ? `<p class="note note--bad">Run part 18 of supabase/schema.sql in Supabase (SQL Editor) to record what each invoice cost.</p>` : ""}
      <label class="drop" data-drop>
        <input class="drop__input" type="file" accept="application/pdf,.pdf" multiple data-act="inv-files" />
        <span class="drop__icon" aria-hidden="true">↑</span>
        <strong class="off-phone">Drop invoice PDFs here</strong>
        <span class="off-phone">or click to choose them on this computer</span>
        <strong class="on-phone">Add invoice PDFs</strong>
        <span class="on-phone">Tap to pick them from your phone or Files</span>
      </label>
      ${GDrive.configured() ? `<div class="drop-or"><span>or</span><button class="btn" data-act="inv-drive">Choose from Google Drive</button></div>` : ""}
      <ol class="steps">
        <li><span><strong>Add</strong> the PDFs. They're read right here in your browser.</span></li>
        <li><span><strong>Check</strong> each line. Anything new: pick your item once and it's remembered next time.</span></li>
        <li><span><strong>Save.</strong> The newest price becomes the one recipes use.</span></li>
      </ol>
      <p class="hint">Readers for: ${Invoices.SUPPLIERS.join(", ")}, plus any supplier that sends QuickBooks invoices or takes orders through Pepper.${SITE.commis ? " Another supplier? Add its invoice anyway: if it can't be read, you can send it to us." : ""}</p>
      ${canSendInvoices() ? `<p class="hint">Something read wrong? <button class="linkish" data-act="inv-pick-send">Send us the invoice</button> and we'll fix it for everyone. We delete our copy once it's fixed.</p>` : ""}
      ${unreadCard()}
      ${cards || `<p class="empty">No invoices waiting. Add one above.</p>`}`;
  }

  // Commis: invoices it couldn't read this visit, to send in (the files stay on this device until sent).
  const unreadInvoices = [];
  // Commis: any invoice can be sent in, to fix how it reads. The PDFs stay in memory for this visit only.
  const invoiceFiles = new Map();
  const canSendInvoices = () => SITE.commis && store.kind === "supabase";
  /** Asks what looks wrong (optional), then sends the PDF. Resolves true once it's sent. */
  async function sendToUs(file) {
    const note = await ask(`Send “${file.name}” to us? We only use it to fix how ${SITE.app} reads this kind of invoice, then we delete our copy.\n\nWhat looks wrong? (optional)`,
      { ok: "Send it", input: true, optional: true, placeholder: "e.g. the egg price is wrong" });
    if (note == null) return false;
    toast(`Sending ${file.name}…`);
    await store.sendInvoice(file, note);
    toast(`Sent ${file.name}. Thank you: we'll take a look.`);
    return true;
  }
  function unreadCard() {
    if (!unreadInvoices.length) return "";
    const signedIn = store.kind === "supabase";
    return `<section class="card unread">
      <h2>Couldn't read ${unreadInvoices.length === 1 ? "this invoice" : "these invoices"}</h2>
      <p>Send ${unreadInvoices.length === 1 ? "it" : "them"} to us and we'll teach ${esc(SITE.app)} that supplier's invoices. Once it's done,
        every restaurant using ${esc(SITE.app)} can read them, you too. Only we see what you send (prices included), only to build the reader, and we delete our copy once it's built.</p>
      <ul class="unread__list">${unreadInvoices.map((u, n) => `<li>
        <span><strong>${esc(u.file.name)}</strong> <span class="muted small">${esc(u.why)}</span></span>
        ${u.sent ? `<span class="chip chip--down">Sent, thank you</span>`
          : `<span class="unread__do">${signedIn ? `<button class="btn btn--small btn--main" data-act="inv-send" data-n="${n}">Send it</button>` : `<span class="muted small">Sign in to send it</span>`}
            <button class="btn btn--small" data-act="inv-unread-drop" data-n="${n}">Not now</button></span>`}
      </li>`).join("")}</ul>
    </section>`;
  }

  /** Saves the ticked, matched lines of one invoice: price, pack, date, name on invoice, history; ticks the newest. */
  async function saveInvoice(inv) {
    let n = 0;
    for (const l of inv.lines) {
      const v = invoiceLineView(inv, l);
      if (!l.include || !v.ready) continue;
      const i = v.i, key = Invoices.lineKey(l);
      const mine = data.offers.filter((o) => o.ingredient_id === i.id);
      let o = Invoices.offerFor(l, inv.supplier, mine, i.preferred_offer_id);
      const fields = { supplier: inv.supplier, supplier_item: key, pack_cost: l.price, pack_qty: +l.packQty, pack_unit: l.packUnit, updated_at: inv.date || today() };
      if (o) await patch("offers", o.id, fields);
      else o = await insert("offers", { id: uid(), ingredient_id: i.id, ...fields });
      await sizeBottle(i.id, fields.pack_qty, fields.pack_unit);
      await insert("price_history", { id: uid(), offer_id: o.id, ingredient_id: i.id, supplier: inv.supplier, pack_cost: l.price, pack_qty: +l.packQty,
        pack_unit: l.packUnit, date: inv.date || today(), source: "Invoice " + inv.file.replace(/\.pdf$/i, "") });
      // The newest price wins. Only an invoice or a price you typed has a real date; imported prices
      // (Master Data, the Hector copy, the inventory sheet) always give way to an invoice.
      const ticked = mine.find((x) => x.id === i.preferred_offer_id);
      const realDate = (x) => data.price_history.filter((h) => h.offer_id === x.id && /^(Invoice|Typed in)/.test(h.source || "")).map((h) => h.date).sort().pop() || null;
      // A different pack from the same supplier (singles vs your ticked case) gets its price updated, not ticked.
      const otherPack = ticked && ticked.id !== o.id && ticked.supplier === inv.supplier && ticked.supplier_item && ticked.supplier_item !== key;
      if (!otherPack && (!ticked || ticked.id === o.id || !realDate(ticked) || (inv.date || today()) >= realDate(ticked))) await patch("ingredients", i.id, { preferred_offer_id: o.id });
      n++;
    }
    return n;
  }

  /* ---------- what was spent ---------- */
  // Each saved invoice keeps its lines and the group each one counted toward (saved_invoices, part 18). A product's group, once
  // you pick one, is remembered with your account (settings.invoiceGroups = { "supplier|name on invoice": group }).
  const productKey = (supplier, l) => (supplier || "") + "|" + Invoices.lineKey(l);
  const allItemsForGuess = () => data.ingredients.map((i) => ({ name: i.name, section: section(i) }));
  /** What a line counts as: picked on this line, remembered for this product, its item's section, else the best guess. */
  function lineGroup(inv, l) {
    if (l.group) return l.group;
    const saved = (settings.categories || {}).groups || {};
    const remembered = (settings.invoiceGroups || {})[productKey(inv.supplier, l)];
    if (remembered) return remembered;
    const i = l.ingId && get("ingredients", l.ingId);
    if (i) return Summary.groupOf(section(i), saved);
    if (!lineGuess) lineGuess = Summary.lineGuesser(allItemsForGuess(), saved);
    return lineGuess(Invoices.lineKey(l));
  }
  const recordOf = (inv) => Summary.invoiceRecord(inv.lines, (l) => lineGroup(inv, l), inv.missed || 0);
  const groupLabel = (key) => (Summary.GROUPS.concat(Summary.SPEND_EXTRA).find((g) => g.key === key) || { label: key }).label;
  function spendWords(lines) {
    const by = new Map();
    for (const l of lines) if (l.group !== Summary.LEFT_OUT) by.set(l.group, (by.get(l.group) || 0) + l.total);
    return [...by].map(([g, t]) => `${groupLabel(g)} ${money(t)}`).join(" · ");
  }
  /** The list of what a line can count as. */
  function groupPicker(value, attrs) {
    const option = (g) => `<option value="${esc(g.key)}"${g.key === value ? " selected" : ""}>${esc(g.label)}</option>`;
    return `<select class="in in--group" ${attrs}>${Summary.TIERS.map((t) => `<optgroup label="${esc(t.label)}">${Summary.GROUPS.filter((g) => g.tier === t.key).map(option).join("")}</optgroup>`).join("")}
      <optgroup label="Other">${Summary.SPEND_EXTRA.map(option).join("")}</optgroup></select>`;
  }
  /** This invoice, if it's already recorded: the same file from the same supplier, or the same supplier, date and total. */
  function recordedInvoice(inv) {
    const date = inv.date || today(), rec = recordOf(inv);
    return (data.saved_invoices || []).find((x) => x.supplier === inv.supplier && ((x.file && x.file === inv.file) || (String(x.date).slice(0, 10) === date && Summary.sameLines(x.lines || [], rec.lines)))) || null;
  }
  async function saveSpending(inv) {
    if (Store.part18Old()) return null;
    const rec = recordOf(inv), same = recordedInvoice(inv), fields = { supplier: inv.supplier, date: inv.date || today(), file: inv.file, total: rec.total, lines: rec.lines, saved_at: new Date().toISOString() };
    if (same) await patch("saved_invoices", same.id, fields);
    else await insert("saved_invoices", { id: uid(), ...fields });
    return rec.total;
  }

  // Saved after its month closed. (A month from your old sheet was never closed in the app: nothing counts as late for it.)
  const savedAfterClosing = (x, closed) => !!(closed && !closed.source && x.saved_at && Date.parse(x.saved_at) > Date.parse(closed.closed_at));
  const spendOpen = new Set(); // the invoices showing their lines (this visit only)
  function spendingPage(monthParam) {
    const month = /^\d{4}-\d{2}$/.test(monthParam || "") ? monthParam : thisMonth(), prev = shiftMonth(month, -1), label = monthLabel(month);
    const all = data.saved_invoices || [], s = Summary.spent(all, month), closed = closedMonth(month);
    const list = all.filter((x) => String(x.date).slice(0, 7) === month).sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.supplier.localeCompare(b.supplier, "fr"));
    const late = (x) => savedAfterClosing(x, closed);
    const rows = list.map((x) => {
      const open = spendOpen.has(x.id);
      return `<tr><td class="nowrap">${esc(String(x.date).slice(0, 10))}</td>
        <td><button class="sum-toggle" type="button" data-act="spend-toggle" data-id="${esc(x.id)}" aria-expanded="${open}">${esc(x.supplier || "Purchase")}</button>
          ${x.file ? `<div class="muted small">${esc(x.file)}</div>` : `<div class="muted small">typed by hand</div>`}${late(x) ? `<span class="tag">saved after closing</span>` : ""}</td>
        <td class="muted small">${esc(spendWords(x.lines || []))}</td>
        <td class="num">${money(+x.total)}</td>
        <td class="row-actions"><button class="icon icon--x" data-act="spend-delete" data-id="${esc(x.id)}" aria-label="Remove ${esc(x.supplier)} from the spending">×</button></td></tr>`
        + (open ? (x.lines || []).map((l, k) => `<tr class="sum-section"><td></td><td>${esc(l.item)}</td><td>${groupPicker(l.group, `data-k="sg-${esc(x.id)}-${k}" data-act="spend-line-group" data-id="${esc(x.id)}" data-line="${k}" aria-label="What ${esc(l.item)} counts as"`)}</td><td class="num">${money(l.total)}</td><td></td></tr>`).join("") : "");
    }).join("");
    const body = s.tiers.map((t) => `<tr class="section-row"><th colspan="2" scope="colgroup">${esc(t.label)}</th></tr>` + t.groups.map((g) => `<tr><td>${esc(g.label)}</td><td class="num">${money(g.total)}</td></tr>`).join("")).join("")
      + (s.notSorted ? `<tr class="section-row"><th colspan="2" scope="colgroup">Not sorted</th></tr><tr><td><span class="warn">Not sorted yet</span></td><td class="num">${money(s.notSorted)}</td></tr>` : "");
    return `
      <p class="crumbs"><a href="#/summary/${month}">← Inventory summary</a> <a href="#/invoices">Invoices</a></p>
      <div class="bar">
        <h1>Spending: ${esc(label)}</h1>
        <div class="actions" style="margin:0">
          <a class="btn" href="#/spending/${prev}">← ${esc(monthLabel(prev))}</a>
          ${month < thisMonth() ? `<a class="btn" href="#/spending/${shiftMonth(month, 1)}">${esc(monthLabel(shiftMonth(month, 1)))} →</a>` : ""}
        </div>
      </div>
      ${Store.part18Old() ? `<p class="note note--bad">Run part 18 of supabase/schema.sql in Supabase (SQL Editor) to record what each invoice cost.</p>` : ""}
      <p class="hint">Everything saved with a date in ${esc(label)}, before taxes. Tap one to see its lines and change what a line counts as: that product is remembered from then on.</p>
      ${list.length ? `<div class="table-wrap"><table class="list sum sum--spend"><thead><tr><th>Group</th><th class="num">Spent</th></tr></thead><tbody>${body}
        <tr class="sum-total"><td>Total (${s.invoices} invoice${s.invoices === 1 ? "" : "s"})</td><td class="num">${money(s.total)}</td></tr></tbody></table></div>
      <h2>Invoices</h2>
      <div class="table-wrap"><table class="list spend-list"><thead><tr><th>Date</th><th>Supplier</th><th>Counts as</th><th class="num">Amount</th><th><span class="vh">Actions</span></th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<p class="empty">Nothing saved for ${esc(label)} yet. Save an invoice on the <a href="#/invoices">Invoices</a> page, or add a purchase below.</p>`}
      ${Store.part18Old() ? "" : `<section class="card card--flat">
        <h2>Add a purchase by hand</h2>
        <p class="hint">A cash purchase, or an invoice the app can't read. One group at a time, before taxes.</p>
        <form class="spend-add" data-form="spend-add">
          <label class="block">Supplier<input class="in" name="supplier" list="dl-suppliers" placeholder="Market, Costco…" /></label>
          <label class="block">Date<input class="in" type="date" name="date" value="${esc(month === thisMonth() ? today() : month + "-01")}" required /></label>
          <label class="block">Amount<input class="in" name="amount" inputmode="decimal" placeholder="0.00" required /></label>
          <label class="block">Counts as${groupPicker("food", 'name="group"')}</label>
          <button class="btn btn--main">Add it</button>
        </form>
      </section>`}`;
  }

  /* ---------- recipes from Sundae Atelier (the ice cream calculator) ---------- */
  // "Send to Kitchen Costing" there opens #/import/<code>. The recipe waits on this device until it's saved (so signing
  // in first doesn't lose it); each calculator ingredient's item and the prep it became are remembered with your
  // account (settings.sundae = { items: { "35% cream": { kind, id } }, preps: { "<saved recipe id>": "<prep id>" } }).
  const SUNDAE_KEY = "costing.sundae";
  let sundae = readJSON(SUNDAE_KEY, null); // { recipe, picks: { name: { kind, id } }, name, count, asNew }
  const keepSundae = () => { if (sundae) writeJSON(SUNDAE_KEY, sundae); else try { localStorage.removeItem(SUNDAE_KEY); } catch { /* blocked */ } };
  function takeSundaeLink() {
    if (SITE.commis) return;
    const m =/^#\/import\/([^/?#]+)/.exec(location.hash);
    if (!m) return;
    try { sundae = { recipe: Sundae.decode(m[1]), picks: {}, name: null, count: null, asNew: false }; keepSundae(); }
    catch (e) { toast(e.message, true); }
    // The long link isn't kept in the address bar (or the history).
    history.replaceState(null, "", "#/import");
  }
  const sundaeItem = (p) => (p ? (p.kind === "prep" ? get("recipes", p.id) : get("ingredients", p.id)) || null : null);
  /** The prep this saved recipe became last time, unless it's been deleted since. */
  function sundaeTarget() {
    const id = sundae.recipe.id && ((settings.sundae || {}).preps || {})[sundae.recipe.id];
    const r = id && get("recipes", id);
    return r && r.kind === "prep" ? r : null;
  }
  /** Everything the import page shows: each calculator line with its item (picked here, remembered, or guessed by
   * name), the line it makes, its cost, and what still stops it from saving. */
  function sundaeView() {
    const s = sundae, rec = s.recipe, memory = (settings.sundae || {}).items || {};
    const target = s.asNew ? null : sundaeTarget();
    const rows = rec.rows.map((row) => {
      let pick = s.picks[row.name], how = "picked";
      if (!sundaeItem(pick)) { pick = memory[row.name]; how = "remembered"; }
      if (!sundaeItem(pick)) { pick = Sundae.match(row.name, data) || Sundae.match(row.label, data); how = "by name"; }
      const item = sundaeItem(pick);
      return item ? { row, item, pick: { kind: pick.kind, id: pick.id }, how, line: Sundae.lineFor(row.grams, row.name, item) } : { row, item: null };
    });
    const id = "sundae-preview", used = rows.filter((x) => x.item);
    const lines = used.map((x, k) => ({ id: id + k, recipe_id: id, pos: k + 1, qty: x.line.qty, unit: x.line.unit,
      ...(x.pick.kind === "prep" ? { sub_recipe_id: x.item.id } : { ingredient_id: x.item.id }) }));
    const cost = Costing.create({ ...data, recipes: data.recipes.concat([{ id, name: rec.name, kind: "prep", yield_qty: rec.batch, yield_unit: "kg" }]),
      lines: data.lines.concat(lines) }).recipeCost(id);
    // A line with no price yet can still be saved (the cost leaves it out); one that can't be turned into the item's unit can't.
    used.forEach((x, k) => { x.cost = cost.lines[k]; x.blocks = !!x.cost.problem && !/^(No price yet|Prep has missing prices)$/.test(x.cost.problem); });
    const name = (s.name != null ? s.name : target ? target.name : rec.name).trim();
    const clash = name && data.recipes.find((r) => r.kind === "prep" && r !== target && r.name.trim().toLowerCase() === name.toLowerCase());
    const stop = !name ? "Give the prep a name."
      : clash ? `Another prep is already called ${clash.name}: change the name.`
        : rows.some((x) => x.row.grams < 0) ? "A line is below zero in the calculator: fix the recipe there and send it again."
          : rows.some((x) => !x.item) ? "Pick your item for every line (or make a new one)."
            : used.some((x) => x.blocks) ? "A line can't be costed yet: see its note."
              : "";
    const unpriced = used.filter((x) => x.cost.problem && !x.blocks).map((x) => x.item.name);
    return { rec, target, rows, cost, name, clash, stop, unpriced, count: s.count != null ? s.count : target ? target.in_inventory === true : true };
  }

  function importPage() {
    const head = `<p class="crumbs"><a href="#/preps">← Preps</a></p><div class="bar"><h1>From Sundae Atelier</h1></div>`;
    if (!sundae) return `${head}<p class="empty">Nothing waiting. In Sundae Atelier, open a recipe from My recipes and press <strong>Send to Kitchen Costing</strong>: it opens here.</p>`;
    if (store.kind === "local" && Auth.configured()) return `${head}
      <section class="card"><h2>Sign in first</h2><p><strong>${esc(sundae.recipe.name)}</strong> is waiting on this device: sign in and it's here.</p>
        <form class="signin" data-form="sign-in"><input class="in" type="email" name="email" placeholder="Email" autocomplete="username" required />
        <input class="in" type="password" name="password" placeholder="Password" autocomplete="current-password" required /><button class="btn btn--main">Sign in</button></form></section>`;
    const v = sundaeView(), rec = v.rec;
    const rows = v.rows.map((x, n) => {
      const { row, item } = x;
      const how = !item ? "" : x.how === "by name" ? `<div class="problem">Guessed from the name: check it</div>` : `<div class="muted small">${x.how}</div>`;
      const link = item ? (x.pick.kind === "prep" ? `#/recipe/${encodeURIComponent(item.id)}` : `#/ingredient/${encodeURIComponent(item.id)}`) : "";
      const note = !item ? `<div class="problem">New: pick your item once, it's remembered</div><button class="btn btn--small" data-act="sun-new-item" data-row="${n}">+ New item</button>`
        : x.cost.problem ? `<div class="problem">${esc(x.cost.problem)}: <a href="${link}">open ${esc(item.name)}</a></div>` : "";
      const inPrep = !item ? "" : `${esc(numText(x.line.qty))} ${esc(x.line.unit)}` + (x.line.density ? `<div class="muted small">${esc(numText(row.grams))} g at ${esc(numText(x.line.density))} g/ml</div>` : "");
      return `<tr class="${row.grams < 0 || !item || x.blocks ? "has-problem" : ""}">
        <td>${esc(row.label)}${row.label !== row.name ? ` <span class="muted small">${esc(row.name)}</span>` : ""}</td>
        <td class="num">${esc(numText(row.grams))} g${row.grams < 0 ? `<div class="problem">below zero</div>` : ""}</td>
        <td><input class="in" list="dl-items" data-k="sun-${n}" data-act="sun-item" data-row="${n}" value="${esc(item ? item.name + (x.pick.kind === "prep" ? " (prep)" : "") : "")}" placeholder="Pick your item" aria-label="Your item for ${esc(row.label)}" />${how}${note}</td>
        <td class="num">${inPrep}</td>
        <td class="num">${item && !x.cost.problem ? money(x.cost.cost, true) : "—"}</td>
      </tr>`;
    }).join("");
    const t = v.target, wasPortions = t && t.yield_unit !== "kg";
    return `${head}
      <p class="hint">${esc(rec.recipe)}${rec.temp ? ` at ${esc(rec.temp)}` : ""}, a ${esc(numText(rec.batch))} kg batch. Check each line once: your picks are remembered for the next recipe.</p>
      ${t ? `<div class="alert alert--check"><div>Sent before: saving updates <a href="#/recipe/${encodeURIComponent(t.id)}"><strong>${esc(t.name)}</strong></a>. Its lines are replaced by these and it makes ${esc(numText(rec.batch))} kg${wasPortions ? ` (it's made in ${esc(plural(t.yield_unit))} now: dishes using it by the ${esc(unitLabel(t.yield_unit))} will need checking)` : ""}.</div></div>` : ""}
      <div class="head">
        <input class="in in--title" data-k="sun-name" data-act="sun-name" value="${esc(v.name)}" aria-label="Prep name" />
        <div class="head__meta">
          <label class="check" title="Counted in the monthly inventory, in kg, at what it costs to make"><input type="checkbox" data-act="sun-count" ${v.count ? "checked" : ""} /> On the monthly count</label>
          ${t || sundae.asNew ? `<label class="check"><input type="checkbox" data-act="sun-asnew" ${sundae.asNew ? "checked" : ""} /> Save as a new prep instead</label>` : ""}
        </div>
      </div>
      <div class="table-wrap"><table class="lines cards">
        <thead><tr><th>In the calculator</th><th class="num">Amount</th><th>Your item</th><th class="num">In the prep</th><th class="num">Cost</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
      <p class="sundae-total"><strong>${money(v.cost.total)}</strong> for the ${esc(numText(rec.batch))} kg batch: <strong>${money(v.cost.perYield, true)}/kg</strong></p>
      ${v.unpriced.length ? `<p class="note note--bad">No price yet for ${esc(v.unpriced.join(", "))}: the cost leaves ${v.unpriced.length === 1 ? "it" : "them"} out until an invoice or a price typed on ${v.unpriced.length === 1 ? "its" : "their"} page fills ${v.unpriced.length === 1 ? "it" : "them"} in.</p>` : ""}
      ${v.stop ? `<p class="problem">${esc(v.stop)}</p>` : ""}
      <div class="actions"><button class="btn btn--main" data-act="sun-save" ${v.stop ? "disabled" : ""}>${t ? "Update the prep" : "Save the prep"}</button>
        <button class="btn" data-act="sun-discard">Discard</button></div>`;
  }

  /* ---------- Master Data export ---------- */
  // Same columns as the Master Data sheet's "Ingredients" tab. One row per ingredient, with the price recipes use;
  // packs are written in kg / L / unit / portion (never lb), so Prix /unité is per kg, L, unit or portion like everywhere in the app.
  const MASTER_HEAD = ["Catégorie", "Article", "Fournisseur", "Coût", "Volume", "Unité", "Rendement", "Prix /unité"];
  /** One ingredient as a Master Data row. Price /unit is worked out like the sheet: cost ÷ (volume × yield), to the cent. */
  function masterItem(i) {
    const def = coster.defaultOffer(i.id), o = def && def.offer;
    const vol = o ? coster.packAmount(parseNum(o.pack_qty), o.pack_unit || i.base, i) : null;
    const cost = o && parseNum(o.pack_cost) != null ? +o.pack_cost : "", volume = vol != null ? +vol.toFixed(4) : "", y = i.yield == null ? 1 : +i.yield;
    return { category: section(i), name: i.name, supplier: o ? o.supplier || "" : "", cost, volume, unit: i.base, yield: y,
      price: cost !== "" && volume ? Math.round((cost / (volume * y)) * 100) / 100 : "" };
  }
  // prevA: the sheet's column A, so its sections keep their order (its "Preppeds" is the prep section, renamed or not).
  function masterRows(withFormula, prevA = []) {
    const aliases = prepSection() !== "Preppeds" ? { [prepSection()]: ["Preppeds"] } : {};
    return inSheetOrder(sortBySection(data.ingredients), section, [...new Set(prevA.slice(2).filter(Boolean))], aliases).map((i, k) => {
      const x = masterItem(i), n = k + 3;
      return [x.category, x.name, x.supplier, x.cost, x.volume, x.unit, x.yield, withFormula ? `=IFERROR(ROUND(D${n}/(E${n}*G${n}), 2), "")` : x.price];
    });
  }
  function saveBlob(name, blob) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function downloadCsv(name, rows) {
    const cell = (v) => { const s = String(v == null ? "" : v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    // The byte-order mark lets Excel read the accents (é, è) correctly.
    saveBlob(name, new Blob(["﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
  }

  /* ---------- costing sheet (your Excel workbook) ---------- */
  /** A dish (or prep) laid out like your costing workbooks: its ingredients with amounts in kg / L / unit / portion,
   * its preps one Recipe tab each (amounts in what the prep makes), and the Ingredients tab rows they look up. */
  function costSheetData(r) {
    const tabs = [], tabOf = new Map(), used = new Map();
    function part(rec) {
      const items = [], preps = [];
      for (const row of coster.recipeCost(rec.id).lines) {
        const l = row.line, qty = parseNum(l.qty);
        if (l.ingredient_id) {
          const ing = get("ingredients", l.ingredient_id);
          if (!ing) continue;
          used.set(ing.id, ing);
          const def = coster.defaultOffer(ing.id);
          // A line that picked another supplier than the usual one: the sheet shows that price and supplier.
          const own = !!(row.offer && def && (row.offer.id !== def.offer.id || row.lineYield));
          items.push({ name: ing.name, qty: qty == null ? null : coster.itemAmount(ing, qty, l.unit || ing.base),
            price: own ? Math.round(row.unitPrice * 10000) / 10000 : null, supplier: own ? row.offer.supplier || "" : "", own });
        } else if (l.sub_recipe_id) {
          const sub = get("recipes", l.sub_recipe_id);
          if (!sub) continue;
          // A locked prep: its tab shows today's recipe, and the row using it takes the locked cost (said in the tab's notes).
          const rc = coster.recipeCost(sub.id);
          if (!tabOf.has(sub.id)) {
            const k = tabs.push(null) - 1;
            tabOf.set(sub.id, k + 1);
            const lockNote = rc.locked ? `Cost locked at ${money(rc.perYield, true)} per ${unitLabel(sub.yield_unit)} since ${sub.locked_at || "?"}; today's prices make it ${money(rc.live.perYield, true)}.` : "";
            tabs[k] = { ...part(sub), name: sub.name, notes: [sub.notes, lockNote].filter(Boolean).join(" "), yieldQty: parseNum(sub.yield_qty) };
          }
          preps.push({ tab: tabOf.get(sub.id), qty: qty == null ? null : coster.subAmount(qty, l.unit || sub.yield_unit, sub), locked: rc.locked ? rc.perYield : null });
        }
      }
      return { items, preps };
    }
    const dish = { ...part(r), name: r.name, notes: r.notes || "", yieldQty: parseNum(r.yield_qty), multiplier: r.kind === "dish" ? parseNum(r.multiplier) || 4 : 4 };
    return { dish, tabs, ingredients: sortBySection([...used.values()]).map(masterItem) };
  }

  /* ---------- price changes ---------- */
  function changesPage() {
    const sums = data.recipes.map((r) => coster.summary(r.id)).filter((s) => s.change !== 0)
      .sort((a, b) => (a.recipe.kind === b.recipe.kind ? Math.abs(b.changePct || 0) - Math.abs(a.changePct || 0) : a.recipe.kind === "dish" ? -1 : 1));
    // Latest two dated prices of each supplier price, to show what moved (starting prices from the sheets carry
    // their import date, so they don't count as a move).
    const byOffer = new Map();
    for (const h of data.price_history) {
      if (STARTING.test(h.source || "")) continue;
      const k = h.offer_id || h.ingredient_id + "|" + (h.supplier || "");
      if (!byOffer.has(k)) byOffer.set(k, []);
      byOffer.get(k).push(h);
    }
    const moves = [];
    for (const list of byOffer.values()) {
      // Day by day: only where each day ended up counts, not the steps of typing it in.
      const days = Costing.lastOfEachDay(list);
      if (days.length < 2) continue;
      const [prev, last] = days.slice(-2);
      const ing = get("ingredients", last.ingredient_id);
      if (!ing) continue;
      const p0 = coster.offerPrice(prev, ing), p1 = coster.offerPrice(last, ing);
      if (p0 && p1 && Math.abs(p1 - p0) > 0.004) moves.push({ ing, last, p0, p1 });
    }
    moves.sort((a, b) => (b.last.date || "").localeCompare(a.last.date || ""));

    const rows = sums.map((s) => {
      const r = s.recipe;
      return `<tr class="${s.change > 0 ? "row--up" : "row--down"}">
        <td><a href="#/recipe/${encodeURIComponent(r.id)}">${esc(r.name)}</a> <span class="tag">${r.kind}</span></td>
        <td class="num">${money(s.ack, true)}</td><td class="num">${money(s.perPortion, true)}</td><td>${changeChip(s)}</td>
        <td class="num">${r.kind === "dish" ? money(s.suggested) : ""}</td><td class="num">${r.kind === "dish" ? money(s.menuPrice) : ""}</td>
        <td class="num">${r.kind === "dish" ? foodCostCell(s) : ""}</td>
        <td><button class="btn btn--small" data-act="ack" data-id="${esc(r.id)}">Got it</button></td></tr>`;
    }).join("");
    return `
      <div class="bar"><h1>Price changes</h1>${sums.length ? `<button class="btn" data-act="ack-all">Mark all as seen</button>` : ""}</div>
      <p class="hint">Dishes and preps whose cost moved since you last pressed "Got it". <span class="chip chip--up">▲ up</span> costs more, <span class="chip chip--down">▼ down</span> costs less.</p>
      ${sums.length ? `<div class="table-wrap"><table class="list cards"><thead><tr><th>Name</th><th class="num">Was</th><th class="num">Now</th><th>Change</th><th class="num">Target</th><th class="num">Menu price</th><th class="num">Food cost</th><th><span class="vh">Actions</span></th></tr></thead><tbody>${rows}</tbody></table></div>`
        : `<p class="empty">Nothing has changed since your last check.</p>`}
      <h2>Latest supplier price moves</h2>
      ${moves.length ? `<div class="table-wrap"><table class="list small cards"><thead><tr><th>Date</th><th>Ingredient</th><th>Supplier</th><th class="num">Was</th><th class="num">Now</th></tr></thead><tbody>
        ${moves.slice(0, 50).map((m) => `<tr><td>${esc(m.last.date)}</td><td><a href="#/ingredient/${encodeURIComponent(m.ing.id)}">${esc(m.ing.name)}</a></td><td>${esc(m.last.supplier || "")}</td><td class="num">${money(m.p0, true)}${per(m.ing.base)}</td><td class="num"><span class="chip ${m.p1 > m.p0 ? "chip--up" : "chip--down"}">${money(m.p1, true)}${per(m.ing.base)}</span></td></tr>`).join("")}
      </tbody></table></div>` : `<p class="muted">No price has changed yet. Edit a pack price on an ingredient and it shows here.</p>`}`;
  }

  /* ---------- settings ---------- */
  function settingsPage() {
    const remote = store.kind === "supabase";
    const counts = Store.TABLES.map((t) => `${data[t].length} ${t.replace("_", " ")}`).join(" · ");
    return `
      <h1>Settings</h1>
      <section class="card">
        <h2>${SITE.commis ? "Your account" : "Where your data is saved"}</h2>
        ${remote && SITE.commis ? `<p>Signed in as <strong>${esc(Auth.email())}</strong>${Auth.restaurant() ? ` for ${esc(Auth.restaurant())}` : ""}. Your data is
            saved online and ${Store.teamsReady() ? "only this account and the people you give access to can see it" : "only this account can see it"}.</p><button class="btn" data-act="sign-out">Sign out</button><p class="small muted">${termsLinks} · ${privacyLinks}</p>`
          : remote ? `<p>Saved in <strong>Supabase</strong>, signed in as ${esc(Auth.email())}.</p><button class="btn" data-act="sign-out">Sign out</button>`
          : Auth.configured() ? `<p>Supabase is set up. Sign in to use your saved data.</p>
            <form class="signin" data-form="sign-in"><input class="in" type="email" name="email" placeholder="Email" autocomplete="username" required />
            <input class="in" type="password" name="password" placeholder="Password" autocomplete="current-password" required /><button class="btn btn--main">Sign in</button></form>`
          : `<p><strong>Local mode:</strong> data is saved in this browser only. Fine for trying it out; connect Supabase (see README) to keep it safe and use it on other devices.</p>`}
        <p class="muted">${counts}</p>
      </section>
      ${myPlaceCard()}
      ${peopleCard()}
      <section class="card">
        <h2>Accessibility</h2>
        <p>Colour-blind friendly colours, low vision (bigger text, stronger contrast), and a dyslexia-friendly font. Saved on this device.</p>
        <button class="btn" type="button" data-access-open>Accessibility options</button>
      </section>
      ${SITE.support ? `<section class="card"><h2>Buy us a soda</h2>${supportBody()}</section>` : ""}
      ${isEmployee() ? "" : categoriesCard()}
      ${ACCOUNT || (SITE.commis && !GDrive.configured()) ? "" : driveCard()}
      ${SITE.commis || BAR || ACCOUNT ? "" : `<section class="card">
        <h2>Import your sheets</h2>
        <p>Load the <code>seed.json</code> made by <code>node scripts/import-sheets.js</code> from your Menu folder. <strong>This replaces everything</strong> in ${remote ? "Supabase" : "this browser"}.</p>
        <input type="file" accept=".json,application/json" data-act="import-file" aria-label="Choose seed.json" />
      </section>
      <section class="card">
        <h2>Import extras</h2>
        <p>Load <code>inventory-import.json</code> (which items are on the monthly count, and last month's stock) or <code>cards-import.json</code>
          (Ready in, Preparation and Notes from your old recipe cards). Made by <code>scripts/import-inventory.js</code> and <code>scripts/import-cards.js</code>.
          Nothing else is changed.</p>
        <input type="file" accept=".json,application/json" data-act="import-extra" aria-label="Choose an inventory or cards file" />
      </section>`}
      ${isEmployee() ? "" : `<section class="card">
        <h2>Backups</h2>
        ${GDrive.configured() ? `<p>Every day you connect Google Drive, a full copy goes to <strong>${BAR ? "Barback" : SITE.app} backups</strong> in your My Drive (the last 30 are kept).
          ${settings.lastBackup ? `Last one: <strong>${esc(settings.lastBackup)}</strong>.` : "None yet."}
          ${SITE.commis ? "" : `To go back to one, download it from Drive and load it under "Import your sheets".`}</p>` : `<p>Download a full copy of your data whenever you like.</p>`}
        <p>
          ${GDrive.configured() ? `<button class="btn" data-act="backup-now">Back up to Drive now</button>` : ""}
          <button class="btn" data-act="export">Download a backup</button>
          ${!remote ? `<button class="btn btn--danger" data-act="clear-local">Clear this browser's data</button>` : ""}
        </p>
        <p class="hint">Also: everything you type is kept on this device until it has saved, so a dropped connection or a closed tab doesn't lose it.</p>
      </section>`}
      ${isEmployee() ? "" : trashCard()}`;
  }

  /* ---------- your own categories ---------- */
  // Dish categories and ingredient sections, in the order you set: that's the order of the groups and buttons on
  // Dishes, Ingredients and Inventory. Ones typed on a dish or ingredient but not put in order yet come after.
  const CAT_KINDS = {
    dishes: { title: "Dish categories", one: "dish", many: "dishes", none: NO_CAT, rows: () => data.recipes.filter((r) => r.kind === "dish"), of: (r) => (r.category || "").trim(), same: (a, b) => fold(a) === fold(b) },
    ingredients: { title: "Ingredient sections", one: "ingredient", many: "ingredients", none: "No section", rows: () => data.ingredients, of: (i) => (i.category || "").trim(), same: (a, b) => a === b },
  };
  function categoryNames(kind) {
    const K = CAT_KINDS[kind];
    const own = kind === "dishes" ? dishCatList() : sectionList();
    const used = [...new Set(K.rows().map(K.of).filter(Boolean))].filter((c) => !own.some((o) => K.same(o, c)));
    return own.concat(used.sort(kind === "dishes" ? (a, b) => a.localeCompare(b, "fr", { sensitivity: "base" }) : bySection));
  }
  const catCount = (kind, name) => CAT_KINDS[kind].rows().filter((r) => CAT_KINDS[kind].same(CAT_KINDS[kind].of(r), name)).length;

  function categoriesCard() {
    const block = (kind) => {
      const K = CAT_KINDS[kind], names = categoryNames(kind);
      const rows = names.map((c, k) => { const n = catCount(kind, c); return `<li class="catrow">
        <input class="in" data-k="catn-${kind}-${k}" data-act="cat-rename" data-kind="${kind}" data-name="${esc(c)}" value="${esc(c)}" aria-label="Rename ${esc(c)}" />
        <span class="muted small nowrap">${n} ${n === 1 ? K.one : K.many}</span>
        <button class="icon" data-act="cat-move" data-kind="${kind}" data-at="${k}" data-dir="-1" ${k === 0 ? "disabled" : ""} aria-label="Move ${esc(c)} up">↑</button>
        <button class="icon" data-act="cat-move" data-kind="${kind}" data-at="${k}" data-dir="1" ${k === names.length - 1 ? "disabled" : ""} aria-label="Move ${esc(c)} down">↓</button>
        <button class="icon icon--x" data-act="cat-remove" data-kind="${kind}" data-name="${esc(c)}" aria-label="Remove ${esc(c)}">×</button></li>`; }).join("");
      return `<div><h3>${K.title}</h3><ol class="catlist">${rows}</ol>
        <input class="in in--add" data-k="cat-add-${kind}" data-act="cat-add" data-kind="${kind}" placeholder="+ New ${kind === "dishes" ? "category" : "section"}" aria-label="New ${kind === "dishes" ? "dish category" : "ingredient section"}" /></div>`;
    };
    return `<section class="card">
      <h2>Categories</h2>
      <p class="hint">Make your own, put them in your order (↑ ↓: the order of the groups and buttons), rename one (every dish or ingredient that has it follows) or remove one (they go to "${NO_CAT}" / "No section"). A new one typed on a dish or an ingredient shows up here too. Whether a section counts as food cost is set on the <a href="#/summary">inventory summary</a>.</p>
      ${part9Note()}
      <div class="grid2 grid2--even">${block("dishes")}${block("ingredients")}</div>
    </section>`;
  }
  const part9Note = () => (Store.part9Old() ? `<p class="note note--bad">Run part 9 of supabase/schema.sql in Supabase (SQL Editor) to save dish categories.</p>` : "");

  // Writes a category change: the rows that move, then the list. The list is your order, so it's kept whole.
  async function saveCategories(kind, names, moves, extra = {}) {
    const K = CAT_KINDS[kind], table = kind === "dishes" ? "recipes" : "ingredients";
    if (kind === "dishes" && moves.length && Store.part9Old()) { toast("Run part 9 of supabase/schema.sql in Supabase (SQL Editor) to save dish categories.", true); return render(); }
    await write(async () => {
      const rows = moves.map(([r, to]) => ({ ...r, category: to }));
      if (rows.length) {
        await store.upsert(table, rows.map((r) => Store.shape(table, r)));
        for (const r of rows) Object.assign(get(table, r.id), { category: r.category });
      }
      await saveSettings({ ...settings, categories: { ...(settings.categories || {}), [kind]: names.filter((c) => c && !K.same(c, K.none)), ...extra } });
    });
  }

  function driveCard() {
    const d = settings.drive || {};
    const link = (x, url) => (x ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(x.name)}</a>` : `<span class="muted">not picked yet</span>`);
    if (!GDrive.configured()) {
      return `<section class="card"><h2>Google Drive</h2><p>Not set up yet. Follow "Google Drive" in the README, then put the three Google values in <code>config.js</code>.</p></section>`;
    }
    return `<section class="card">
      <h2>Google Drive</h2>
      ${settingsProblem ? `<p class="note note--bad">${esc(settingsProblem)}</p>` : ""}
      <p>${GDrive.connected() ? "<strong>Connected</strong> for this visit." : "Not connected."}
        <button class="btn ${GDrive.connected() ? "" : "btn--main"}" data-act="g-connect">${GDrive.connected() ? "Reconnect" : "Connect Google Drive"}</button></p>
      <p class="hint">The app can only open files it made, plus the folder, sheets and card template you pick here. Your choices are saved with your account.</p>
      <div class="kv"><span>Recipe cards folder</span><span>${link(d.folder, d.folder && "https://drive.google.com/drive/folders/" + d.folder.id)}</span>
        <button class="btn btn--small" data-act="g-pick" data-kind="folder">Pick…</button></div>
      <div class="kv"><span>Recipe card template</span><span>${link(d.template, d.template && cardUrl(d.template.id))}</span>
        <button class="btn btn--small" data-act="g-pick" data-kind="template">Pick…</button></div>
      <div class="kv"><span>Recipe cost template</span><span>${link(d.costsheet, d.costsheet && cardUrl(d.costsheet.id))}</span>
        <button class="btn btn--small" data-act="g-pick" data-kind="costsheet">Pick…</button></div>
      <div class="kv"><span>Inventory sheet</span><span>${link(d.sheet, d.sheet && "https://docs.google.com/spreadsheets/d/" + d.sheet.id)}</span>
        <button class="btn btn--small" data-act="g-pick" data-kind="sheet">Pick…</button></div>
      <div class="kv"><span>Master Data sheet</span><span>${link(d.master, d.master && "https://docs.google.com/spreadsheets/d/" + d.master.id)}</span>
        <button class="btn btn--small" data-act="g-pick" data-kind="master">Pick…</button></div>
      ${d.folder ? `<p class="hint">New cards go into a folder the app makes inside it: ${d.cards ? link(d.cards, "https://drive.google.com/drive/folders/" + d.cards.id) : "“Recipe cards (Kitchen Costing)”"}, so they never mix with your older cards.</p>
        <p><button class="btn" data-act="save-all-cards">Save all recipe cards</button> <button class="btn" data-act="g-test">Test: make a page in the folder</button></p>` : ""}
    </section>`;
  }

  /** Once a day, the first time Drive is connected: a full copy of the data in "Kitchen Costing backups"
   * (My Drive, apart from the recipe cards). The last 30 are kept; older ones go to Drive's bin. */
  async function backupToDrive(force) {
    if (!GDrive.connected() || (!force && settings.lastBackup === today())) return;
    try {
      const d = settings.drive || {};
      let folder = d.backups && (await GDrive.exists(d.backups.id)) ? d.backups : null;
      if (!folder) folder = await GDrive.makeFolder(`${BAR ? "Barback" : SITE.app} backups`);
      const now = new Date(), two = (n) => String(n).padStart(2, "0");
      const stamp = `${today()} ${two(now.getHours())}h${two(now.getMinutes())}`;
      await GDrive.saveFile({ name: `${BAR ? "barback" : "kitchen-costing"} ${stamp}.json`, mime: "application/json", folderId: folder.id,
        content: JSON.stringify({ app: "kitchen-costing", version: 1, exported_at: new Date().toISOString(), ...data }) });
      const old = (await GDrive.listFolder(folder.id)).slice(30);
      for (const f of old) await GDrive.trash(f.id);
      await saveSettings({ ...settings, lastBackup: today(), drive: { ...(settings.drive || {}), backups: folder } });
      if (force) toast("Backed up to Drive.");
      if (route().page === "settings") render();
    } catch (e) { toast("Backup to Drive didn't work: " + e.message, true); }
  }
  GDrive.onConnect = () => backupToDrive(false);

  function trashCard() {
    const list = readJSON(TRASH, []);
    const when = (t) => new Date(t).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" });
    return `<section class="card">
      <h2>Recently deleted</h2>
      <p class="hint">The last 50 things deleted on this device. Putting one back restores it with its prices, history and recipe lines.</p>
      ${list.length ? `<table class="list small"><tbody>${list.map((e) => `<tr><td>${esc(e.label)} <span class="tag">${esc(e.kind)}</span></td><td class="muted nowrap">${esc(when(e.at))}</td>
        <td class="num"><button class="btn btn--small" data-act="trash-restore" data-id="${esc(e.id)}">Put back</button></td></tr>`).join("")}</tbody></table>`
        : `<p class="muted">Nothing deleted yet.</p>`}
    </section>`;
  }

  async function saveSettings(next) {
    settings = next;
    if (isEmployee()) return; // the account's settings are its administrators' to change: an employee's picks last this visit
    try { await store.saveSettings(settings); settingsProblem = ""; }
    catch (e) {
      settingsProblem = /settings/.test(e.message) ? "Couldn't save: run the updated supabase/schema.sql once in Supabase (it adds a small settings table)." : e.message;
      toast(settingsProblem, true);
    }
  }

  /* ---------- actions ---------- */
  const actions = {
    async "draft-restore"() {
      // Put the typed text back in each field and save it, one by one; anything that fails stays offered.
      for (const d of pendingDrafts()) {
        const el = main.querySelector(`[data-k="${CSS.escape(d.key.slice(location.hash.length + 1))}"]`);
        if (!el) continue;
        el.value = d.value;
        write.failed = false;
        await actions[el.dataset.act](el);
        if (!write.failed) dropDraft(d.key);
      }
      if (!pendingDrafts().length) toast("Put back and saved.");
      render();
    },
    "draft-discard"() {
      for (const d of pendingDrafts()) dropDraft(d.key);
      render();
    },
    async "trash-restore"(el) { await restoreFromTrash(el.dataset.id); },
    "master-csv"() {
      downloadCsv(`Master Data ${today()}.csv`, [MASTER_HEAD, ...masterRows(false)]);
    },
    async "master-sheet"() {
      const sheet = settings.drive.master;
      const inLb = data.ingredients.filter((i) => data.offers.some((o) => o.ingredient_id === i.id && ["lb", "oz"].includes(o.pack_unit))).length;
      const copy = `Ingredients (before ${today()})`;
      if (!(await ask(`Replace the "Ingredients" tab of ${sheet.name} with the app's ${data.ingredients.length} ingredients? ` +
        `A copy of the tab as it is now is kept first, as "${copy}". ` +
        (inLb ? `${inLb} items bought by the pound are written in kg, so old costing workbooks that count those in lb will be off for them.` : ""),
        { ok: "Replace Ingredients tab", danger: true }))) return;
      try {
        if (!GDrive.connected()) await GDrive.connect();
        toast("Sending…");
        const tabs = (await GDrive.sheetTabs(sheet.id)).map((t) => t.title);
        if (tabs.includes("Ingredients") && !tabs.includes(copy)) await GDrive.copyTab(sheet.id, "Ingredients", copy);
        // In the tab's own order of sections, and every row looking like one of its ingredient rows (lower down, the
        // tab's empty rows are formatted differently: Rendement in $ rather than %).
        const prevA = tabs.includes("Ingredients") ? await GDrive.readColumn(sheet.id, "Ingredients", "A") : [];
        const rows = [[], MASTER_HEAD, ...masterRows(true, prevA)];
        await GDrive.writeTabLike(sheet.id, "Ingredients", rows, "Ingredients", prevA[2] ? [{ from: 2, to: [2, rows.length] }] : []);
        toast(`Master Data updated: ${data.ingredients.length} ingredients. The old tab is kept as "${copy}".`);
      } catch (e) { toast(e.message, true); }
    },
    async "inv-drive"() {
      try {
        const d = settings.drive || {};
        const picked = await GDrive.pickPdfs(d.invoiceFolder);
        if (!picked.length) return;
        // Next time, the picker opens in the folder these came from.
        const folder = picked[0].parentId;
        if (folder && folder !== d.invoiceFolder) await saveSettings({ ...settings, drive: { ...(settings.drive || {}), invoiceFolder: folder } });
        toast(`Getting ${picked.length} file${picked.length === 1 ? "" : "s"} from Drive…`);
        const files = [];
        for (const p of picked) files.push(new File([await GDrive.fileBlob(p.id)], p.name, { type: "application/pdf" }));
        await actions["inv-files"]({ files, value: "" });
      } catch (e) { toast(e.message, true); }
    },
    async "inv-files"(el) {
      const files = [...(el.files || [])];
      el.value = "";
      for (const f of files) {
        try {
          toast(`Reading ${f.name}…`);
          const r = Invoices.read(await PdfText.read(f));
          // Commis: one it can't read can be sent in, so a reader gets made for that supplier.
          const cantRead = (why) => { if (SITE.commis) unreadInvoices.push({ file: f, why, sent: false }); toast(`${f.name}: ${why}`, true); };
          if (!r.supplier) { cantRead("this supplier's layout isn't known yet."); continue; }
          if (!r.lines.length) {
            if (r.subtotal > 0) cantRead(`it lists ${money(r.subtotal, true)} of items but none of its lines could be read. Enter those prices by hand.`);
            else toast(`${f.name}: no item lines found (a credit note or statement?).`, true);
            continue;
          }
          const lines = r.lines.map((l) => {
            const g = Invoices.suggest(l, r.supplier, data, Units);
            return { ...l, ingId: g ? g.ingredient.id : null, offerId: g && g.offer ? g.offer.id : null, how: g ? g.how : null,
              packQty: g && g.pack ? g.pack.qty : (Invoices.packOf(l, Units) || {}).qty || 1, packUnit: g && g.pack ? g.pack.unit : (Invoices.packOf(l, Units) || {}).unit || "unit", include: !!g };
          });
          invoiceWork.push({ file: f.name, supplier: r.supplier, date: r.date, lines, already: alreadyImported(f.name), missed: r.missed || 0 });
          invoiceFiles.set(f.name, f);
          keepInvoices();
        } catch (e) { toast(`${f.name}: ${e.message}`, true); }
      }
      render();
    },
    async "inv-send"(el) {
      const u = unreadInvoices[+el.dataset.n];
      if (!u || u.sent) return;
      el.disabled = true;
      try {
        await store.sendInvoice(u.file, u.why);
        u.sent = true;
        toast(`Sent ${u.file.name}. Thank you: we'll add that supplier.`);
      } catch (e) { toast(e.message, true); }
      render();
    },
    async "menu-zip"(el) {
      const name = el.dataset.menu, picks = menuPicks();
      if (!Object.values(picks).some(Boolean)) return toast("Tick at least one thing to put in the folder.", true);
      el.disabled = true;
      try {
        if (menuNeedsDrive(picks) && !GDrive.connected()) await GDrive.connect();
        toast("Making the menu's folder…");
        const { files, skipped } = await menuFiles(name, picks);
        if (!files.length) throw new Error(skipped[0] || "Nothing to put in the folder.");
        const JSZip = await MenuFile.loadZip(), zip = new JSZip(), top = MenuFile.fileName(name);
        for (const f of files) zip.file(`${top}/${f.path}`, f.data);
        saveBlob(`${top} (menu ${today()}).zip`, await zip.generateAsync({ type: "blob", compression: "DEFLATE" }));
        menuDone(`Downloaded “${top}”: ${files.length} file${files.length === 1 ? "" : "s"}.`, skipped);
      } catch (e) { toast(e.message, true); }
      el.disabled = false;
    },
    async "menu-drive"(el) {
      const name = el.dataset.menu, picks = menuPicks(), d = settings.drive || {};
      if (!Object.values(picks).some(Boolean)) return toast("Tick at least one thing to put in the folder.", true);
      el.disabled = true;
      try {
        if (!GDrive.connected()) await GDrive.connect();
        toast("Making the menu's folder…");
        const { files, skipped } = await menuFiles(name, picks);
        if (!files.length) throw new Error(skipped[0] || "Nothing to put in the folder.");
        const folder = await GDrive.makeFolder(`${MenuFile.fileName(name)} (menu ${today()})`, d.folder.id);
        const subs = new Map();
        for (const [k, f] of files.entries()) {
          if (k % 4 === 0) toast(`Saving to Drive: ${k + 1} of ${files.length}…`);
          const parts = f.path.split("/"), file = parts.pop();
          let parent = folder.id;
          for (let i = 0; i < parts.length; i++) {
            const key = parts.slice(0, i + 1).join("/");
            if (!subs.has(key)) subs.set(key, (await GDrive.makeFolder(parts[i], parent)).id);
            parent = subs.get(key);
          }
          // Word and Excel become Google Docs and Sheets, so they open and edit right in Drive.
          const as = f.mime === MenuFile.DOCX_TYPE ? GDrive.GOOGLE_DOC : "application/vnd.google-apps.spreadsheet";
          await GDrive.saveBytes({ name: file.replace(/\.(docx|xlsx)$/, ""), bytes: f.data, mime: f.mime, folderId: parent, as });
        }
        menuDone(`Saved “${folder.name}” in ${d.folder.name}: ${files.length} file${files.length === 1 ? "" : "s"}.`, skipped,
          { label: "Open", run: () => window.open("https://drive.google.com/drive/folders/" + encodeURIComponent(folder.id), "_blank", "noopener") });
      } catch (e) { toast(e.message, true); }
      el.disabled = false;
    },
    async "inv-report"(el) {
      const inv = invoiceWork[+el.dataset.inv], file = inv && invoiceFiles.get(inv.file);
      if (!file) return;
      try { if (await sendToUs(file)) { inv.sentToUs = true; keepInvoices(); render(); } } catch (e) { toast(e.message, true); }
    },
    // Any PDF, including one added on an earlier visit (only this visit's files are kept for its own button).
    "inv-pick-send"() {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "application/pdf,.pdf";
      input.onchange = async () => {
        const file = input.files[0];
        if (!file) return;
        if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) return toast("Only PDF invoices can be sent.", true);
        try { await sendToUs(file); } catch (e) { toast(e.message, true); }
      };
      input.click();
    },
    "inv-unread-drop"(el) { unreadInvoices.splice(+el.dataset.n, 1); render(); },
    "inv-include"(el) { invoiceWork[el.dataset.inv].lines[el.dataset.line].include = el.checked; keepInvoices(); render(); },
    "inv-item"(el) {
      const inv = invoiceWork[el.dataset.inv], l = inv.lines[el.dataset.line];
      const i = data.ingredients.find((x) => x.name.toLowerCase() === el.value.trim().toLowerCase());
      // A name that isn't an item yet: offer to make it.
      if (el.value.trim() && !i) return actions["inv-new-item"]({ dataset: el.dataset, typed: el.value.trim() });
      Object.assign(l, { ingId: i ? i.id : null, offerId: null, how: i ? "picked" : null, include: !!i });
      // The invoice's pack doesn't go into how the item is priced (a 12 kg case for an item priced per unit):
      // take the item's usual pack instead.
      const fix = i && !packFits(l.packQty, l.packUnit, i) && usualPack(i, inv.supplier);
      if (fix) { l.packQty = fix.qty; l.packUnit = fix.unit; toast(`Pack set to ${numText(fix.qty)} ${manyOf(unitLabel(fix.unit), fix.qty)}, how ${i.name} is usually bought: change it if this case is different.`); }
      keepInvoices(); render();
    },
    // A new item straight from an invoice line: its name, a category, and priced per kg, L or unit like the invoice's
    // pack, so the price works out straight away. The price itself is saved with the invoice, which remembers the name.
    async "inv-new-item"(el) {
      const inv = invoiceWork[el.dataset.inv], l = inv.lines[el.dataset.line];
      const name = await ask(el.typed ? `No item called "${el.typed}" yet. Make it a new item?` : `New item for "${l.item}" (${inv.supplier})`,
        { input: true, ok: "Next", value: el.typed || l.item, placeholder: "Its name in the app, e.g. Oignons, Jaune" });
      if (!name) return render();
      const same = data.ingredients.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (same) return actions["inv-item"]({ dataset: el.dataset, value: same.name });
      const category = await ask(`Category for ${name}? (it can stay empty)`, { input: true, optional: true, ok: "Make the item", list: "dl-categories", placeholder: "e.g. Vegé" });
      if (category == null) return render();
      const pu = Units.baseOf(l.packUnit);
      const base = ["kg", "L", "unit", "portion", "bunch"].includes(pu) ? pu : "unit";
      await write(async () => {
        const ing = await insert("ingredients", { id: uid(), name, category, base, yield: 1, notes: "", review: "" });
        Object.assign(l, { ingId: ing.id, offerId: null, how: "new", include: true });
        keepInvoices();
      });
      if (!write.failed) toast(`${name} made, priced per ${unitLabel(base)}. Its price is saved with the invoice, and the name on the invoice is remembered.`);
    },
    "inv-usepack"(el) {
      const l = invoiceWork[el.dataset.inv].lines[el.dataset.line];
      l.packQty = parseNum(el.dataset.qty); l.packUnit = el.dataset.unit;
      keepInvoices(); render();
    },
    "inv-pack"(el) {
      const l = invoiceWork[el.dataset.inv].lines[el.dataset.line];
      l[el.dataset.field] = el.dataset.field === "packQty" ? parseNum(el.value) : el.value;
      keepInvoices(); render();
    },
    "inv-remove"(el) { invoiceWork.splice(+el.dataset.inv, 1); keepInvoices(); render(); },
    async "inv-save"(el) {
      const inv = invoiceWork[+el.dataset.inv];
      let n = 0, spent = null;
      await write(async () => { n = await saveInvoice(inv); spent = await saveSpending(inv); });
      if (write.failed) return;
      invoiceWork.splice(+el.dataset.inv, 1); keepInvoices();
      render();
      toast(`Saved ${n ? `${n} price${n === 1 ? "" : "s"}` : "the spending"} from ${inv.supplier} (${inv.date || today()})${spent != null ? `: ${money(spent)} counted in ${monthLabel(String(inv.date || today()).slice(0, 7))}` : ""}.${n ? " Dishes that moved are under Price changes." : ""}`);
    },
    // An old invoice: what it cost goes on record, and nothing about your prices changes.
    async "inv-save-spend"(el) {
      const inv = invoiceWork[+el.dataset.inv];
      let spent = null;
      await write(async () => { spent = await saveSpending(inv); });
      if (write.failed) return;
      invoiceWork.splice(+el.dataset.inv, 1); keepInvoices();
      render();
      toast(`${money(spent)} from ${inv.supplier} counted in ${monthLabel(String(inv.date || today()).slice(0, 7))}. Your prices didn't change.`);
    },
    async "inv-save-all"() {
      const n = invoiceWork.length, total = invoiceWork.reduce((t, inv) => t + recordOf(inv).total, 0);
      if (!(await ask(`Save the spending for all ${n} invoices, ${money(total)} before taxes?\n\nEach counts in the month on the invoice, and nothing about your prices changes. To update prices too, save them one at a time.`, { ok: "Save the spending" }))) return;
      let done = 0;
      await write(async () => {
        for (const inv of invoiceWork.slice()) { await saveSpending(inv); done++; }
      });
      invoiceWork = write.failed ? invoiceWork.slice(done) : [];
      keepInvoices();
      render();
      if (!write.failed) toast(`${done} invoices saved: ${money(total)} on record.`);
    },
    // What a line counts as: this line now, and that product from now on.
    async "inv-group"(el) {
      const inv = invoiceWork[el.dataset.inv], l = inv.lines[el.dataset.line];
      l.group = el.value;
      keepInvoices();
      await write(() => saveSettings({ ...settings, invoiceGroups: { ...(settings.invoiceGroups || {}), [productKey(inv.supplier, l)]: el.value } }));
    },
    "spend-toggle"(el) {
      if (spendOpen.has(el.dataset.id)) spendOpen.delete(el.dataset.id); else spendOpen.add(el.dataset.id);
      render.nextFocus = null;
      render();
      const again = main.querySelector(`[data-act="spend-toggle"][data-id="${CSS.escape(el.dataset.id)}"]`);
      if (again) again.focus();
    },
    async "spend-line-group"(el) {
      const x = get("saved_invoices", el.dataset.id);
      if (!x) return render();
      const lines = x.lines.map((l, k) => (k === +el.dataset.line ? { ...l, group: el.value } : l)), l = lines[+el.dataset.line];
      const total = Summary.invoiceRecord(lines.map((y) => ({ item: y.item, total: y.total, group: y.group })), (y) => y.group).total;
      await write(async () => {
        await patch("saved_invoices", x.id, { lines, total });
        await saveSettings({ ...settings, invoiceGroups: { ...(settings.invoiceGroups || {}), [(x.supplier || "") + "|" + l.item]: el.value } });
      });
    },
    async "spend-delete"(el) {
      const x = get("saved_invoices", el.dataset.id);
      if (!x) return render();
      if (!(await ask(`Remove ${x.supplier || "this purchase"} (${String(x.date).slice(0, 10)}, ${money(+x.total)}) from the spending?\n\nIts prices stay as they are.`, { ok: "Remove", danger: true }))) return;
      await write(() => removeRows("saved_invoices", x.id));
    },
    // From Sundae Atelier: pick a line's item (an ingredient, or "<name> (prep)"); a name that isn't an item offers to make it.
    "sun-item"(el) {
      const row = sundae.recipe.rows[+el.dataset.row], text = el.value.trim();
      if (!text) { delete sundae.picks[row.name]; keepSundae(); return render(); }
      const isPrep = /\s\(prep\)$/.test(text), name = text.replace(/\s\(prep\)$/, "").toLowerCase();
      const sub = data.recipes.find((x) => x.kind === "prep" && x.name.toLowerCase() === name && (isPrep || !data.ingredients.some((i) => i.name.toLowerCase() === name)));
      const ing = !isPrep && data.ingredients.find((i) => i.name.toLowerCase() === name);
      if (!sub && !ing) return actions["sun-new-item"]({ dataset: el.dataset, typed: text });
      sundae.picks[row.name] = ing ? { kind: "ingredient", id: ing.id } : { kind: "prep", id: sub.id };
      keepSundae(); render();
    },
    // A calculator ingredient that isn't one of your items: made priced per kg, with no price yet.
    async "sun-new-item"(el) {
      const row = sundae.recipe.rows[+el.dataset.row];
      const name = await ask(el.typed ? `No item called "${el.typed}" yet. Make it a new item?` : `New item for "${row.label}" (from Sundae Atelier)`,
        { input: true, ok: "Next", value: el.typed || row.label, placeholder: "Its name in the app, e.g. Stabilisateur" });
      if (!name) return render();
      const same = data.ingredients.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (same) { sundae.picks[row.name] = { kind: "ingredient", id: same.id }; keepSundae(); return render(); }
      const category = await ask(`Category for ${name}? (it can stay empty)`, { input: true, optional: true, ok: "Make the item", list: "dl-categories", placeholder: "e.g. Pâtisserie" });
      if (category == null) return render();
      await write(async () => {
        const ing = await insert("ingredients", { id: uid(), name, category, base: "kg", yield: 1, notes: "", review: "New: add a supplier price." });
        sundae.picks[row.name] = { kind: "ingredient", id: ing.id };
        keepSundae();
      });
      if (!write.failed) toast(`${name} made, priced per kg. It has no price yet: an invoice or a price typed on its page fills it in.`);
    },
    "sun-name"(el) { sundae.name = el.value.trim(); keepSundae(); render(); },
    "sun-count"(el) { sundae.count = el.checked; keepSundae(); render(); },
    "sun-asnew"(el) { sundae.asNew = el.checked; sundae.name = null; keepSundae(); render(); },
    async "sun-discard"() {
      if (!(await ask(`Forget "${sundae.recipe.name}" from Sundae Atelier? Nothing from it has been saved.`, { ok: "Forget it" }))) return;
      sundae = null; keepSundae();
      location.hash = "#/preps";
    },
    /** Makes the prep (or updates the one this saved recipe became last time): by the kg, its lines from the calculator. */
    async "sun-save"() {
      const v = sundaeView(), rec = v.rec;
      if (v.stop) return toast(v.stop, true);
      let prep = v.target;
      await write(async () => {
        const fields = { name: v.name, yield_qty: rec.batch, yield_unit: "kg", in_inventory: v.count };
        if (prep) {
          await patch("recipes", prep.id, fields);
          await removeRows("lines", data.lines.filter((l) => l.recipe_id === prep.id).map((l) => l.id));
        } else {
          prep = await insert("recipes", { id: uid(), kind: "prep", menu: "Preps", ...fields,
            notes: `From Sundae Atelier: ${rec.recipe}${rec.temp ? " at " + rec.temp : ""}. Send it again from the calculator to update it.` });
        }
        const lines = v.rows.map((x, k) => Store.shape("lines", { id: uid(), recipe_id: prep.id, pos: k + 1, qty: x.line.qty, unit: x.line.unit,
          ...(x.pick.kind === "prep" ? { sub_recipe_id: x.item.id } : { ingredient_id: x.item.id }) }));
        data.lines.push(...lines);
        await store.insert("lines", lines);
        await settle(prep.id);
        const memory = settings.sundae || {};
        await saveSettings({ ...settings, sundae: {
          items: { ...(memory.items || {}), ...Object.fromEntries(v.rows.map((x) => [x.row.name, x.pick])) },
          preps: rec.id ? { ...(memory.preps || {}), [rec.id]: prep.id } : memory.preps || {} } });
      });
      if (write.failed) return;
      sundae = null; keepSundae();
      const per = coster.recipeCost(prep.id).perYield;
      location.hash = "#/recipe/" + encodeURIComponent(prep.id);
      toast(`${prep.name} ${v.target ? "updated" : "saved"}: ${money(per, true)}/kg.`);
    },
    async "backup-now"() {
      try { if (!GDrive.connected()) await GDrive.connect(); } catch (e) { toast(e.message, true); return; }
      await backupToDrive(true);
    },
    // One of the boxes for what a recipe comes to, on a prep or an item. Empty is always fine.
    async measure(el) {
      const isRecipe = el.dataset.owner === "recipe", f = el.dataset.field, at = el.dataset.unit;
      const x = get(isRecipe ? "recipes" : "ingredients", el.dataset.id);
      if (!x) return render();
      const list = (isRecipe ? Costing.recipeMeasures(x) : itemMeasureView(x)).map((m) => ({ ...m }));
      const text = String(el.value).trim(), v = parseNum(text);
      if (f !== "unit" && text && !(v > 0)) { toast("That has to be a number more than 0, or left empty.", true); return render(); }
      const was = list.find((m) => m.unit === at);
      let costPer = isRecipe ? x.yield_unit : null, relabel = false;
      if (f === "unit") {
        // Nothing typed in that box yet: the unit showing is used when something is.
        if (!was) return;
        was.unit = el.value;
        if (isRecipe && at === x.yield_unit) { costPer = el.value; relabel = true; }
      } else if (f === "qty") {
        const unit = el.closest("[data-measure]").querySelector("select").value;
        if (!text && !was) return render();
        // A dish always makes something: emptying what its cost is per means one of them, as it always has.
        if (!text && isRecipe && x.kind === "dish" && at === x.yield_unit) was.qty = 1;
        else if (!text) {
          // Emptying a measure recipes rely on: they'd have no cost, so it asks. It's still your call.
          const fits = (u) => !!u && Units.convert(1, u, at) != null;
          const links = isRecipe ? new Set(data.ingredients.filter((i) => i.prep_id === x.id).map((i) => i.id)) : new Set([x.id]);
          const users = data.lines.filter((l) => fits(l.unit) && ((isRecipe && l.sub_recipe_id === x.id) || (links.has(l.ingredient_id) && Units.convert(1, l.unit, get("ingredients", l.ingredient_id).base) == null))).length;
          if (users && !(await ask(`${users} recipe line${users === 1 ? " uses" : "s use"} "${x.name}" by the ${unitLabel(at)}. With this empty they can't be costed until they're changed. Empty it anyway?`, { ok: "Empty it", danger: true }))) return render();
          list.splice(list.indexOf(was), 1);
        } else if (was) { was.qty = v; was.unit = unit; if (isRecipe && at === x.yield_unit && unit !== at) { costPer = unit; relabel = true; } }
        else list.push({ qty: v, unit });
      } else {
        // "1 portion = 182 g": with the weight known it gives the portions, with the portions it gives the weight.
        if (!text) return render();
        const sized = Costing.withPortionSize(list, v / 1000, el.dataset.small === "ml" ? "L" : "kg");
        return isRecipe ? saveRecipeMeasures(x, sized, costPer) : saveItemMeasures(x, sized);
      }
      if (isRecipe) return saveRecipeMeasures(x, list, costPer, relabel);
      return saveItemMeasures(x, list);
    },
    async "measure-costper"(el) {
      const r = get("recipes", el.dataset.id);
      if (r) await saveRecipeMeasures(r, Costing.recipeMeasures(r), el.value);
    },
    async container(el) {
      if (Store.part16Old()) { toast(PART16_NOTE, true); return render(); }
      const isRecipe = el.dataset.owner === "recipe", table = isRecipe ? "recipes" : "ingredients", x = get(table, el.dataset.id);
      const text = el.value.trim(), g = parseNum(text);
      if (!x) return render();
      if (text && !(g > 0)) { toast("A container's weight is a number of grams more than 0, or left empty.", true); return render(); }
      const changes = { container_kg: text ? g / 1000 : null };
      // A container only means something when counting by weight: that's how it's counted from now on, if it can be.
      const base = isRecipe ? x.yield_unit : x.base;
      if (text && base !== "kg" && coster.countChoices(x, isRecipe).includes("kg")) changes.count_unit = "kg";
      await write(() => patch(table, x.id, changes));
    },
    async "recipe-field"(el) {
      const r = get("recipes", route().id);
      const f = el.dataset.field;
      if (f === "in_inventory") {
        if (Store.part5Old()) { toast("Run the updated supabase/schema.sql (part 5) in Supabase to count preps.", true); return render(); }
        await write(() => patch("recipes", r.id, { in_inventory: el.checked }));
        if (!write.failed) toast(el.checked ? `${r.name} is on the monthly count.` : `${r.name} is off the monthly count.`);
        return;
      }
      let v = el.value;
      if (["multiplier", "menu_price"].includes(f)) {
        v = parseNum(v);
        if (f === "multiplier" && !(v > 0)) v = BAR ? Barback.MULTIPLIER : 4;
      }
      if (f === "name" && !v.trim()) { toast("A name is needed.", true); return render(); }
      if (f === "category") return actions["dish-cat"]({ dataset: { id: r.id }, value: v });
      if (f === "menu" && r.kind === "dish") return actions["dish-menu"]({ dataset: { id: r.id }, value: v });
      const changes = { [f]: typeof v === "string" ? v.trim() : v };
      await write(() => patch("recipes", r.id, changes));
    },
    // A dish's category, from its page or straight from the Dishes list.
    async "dish-cat"(el) {
      const r = get("recipes", el.dataset.id);
      if (Store.part9Old()) { toast("Run part 9 of supabase/schema.sql in Supabase (SQL Editor) to save dish categories.", true); return render(); }
      const category = catSpelling(el.value || "");
      if (!r || category === (r.category || "")) return render();
      await write(() => patch("recipes", r.id, { category }));
    },
    // Settings → Categories.
    async "cat-move"(el) {
      const names = categoryNames(el.dataset.kind), k = +el.dataset.at, j = k + +el.dataset.dir;
      if (j < 0 || j >= names.length) return;
      [names[k], names[j]] = [names[j], names[k]];
      render.nextFocus = null;
      await saveCategories(el.dataset.kind, names, []);
    },
    async "cat-add"(el) {
      const kind = el.dataset.kind, K = CAT_KINDS[kind], name = el.value.trim(), names = categoryNames(kind);
      if (!name) return;
      if (names.some((c) => K.same(c, name)) || K.same(name, K.none)) { toast(`"${name}" is already there.`, true); return render(); }
      await saveCategories(kind, names.concat(name), []);
      if (!write.failed) toast(`"${name}" added: it's in the suggestions now.`);
    },
    async "cat-rename"(el) {
      const kind = el.dataset.kind, K = CAT_KINDS[kind], from = el.dataset.name, to = el.value.trim();
      if (to === from) return;
      if (!to) { toast(`To take "${from}" away, press × beside it.`, true); return render(); }
      const names = categoryNames(kind), moving = K.rows().filter((r) => K.same(K.of(r), from));
      // Renaming to one that already exists puts them together.
      const other = names.find((c) => c !== from && K.same(c, to));
      const things = `${moving.length} ${moving.length === 1 ? K.one : K.many}`;
      if (other && !(await ask(`"${other}" already exists. Put the ${things} from "${from}" in it?`, { ok: `Move to ${other}` }))) return render();
      const target = other || to;
      const list = other ? names.filter((c) => c !== from) : names.map((c) => (c === from ? to : c));
      const extra = kind === "ingredients" && from === prepSection() ? { prepSection: target } : {};
      const groups = (settings.categories || {}).groups;
      if (kind === "ingredients" && groups && groups[from]) {
        const next = { ...groups };
        if (!next[target]) next[target] = next[from];
        delete next[from];
        extra.groups = next;
      }
      await saveCategories(kind, list, moving.map((r) => [r, target]), extra);
      if (!write.failed) toast(`"${from}" is now "${target}"${moving.length ? ` (${things})` : ""}.`);
    },
    async "cat-remove"(el) {
      const kind = el.dataset.kind, K = CAT_KINDS[kind], name = el.dataset.name;
      const moving = K.rows().filter((r) => K.same(K.of(r), name));
      const things = `${moving.length} ${moving.length === 1 ? K.one : K.many}`;
      if (moving.length && !(await ask(`Remove "${name}"? Its ${things} go to "${K.none}" (you can give them another one after).`, { ok: "Remove", danger: true }))) return;
      await saveCategories(kind, categoryNames(kind).filter((c) => c !== name), moving.map((r) => [r, ""]));
    },
    // The menu a dish is on: one already in use, or a new one typed in.
    async "dish-menu"(el) {
      const r = get("recipes", el.dataset.id);
      const menu = menuSpelling(el.value || "");
      if (!r || menu === (r.menu || "")) return render();
      await write(() => patch("recipes", r.id, { menu }));
    },
    "dish-group"(el) { writeJSON(DISH_GROUP, el.dataset.by); render(); },
    "hist-period"(el) { writeJSON(HIST_KEY, el.dataset.p); render(); },
    // Scale the card: starts from the card's saved standard, else the biggest amount by weight (usually the main
    // ingredient) set to 1 kg. Saved with your account; the recipe itself is never changed.
    "scale-open"(el) {
      const saved = (settings.cardScale || {})[el.dataset.id];
      if (saved && get("lines", saved.line)) { scaling = { id: el.dataset.id, ...saved }; return render(); }
      const lines = data.lines.filter((l) => l.recipe_id === el.dataset.id && parseNum(l.qty) > 0);
      const kg = (l) => Units.convert(parseNum(l.qty), lineUnit(l), "kg");
      const pick = lines.filter((l) => kg(l) != null).sort((a, b) => kg(b) - kg(a))[0] || lines[0];
      scaling = { id: el.dataset.id, line: pick.id, qty: "1", unit: scaleUnit(pick) };
      render();
    },
    "scale-pick"(el) { const l = get("lines", el.value); scaling = { ...scaling, line: el.value, unit: l ? scaleUnit(l) : scaling.unit }; render(); },
    "scale-qty"(el) { scaling = { ...scaling, qty: el.value.trim() }; render(); },
    "scale-unit"(el) { scaling = { ...scaling, unit: el.value }; render(); },
    "scale-close"() { scaling = null; render(); },
    async "scale-save"() {
      const r = get("recipes", scaling.id), p = scalePlan(r, scaling);
      if (p.error) { toast(p.error, true); return render(); }
      const { id, line, qty, unit } = scaling;
      await saveSettings({ ...settings, cardScale: { ...(settings.cardScale || {}), [id]: { line, qty, unit } } });
      scaling = null;
      render();
      toast(`The card will show ${lineName(p.base)} at ${numText(qty)} ${unitLabel(unit)}${r.card_doc_id ? ": press Update card on Drive to rewrite it" : ""}.`);
    },
    async "scale-clear"(el) {
      const all = { ...(settings.cardScale || {}) };
      delete all[el.dataset.id];
      await saveSettings({ ...settings, cardScale: all });
      render();
      toast("The card uses the recipe's own amounts again.");
    },
    async "line-field"(el) {
      const f = el.dataset.field;
      let v = f === "qty" ? parseNum(el.value) : el.value || null;
      const line = get("lines", el.dataset.id);
      // A yield for this line only: empty (or the item's own) means the item's usual yield.
      if (f === "yield") {
        if (Store.part10Old()) { toast("Run part 10 of supabase/schema.sql in Supabase (SQL Editor) to keep a yield per recipe line.", true); return render(); }
        const ing = get("ingredients", line.ingredient_id);
        v = el.value.trim() ? parseYield(el.value) : null;
        if (el.value.trim() && v == null) { toast(YIELD_HELP, true); return render(); }
        if (v != null && ing && Math.abs(v - (parseNum(ing.yield) || 1)) < 1e-9) v = null;
      }
      await write(async () => { await patch("lines", line.id, { [f]: v }); await settle(line.recipe_id); });
    },
    async "back-to"(el) {
      // The dish changed because you built its prep: that's not a price move, so don't flag it.
      await write(() => settle(el.dataset.id));
      render.goingBack = true;
      location.hash = backHref(get("recipes", el.dataset.id) || { id: el.dataset.id });
    },
    async "add-line"(el) {
      const r = get("recipes", el.dataset.id);
      const text = el.value.trim();
      if (!text) return;
      const isPrep = /\s\(prep\)$/.test(text);
      const name = text.replace(/\s\(prep\)$/, "").toLowerCase();
      let sub = data.recipes.find((x) => x.kind === "prep" && x.name.toLowerCase() === name && (isPrep || !data.ingredients.some((i) => i.name.toLowerCase() === name)));
      let ing = !isPrep && data.ingredients.find((i) => i.name.toLowerCase() === name);
      // Barback: not one of its own, so it may be one of the kitchen's.
      if (BAR && !sub && !ing) ({ sub, ing } = kitchenPick(text));
      if (sub && sub.id === r.id) { toast("A prep can't use itself.", true); el.value = ""; return; }
      const pos = Math.max(0, ...data.lines.filter((l) => l.recipe_id === r.id).map((l) => l.pos || 0)) + 1;
      let newPrep = null;
      await write(async () => {
        if (!sub && !ing) {
          const pick = await ask(`"${text}" isn't in your ingredients or preps yet. What is it?`, { choices: [
            { value: "ingredient", label: "A new ingredient" },
            { value: "prep", label: "A new prep", main: true },
          ] });
          if (!pick) return;
          if (pick === "prep") {
            newPrep = await insert("recipes", { id: uid(), name: text, kind: "prep", menu: "Preps", yield_qty: 1, yield_unit: BAR ? "L" : "portion", ack_cost: 0 });
            await insert("lines", { id: uid(), recipe_id: r.id, pos, sub_recipe_id: newPrep.id, qty: 1, unit: BAR ? "floz" : "portion" });
            return;
          }
          ing = await insert("ingredients", { id: uid(), name: text, category: "", base: BAR ? "L" : "kg", yield: 1, review: "New: add a supplier price." });
        }
        // Behind a bar, anything liquid starts in ounces.
        await insert("lines", sub
          ? { id: uid(), recipe_id: r.id, pos, sub_recipe_id: sub.id, qty: 1, unit: BAR && Units.baseOf(sub.yield_unit) === "L" ? "floz" : sub.yield_unit === "portion" ? "portion" : sub.yield_unit }
          : { id: uid(), recipe_id: r.id, pos, ingredient_id: ing.id, qty: null, unit: BAR && ing.base === "L" ? "floz" : ing.base });
        await settle(r.id);
      });
      // A new prep opens straight away, with a button back to this recipe.
      if (newPrep) {
        location.hash = `#/recipe/${encodeURIComponent(newPrep.id)}/new/${encodeURIComponent(r.id)}`;
        setTimeout(() => { const a = main.querySelector('[data-k="add-line"]'); if (a) a.focus(); }, 0);
        return;
      }
      // Put the cursor in the new line's quantity.
      const last = data.lines.filter((l) => l.recipe_id === r.id).sort((a, b) => a.pos - b.pos).pop();
      const q = last && main.querySelector(`[data-k="l-qty-${CSS.escape(last.id)}"]`);
      if (q) q.focus();
    },
    async "delete-line"(el) {
      const line = get("lines", el.dataset.id);
      const item = line.ingredient_id ? get("ingredients", line.ingredient_id) : get("recipes", line.sub_recipe_id);
      const entry = toTrash(`${item ? item.name : "a line"} from ${get("recipes", line.recipe_id).name}`, "line", { lines: [{ ...line }] });
      await write(async () => { await removeRows("lines", line.id); await settle(line.recipe_id); });
      if (!write.failed) toast(`Removed ${item ? item.name : "the line"}.`, false, undoFor(entry));
    },
    async ack(el) {
      await write(() => patch("recipes", el.dataset.id, { ack_cost: round4(coster.recipeCost(el.dataset.id).perYield) }));
    },
    async "ack-all"() {
      const list = data.recipes.filter((r) => coster.summary(r.id).change !== 0);
      await write(async () => { for (const r of list) await patch("recipes", r.id, { ack_cost: round4(coster.recipeCost(r.id).perYield) }); });
      toast(`Marked ${list.length} as seen.`);
    },
    async "recipe-checked"(el) { await write(() => patch("recipes", el.dataset.id, { review: "" })); },
    async "new-recipe"(el) {
      const kind = el.dataset.kind;
      const r = { id: uid(), name: kind === "dish" ? (BAR ? "New cocktail" : "New dish") : "New prep", kind, menu: "", yield_qty: 1, yield_unit: BAR && kind === "prep" ? "L" : "portion", multiplier: kind === "dish" ? (BAR ? Barback.MULTIPLIER : 4) : null, ack_cost: 0, notes: "", review: "" };
      await write(() => insert("recipes", r));
      location.hash = "#/recipe/" + r.id;
      setTimeout(() => { const n = $('[data-k="r-name"]'); if (n) n.select(); }, 0);
    },
    async duplicate(el) {
      const src = get("recipes", el.dataset.id);
      const copy = { ...src, id: uid(), name: src.name + " (copy)", review: "" };
      await write(async () => {
        await insert("recipes", copy);
        const lines = data.lines.filter((l) => l.recipe_id === src.id).map((l) => Store.shape("lines", { ...l, id: uid(), recipe_id: copy.id }));
        data.lines.push(...lines);
        if (lines.length) await store.insert("lines", lines);
      });
      location.hash = "#/recipe/" + copy.id;
    },
    async "merge-recipe"(el) {
      const from = get("recipes", el.dataset.id);
      const kind = from.kind === "dish" ? "dish" : "prep";
      let into = el.dataset.into && get("recipes", el.dataset.into);
      if (!into) {
        const name = await ask(`Merge "${from.name}" into which ${kind}? Type its name and pick it.`, { ok: "Next", input: true, placeholder: kind === "dish" ? "e.g. Hot Tart, Chicken" : "e.g. Gravy", list: "dl-preps" });
        if (!name) return;
        into = data.recipes.find((x) => x.id !== from.id && x.kind === from.kind && x.name.toLowerCase() === name.toLowerCase());
        if (!into) { toast(`No ${kind} called "${name}".`, true); return; }
      }
      // It would end up using itself.
      if (coster.usedBy(from.id).includes(into.id)) { toast(`"${into.name}" uses "${from.name}", so it can't take its place. Take it out of "${into.name}" first.`, true); return; }
      const uses = data.lines.filter((l) => l.sub_recipe_id === from.id);
      const links = data.ingredients.filter((i) => i.prep_id === from.id).length;
      const counts = data.counts.filter((c) => c.recipe_id === from.id).length;
      const cost = (r) => `${money(coster.summary(r.id).perPortion, true)} per ${unitLabel(r.yield_unit)}`;
      const inUnit = plural;
      const misfit = [...new Set(uses.filter((l) => !lineFits(l.unit, into)).map((l) => inUnit(l.unit)))];
      const card = FILL_FIELDS.filter((f) => !String(into[f] ?? "").trim() && String(from[f] ?? "").trim()).length;
      const countsMove = measureFits(from.yield_unit, into.yield_unit) ? counts : 0;
      const moving = [uses.length && `${uses.length} recipe line(s)`, links && `${links} "Made in-house" link(s)`, countsMove && `${countsMove} monthly count(s)`].filter(Boolean);
      const list = moving.length > 1 ? moving.slice(0, -1).join(", ") + " and " + moving[moving.length - 1] : moving[0];
      const text = [
        `Merge "${from.name}" into "${into.name}"?`,
        (moving.length ? `Its ${list} move to "${into.name}", with the same amounts. Then "${from.name}" and its own ingredient list are removed.`
          : `Nothing uses "${from.name}" yet, so it and its own ingredient list are just removed.`) + " You can undo it.",
        uses.length ? `Cost: "${from.name}" ${cost(from)}, "${into.name}" ${cost(into)}. Recipes whose cost moves will show under Price changes.` : "",
        misfit.length ? `Careful: some lines use it in ${misfit.join(" and ")}, which "${into.name}" isn't measured in. Give it a batch weight (Batch weighs / Gives) or change those lines.` : "",
        counts && !measureFits(from.yield_unit, into.yield_unit) ? `Its counts are in ${inUnit(from.yield_unit)} and "${into.name}" is counted in ${inUnit(into.yield_unit)}, so they won't come over.` : "",
        card ? `"${into.name}" takes the recipe card details it doesn't have yet from "${from.name}".` : "",
      ].filter(Boolean).join("\n\n");
      if (!(await ask(text, { ok: "Merge" }))) return;
      const entry = await mergeRecipe(from, into);
      if (!write.failed) { location.hash = "#/recipe/" + encodeURIComponent(into.id); toast(`Merged into ${into.name}.`, false, undoFor(entry)); }
    },
    async "delete-recipe"(el) {
      const r = get("recipes", el.dataset.id);
      const users = coster.usedBy(r.id).filter((x) => x !== r.id);
      if (users.length) { toast(`Used in ${users.length} other recipe(s). Remove it from them first.`, true); return; }
      const inBar = barUses("sub_recipe_id", r.id);
      if (inBar.length) { toast(`Barback uses it: ${inBar.map((x) => x.name).join(", ")}. Take it out there first.`, true); return; }
      if (!(await ask(`Delete "${r.name}"? You can put it back from Settings → Recently deleted.`, { ok: "Delete", danger: true }))) return;
      const lines = data.lines.filter((l) => l.recipe_id === r.id);
      const entry = toTrash(r.name, r.kind, { recipes: [{ ...r }], lines: lines.map((l) => ({ ...l })), counts: data.counts.filter((c) => c.recipe_id === r.id).map((c) => ({ ...c })) });
      await write(async () => {
        await removeRows("lines", lines.map((l) => l.id));
        await removeRows("counts", data.counts.filter((c) => c.recipe_id === r.id).map((c) => c.id));
        await removeRows("recipes", r.id);
      });
      location.hash = r.kind === "dish" ? "#/dishes" : "#/preps";
      if (!write.failed) toast(`Deleted "${r.name}".`, false, undoFor(entry));
    },
    async "ing-field"(el) {
      const f = el.dataset.field;
      if (f === "in_inventory") return write(() => patch("ingredients", route().id, { in_inventory: el.checked }));
      if (f === "prep_id") {
        if (Store.part5Old()) { toast("Run the updated supabase/schema.sql (part 5) in Supabase to link a prep.", true); return render(); }
        const name = el.value.trim().toLowerCase();
        // Usually a prep, but a whole workbook costed as a dish (e.g. "Lemons, Salted") works too.
        const same = data.recipes.filter((r) => r.name.toLowerCase() === name);
        const prep = name ? same.find((r) => r.kind === "prep") || same[0] || null : null;
        if (name && !prep) { toast(`No prep called "${el.value.trim()}".`, true); return render(); }
        return write(() => patch("ingredients", route().id, { prep_id: prep ? prep.id : null }));
      }
      let v = el.value;
      if (f === "yield") { v = parseYield(v); if (v == null) { toast(YIELD_HELP, true); return render(); } }
      if (f === "each_kg") v = parseNum(v);
      if (f === "name" && !v.trim()) { toast("A name is needed.", true); return render(); }
      if (f === "name" && data.ingredients.some((i) => i.id !== route().id && i.name.toLowerCase() === v.trim().toLowerCase())) { toast("Another ingredient already has that name.", true); return render(); }
      if (f === "base") {
        // A portion or a recipe is one unit: recipe lines follow a switch between unit and either, with the same amounts.
        const was = get("ingredients", route().id).base;
        const lines = Units.samePieces(was, v) ? data.lines.filter((l) => l.ingredient_id === route().id && l.unit === was) : [];
        await write(async () => { await patch("ingredients", route().id, { base: v }); for (const l of lines) await patch("lines", l.id, { unit: v }); });
        return;
      }
      await write(() => patch("ingredients", route().id, { [f]: typeof v === "string" ? v.trim() : v }));
    },
    async "ing-checked"(el) { await write(() => patch("ingredients", el.dataset.id, Store.part20Old() ? { review: "" } : { review: "", needs_check: false })); },
    // One allergen ticked or unticked on an item (contains and may-contain exclude each other), or "contains none".
    async allergen(el) {
      if (Store.part12Old()) return toast("Run part 12 of supabase/schema.sql in Supabase (SQL Editor) to save allergens.", true);
      const i = get("ingredients", el.dataset.id), f = el.dataset.field, k = el.dataset.key;
      if (!i) return;
      if (!k) return write(() => patch("ingredients", i.id, { allergens: "" }));
      const keys = allergenKeys(i[f]), on = !keys.includes(k);
      const change = { [f]: (on ? allergenKeys([...keys, k].join(",")) : keys.filter((x) => x !== k)).join(",") };
      const other = f === "allergens" ? "allergen_contact" : "allergens";
      if (on && allergenKeys(i[other]).includes(k)) change[other] = allergenKeys(i[other]).filter((x) => x !== k).join(",");
      if (i.allergens == null && change.allergens == null) change.allergens = "";
      await write(() => patch("ingredients", i.id, change));
    },
    // Yield straight from the Ingredients list.
    async "ing-yield"(el) {
      const i = get("ingredients", el.dataset.id), y = parseYield(el.value);
      if (y == null) { toast(YIELD_HELP, true); return render(); }
      if (!i || Math.abs(y - (parseNum(i.yield) || 1)) < 1e-9) return render();
      await write(() => patch("ingredients", i.id, { yield: y }));
    },
    async "offer-field"(el) {
      const o = get("offers", el.dataset.id);
      const f = el.dataset.field;
      const v = ["pack_cost", "pack_qty"].includes(f) ? parseNum(el.value) : el.value.trim();
      const priceChange = ["pack_cost", "pack_qty", "pack_unit"].includes(f);
      const wasMl = BAR ? Units.convert(+o.pack_qty, o.pack_unit, "ml") : null;
      await write(async () => {
        await patch("offers", o.id, priceChange ? { [f]: v, updated_at: today() } : { [f]: v });
        if (priceChange) await logPrice(o, "Typed in");
        if (priceChange) await sizeBottle(o.ingredient_id, o.pack_qty, o.pack_unit, wasMl);
      });
    },
    async prefer(el) {
      const o = get("offers", el.dataset.id);
      await write(() => patch("ingredients", o.ingredient_id, { preferred_offer_id: o.id }));
    },
    async "add-offer"(el) {
      const i = get("ingredients", el.dataset.id);
      // Behind a bar a price is usually for one bottle.
      const pack = BAR && i.base === "L" ? { pack_qty: Barback.bottleMl(i) || 750, pack_unit: "ml" } : { pack_qty: 1, pack_unit: i.base };
      await write(() => insert("offers", { id: uid(), ingredient_id: i.id, supplier: "", supplier_item: "", pack_cost: null, ...pack, updated_at: today() }));
      const last = data.offers.filter((o) => o.ingredient_id === i.id).pop();
      const s = last && main.querySelector(`[data-k="o-sup-${CSS.escape(last.id)}"]`);
      if (s) s.focus();
    },
    async "delete-offer"(el) {
      const o = get("offers", el.dataset.id);
      if (data.lines.some((l) => l.offer_id === o.id) && !(await ask("Some recipe lines picked this supplier. They'll go back to the preferred price. Delete it?", { ok: "Delete", danger: true }))) return;
      const owner = get("ingredients", o.ingredient_id);
      const entry = toTrash(`${o.supplier || "a price"} for ${owner ? owner.name : "an ingredient"}`, "price",
        { offers: [{ ...o }], price_history: data.price_history.filter((h) => h.offer_id === o.id).map((h) => ({ ...h })) },
        { preferredOf: owner && owner.preferred_offer_id === o.id ? owner.id : null, linesUsing: data.lines.filter((l) => l.offer_id === o.id).map((l) => l.id) });
      await write(async () => {
        for (const l of data.lines.filter((x) => x.offer_id === o.id)) await patch("lines", l.id, { offer_id: null });
        const ing = get("ingredients", o.ingredient_id);
        if (ing && ing.preferred_offer_id === o.id) await patch("ingredients", ing.id, { preferred_offer_id: null });
        await removeRows("price_history", data.price_history.filter((h) => h.offer_id === o.id).map((h) => h.id));
        await removeRows("offers", o.id);
      });
      if (!write.failed) toast(o.supplier ? `Deleted the ${o.supplier} price.` : "Deleted the price.", false, undoFor(entry));
    },
    async "new-ingredient"() {
      const name = (await ask("New ingredient: the name, the way you write it.", { ok: "Add", input: true, placeholder: BAR ? "e.g. Gin, Beefeater" : "e.g. Oignons, Jaune" })) || "";
      if (!name) return;
      if (data.ingredients.some((i) => i.name.toLowerCase() === name.toLowerCase())) { toast("That ingredient already exists.", true); return; }
      const i = { id: uid(), name, category: "", base: BAR ? "L" : "kg", yield: 1, notes: "", review: "" };
      await write(() => insert("ingredients", i));
      location.hash = "#/ingredient/" + i.id;
    },
    async merge(el) {
      const from = get("ingredients", el.dataset.id);
      let into = el.dataset.into && get("ingredients", el.dataset.into);
      if (!into) {
        const name = await ask(`Merge "${from.name}" into which ingredient? Type its name and pick it.`, { ok: "Next", input: true, placeholder: "e.g. Huile, Olive", list: "dl-ingredients" });
        if (!name) return;
        into = data.ingredients.find((x) => x.id !== from.id && x.name.toLowerCase() === name.toLowerCase());
        if (!into) { toast(`No ingredient called "${name}".`, true); return; }
      }
      const n = { prices: data.offers.filter((o) => o.ingredient_id === from.id).length, lines: data.lines.filter((l) => l.ingredient_id === from.id).length, counts: data.counts.filter((c) => c.ingredient_id === from.id).length };
      const unitWarn = from.base !== into.base && data.offers.some((o) => o.ingredient_id === from.id) ? ` Careful: "${from.name}" is priced per ${from.base} and "${into.name}" per ${into.base}, so its recipe lines may need a new unit.` : "";
      if (!(await ask(`Merge "${from.name}" into "${into.name}"? Its ${n.prices} price(s), ${n.lines} recipe line(s) and ${n.counts} count(s) move to "${into.name}", then "${from.name}" is removed. You can undo it.${unitWarn}`, { ok: "Merge" }))) return;
      const entry = await mergeIngredient(from, into);
      if (!write.failed) { location.hash = "#/ingredient/" + encodeURIComponent(into.id); toast(`Merged into ${into.name}.`, false, undoFor(entry)); }
    },
    async "delete-ingredient"(el) {
      const i = get("ingredients", el.dataset.id);
      if (!(await ask(`Delete "${i.name}" and its prices? You can put it back from Settings → Recently deleted.`, { ok: "Delete", danger: true }))) return;
      const entry = toTrash(i.name, "ingredient", {
        ingredients: [{ ...i }],
        offers: data.offers.filter((o) => o.ingredient_id === i.id).map((o) => ({ ...o })),
        price_history: data.price_history.filter((h) => h.ingredient_id === i.id).map((h) => ({ ...h })),
        counts: data.counts.filter((c) => c.ingredient_id === i.id).map((c) => ({ ...c })),
      });
      await write(async () => {
        await patch("ingredients", i.id, { preferred_offer_id: null });
        await removeRows("price_history", data.price_history.filter((h) => h.ingredient_id === i.id).map((h) => h.id));
        await removeRows("offers", data.offers.filter((o) => o.ingredient_id === i.id).map((o) => o.id));
        await removeRows("counts", data.counts.filter((c) => c.ingredient_id === i.id).map((c) => c.id));
        await removeRows("ingredients", i.id);
      });
      location.hash = "#/ingredients";
      if (!write.failed) toast(`Deleted "${i.name}".`, false, undoFor(entry));
    },
    async "import-file"(el) {
      const file = el.files && el.files[0];
      if (!file) return;
      if (ACCOUNT) { toast("Importing sheets replaces a whole account: only its owner can, from their own account.", true); return; }
      let seed;
      try { seed = JSON.parse(await file.text()); } catch { toast("That file isn't a backup or seed.json.", true); return; }
      if (!Store.TABLES.every((t) => Array.isArray(seed[t]))) { toast("That file is missing some tables.", true); return; }
      // Replacing the kitchen's items would pull them out from under Barback's cocktails.
      const linked = Store.borrowed().lines.filter((l) => get("ingredients", l.ingredient_id) || get("recipes", l.sub_recipe_id)).length;
      if (linked) { toast(`Barback's cocktails use ${linked} of the items and preps here. Take them out there first, then import.`, true); return; }
      if (!(await ask(`Replace everything ${store.kind === "supabase" ? "in Supabase" : "in this browser"} with ${seed.ingredients.length} ingredients and ${seed.recipes.length} recipes from ${file.name}?`, { ok: "Replace everything", danger: true }))) { el.value = ""; return; }
      const shaped = Object.fromEntries(Store.TABLES.map((t) => [t, seed[t].map((r) => Store.shape(t, r))]));
      toast("Importing…");
      await write(async () => { await store.replaceAll(shaped); data = await store.loadAll(); });
      if (!write.failed) toast(`Imported ${data.ingredients.length} ingredients and ${data.recipes.length} recipes.`);
    },
    async "import-extra"(el) {
      const file = el.files && el.files[0];
      if (!file) return;
      let x;
      try { x = JSON.parse(await file.text()); } catch { toast("That file isn't JSON.", true); return; }
      el.value = "";
      if (Store.schemaOld()) { toast("Run the updated supabase/schema.sql in Supabase first.", true); return; }
      if (x && Array.isArray(x.on_list) && Array.isArray(x.counts)) {
        // Items counted in the inventory but missing from Master Data come in as new ingredients. If one was already
        // added (by an earlier import of this kind), its counts and place on the list go to the one that's there.
        const sameId = new Map();
        for (const n of x.new_items || []) {
          const there = data.ingredients.find((i) => i.name.toLowerCase() === n.ingredient.name.toLowerCase());
          if (there && there.id !== n.ingredient.id) sameId.set(n.ingredient.id, there.id);
        }
        const idOf = (id) => sameId.get(id) || id;
        x.counts = x.counts.map((c) => ({ ...c, ingredient_id: idOf(c.ingredient_id) }));
        const on = new Set(x.on_list.map(idOf));
        const fresh = (x.new_items || []).filter((n) => !sameId.has(n.ingredient.id) && !get("ingredients", n.ingredient.id));
        const have = new Set(data.ingredients.map((i) => i.id).concat(fresh.map((n) => n.ingredient.id)));
        // One count per item per month: two rows for the same item in a file are added together.
        const merged = new Map();
        for (const c of x.counts) {
          const k = c.month + "|" + c.ingredient_id;
          if (merged.has(k)) merged.get(k).qty = (parseNum(merged.get(k).qty) || 0) + (parseNum(c.qty) || 0); else merged.set(k, { ...c });
        }
        const counts = [...merged.values()].filter((c) => have.has(c.ingredient_id) && !data.counts.some((d) => d.month === c.month && d.ingredient_id === c.ingredient_id));
        const fixes = (x.pack_fixes || []).filter((f) => { const o = get("offers", f.offer_id); return o && !(+o.pack_qty === +f.pack_qty && o.pack_unit === f.pack_unit); });
        const offList = data.ingredients.filter((i) => !on.has(i.id)).length;
        if (!(await ask(`From ${x.tab || x.month}: add ${fresh.length} ingredients that were only in the inventory, put ${on.size} on the monthly count (${offList} others stay in the app but off the count), add ${counts.length} stock counts${fixes.length ? `, and take ${fixes.length} pack sizes from the inventory sheet (${fixes.map((f) => f.ingredient).join(", ")})` : ""}?`, { ok: "Import" }))) return;
        await write(async () => {
          for (const n of fresh) {
            await insert("ingredients", { ...n.ingredient, preferred_offer_id: null });
            if (n.offer) {
              const o = await insert("offers", n.offer);
              await logPrice(o, "Inventory sheet");
              await patch("ingredients", n.ingredient.id, { preferred_offer_id: o.id });
            }
          }
          const rows = data.ingredients.map((i) => ({ ...i, in_inventory: on.has(i.id) }));
          await store.upsert("ingredients", rows.map((r) => Store.shape("ingredients", r)));
          data.ingredients = rows;
          for (const f of fixes) {
            const o = get("offers", f.offer_id);
            await patch("offers", o.id, { pack_qty: f.pack_qty, pack_unit: f.pack_unit });
            await logPrice(o, "Pack size from the inventory sheet");
            const ing = get("ingredients", o.ingredient_id);
            await patch("ingredients", ing.id, { review: `Pack size changed from ${f.was} to ${f.pack_qty} ${f.pack_unit} (from the inventory sheet). Check it.` });
          }
          const shaped = counts.map((c) => Store.shape("counts", c));
          if (shaped.length) await store.insert("counts", shaped);
          data.counts.push(...shaped);
        });
        if (!write.failed) toast(`Done: ${fresh.length} new ingredients, ${on.size} on the count, ${counts.length} stock counts added.`);
      } else if (Array.isArray(x) && x.every((c) => c.recipe_id && "method" in c)) {
        const list = x.filter((c) => get("recipes", c.recipe_id));
        if (!(await ask(`Add Ready in and Preparation steps to ${list.length} recipes? Notes are only filled where a recipe has none.`, { ok: "Import" }))) return;
        await write(async () => {
          const rows = list.map((c) => { const r = get("recipes", c.recipe_id); return { ...r, ready_in: c.ready_in || r.ready_in || "", method: c.method || r.method || "", notes: r.notes || c.notes || "" }; });
          await store.upsert("recipes", rows.map((r) => Store.shape("recipes", r)));
          for (const r of rows) Object.assign(get("recipes", r.id), r);
        });
        if (!write.failed) toast(`Done: ${list.length} recipes have their card text.`);
      } else toast("That isn't an inventory-import.json or cards-import.json file.", true);
    },
    export() {
      const blob = new Blob([JSON.stringify({ app: "kitchen-costing", version: 1, exported_at: new Date().toISOString(), ...data })], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${BAR ? "barback" : "kitchen-costing"}-backup-${today()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    },
    async "clear-local"() {
      if (!(await ask("Delete all the data saved in this browser?", { ok: "Delete", danger: true }))) return;
      await write(async () => { await Store.local.replaceAll({}); data = await store.loadAll(); });
    },
    async "sign-out"() { Auth.signOut(); await start(); },
    async "month-close"(el) {
      const month = el.dataset.month, label = monthLabel(month);
      if (Store.part17Old()) { toast("Run part 17 of supabase/schema.sql in Supabase (SQL Editor) to close a month.", true); return render(); }
      if (closedMonth(month)) return render();
      const rows = liveRows(month), counted = rows.filter((r) => r.qty != null);
      if (!counted.length) { toast(`Nothing has been counted for ${label} yet.`, true); return; }
      const saved = (settings.categories || {}).groups || {};
      const shape = (list) => list.map((r) => ({ section: section(r.item), value: r.value, counted: r.qty != null }));
      const missed = Summary.build(shape(rows), shape(inventoryRows(shiftMonth(month, -1))), saved).notCounted;
      const noValue = counted.filter((r) => r.problem || r.price == null).length;
      const record = Summary.freeze(rows, { sectionOf: (r) => section(r.item), cellsOf: sheetCells, saved });
      const notes = [
        `${counted.length} items, worth ${money(record.total)}. These become the record for ${label}: amounts, today's prices and values stay exactly as they are, whatever changes later.`,
        missed.length ? `Nothing was counted in: ${missed.join(", ")}.` : "",
        noValue ? `${noValue} counted item${noValue === 1 ? " has" : "s have"} no price or no value, so ${noValue === 1 ? "it counts" : "they count"} as $0.00.` : "",
      ].filter(Boolean).join("\n\n");
      if (!(await ask(`Close ${label}?\n\n${notes}`, { ok: "Close the month" }))) return;
      await write(() => insert("closed_months", { id: uid(), month, closed_at: new Date().toISOString(), reopened_at: null, source: "", ...record }));
      if (!write.failed) toast(`${label} is closed: ${money(record.total)} is on record.`);
    },
    async "month-reopen"(el) {
      const month = el.dataset.month, c = closedMonth(month), label = monthLabel(month);
      if (!c) return render();
      if (!(await ask(`Reopen ${label}?\n\nIt goes back to following today's prices until you close it again, so ${money(+c.total)} may change. The version you closed stays saved in the background.`, { ok: "Reopen", danger: true }))) return;
      await write(() => patch("closed_months", c.id, { reopened_at: new Date().toISOString() }));
    },
    async count(el) {
      const month = el.dataset.month, ingId = el.dataset.id, isPrep = el.dataset.kind === "prep";
      if (closedMonth(month)) { toast(`${monthLabel(month)} is closed. Reopen it to change a count.`, true); return render(); }
      const same = el.value.trim() === "=" && el.dataset.last != null;
      const typed = same ? parseNum(el.dataset.last) : parseNum(el.value);
      if (el.value.trim() && typed == null) { toast("Stock must be a number.", true); return render(); }
      const field = isPrep ? "recipe_id" : "ingredient_id";
      if (field === "recipe_id" && Store.part5Old()) { toast("Run the updated supabase/schema.sql (part 5) in Supabase to count preps.", true); return render(); }
      const row = data.counts.find((c) => c.month === month && c[field] === ingId);
      const x = get(isPrep ? "recipes" : "ingredients", ingId);
      const unit = (same && el.dataset.lastUnit) || el.dataset.unit || (isPrep ? x.yield_unit : x.base);
      // Counting by weight with a container: the number is what the scale shows, and the container comes off.
      // Last month's amount ("=" or Same) is already without it.
      const key = (isPrep ? "r:" : "") + ingId, tare = unit === "kg" && parseNum(x.container_kg) > 0 ? parseNum(x.container_kg) : null;
      const containers = row && row.containers != null ? parseNum(row.containers) : pendingContainers.has(key) ? pendingContainers.get(key) : 1;
      let qty = typed;
      if (tare && typed != null && !same) {
        qty = Costing.netWeight(typed, containers, tare);
        if (qty == null) { toast(`${typed} kg is lighter than the container (${gramsText(containers * tare)}). Type what the scale shows with the container on, or set the containers to 0.`, true); return render(); }
      }
      // Barback, a bottle with its weights: this box is the full bottles, and what's on the scale adds to them.
      let madeUp = BAR && !isPrep ? { full_bottles: null, open_g: null } : {};
      if (BAR && !isPrep && unit === "bottle" && Barback.canWeigh(x)) {
        if (same) {
          const was = data.counts.find((c) => c.month === shiftMonth(month, -1) && c.ingredient_id === ingId);
          madeUp = { full_bottles: was && was.full_bottles != null ? was.full_bottles : null, open_g: (was && was.open_g) || null };
        } else {
          const opened = (row && row.open_g) || "", sum = Barback.hybridCount(typed, opened, x.empty_g, x.full_g);
          if (sum.problem) { toast(sum.problem, true); return render(); }
          qty = typed == null && !opened ? null : sum.qty;
          madeUp = { full_bottles: typed, open_g: opened || null };
        }
      }
      const fields = Store.part16Old() ? { qty } : { qty, unit, containers: tare ? containers : null, ...madeUp };
      await write(async () => {
        if (qty == null) { if (row) await removeRows("counts", row.id); }
        else if (row) await patch("counts", row.id, fields);
        else await insert("counts", { id: uid(), month, [field]: ingId, ...fields });
      });
    },
    // Barback: what the opened bottles weigh, added to the full ones. "840", or "840+700" for two.
    async "count-open"(el) {
      const month = el.dataset.month, id = el.dataset.id;
      if (closedMonth(month)) { toast(`${monthLabel(month)} is closed. Reopen it to change a count.`, true); return render(); }
      const x = get("ingredients", id), row = data.counts.find((c) => c.month === month && c.ingredient_id === id);
      const opened = el.value.trim();
      // A count made before the weights were saved: its whole bottles are the full ones.
      const full = !row ? null : row.full_bottles != null ? parseNum(row.full_bottles) : row.open_g ? null : Math.floor(parseNum(row.qty) || 0);
      if (!opened && full == null) { if (row) await write(() => removeRows("counts", row.id)); return; }
      const sum = Barback.hybridCount(full, opened, x.empty_g, x.full_g);
      if (sum.problem) { toast(sum.problem, true); return render(); }
      const fields = { qty: sum.qty, unit: "bottle", containers: null, full_bottles: full, open_g: opened || null };
      await write(async () => {
        if (row) await patch("counts", row.id, fields);
        else await insert("counts", { id: uid(), month, ingredient_id: id, ...fields });
      });
    },
    // A bottle's size and weights, on its page.
    async "bottle-field"(el) {
      const i = get("ingredients", el.dataset.id), f = el.dataset.field, text = el.value.trim(), v = text ? parseNum(text) : null;
      if (text && !(v > 0)) { toast("That needs a number above zero, or leave it empty.", true); return render(); }
      await write(() => patch("ingredients", i.id, f === "size" ? { measures: Barback.withBottleSize(i, v) } : { [f]: v }));
    },
    "open-in-kitchen"(el) { switchProject("kitchen", `#/${el.dataset.page}/${encodeURIComponent(el.dataset.id)}`); },
    // People in an account.
    async "person-invite"() {
      const email = $("#inviteEmail").value.trim().toLowerCase(), kitchen = $("#inviteKitchen").checked, bar = $("#inviteBarback"), barback = !!(bar && bar.checked);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return toast("Type their email address.", true);
      if (email === String(Auth.email()).toLowerCase()) return toast("That's you: you already have this account.", true);
      if (people.some((m) => m.email === email)) return toast("They're already on the list.", true);
      if (!kitchen && !barback) return toast(`Pick ${SITE.name}, Barback or both.`, true);
      const row = { account_id: Store.account(), email, role: $("#inviteRole").value, kitchen, barback, can_count: $("#inviteCount").checked, account_name: (ACCOUNT && ACCOUNT.name) || Auth.restaurant() || Auth.email() };
      await write(async () => { await store.invite(row); people = await store.people(Store.account()); });
      if (!write.failed) toast(`Done. Let ${email} know: they'll see it when they sign in or sign up with that email.`);
    },
    async "person-field"(el) {
      const m = people.find((x) => x.email === el.dataset.email), f = el.dataset.field, v = el.type === "checkbox" ? el.checked : el.value;
      if (!m) return render();
      const next = { ...m, [f]: v };
      if (!next.kitchen && !next.barback) { toast(`They need ${SITE.name}, Barback or both. To take away all access, press ×.`, true); return render(); }
      await write(async () => { await store.changePerson(Store.account(), m.email, { [f]: v }); people = await store.people(Store.account()); });
    },
    async "person-remove"(el) {
      const email = el.dataset.email;
      if (!(await ask(`Take away ${email}'s access to this account? What they made here stays here, and their own account isn't touched.`, { ok: "Remove", danger: true }))) return;
      await write(async () => { await store.removePerson(Store.account(), email); people = await store.people(Store.account()); });
    },
    async "leave-account"() {
      if (!(await ask(`Leave ${ACCOUNT.name || "this account"}? Your own account isn't touched. What you made here stays here, and you won't see it any more.`, { ok: "Leave", danger: true }))) return;
      try { await store.removePerson(ACCOUNT.id, ACCOUNT.email); await goTo(Store.me()); toast("You've left. This is your own account."); }
      catch (e) { toast(e.message, true); }
    },
    // Bringing recipes in from another account.
    async "bring-from"(el) {
      bring.from = el.value || null; bring.rows = null; bring.recipes.clear(); bring.items.clear();
      if (!bring.from) return render();
      if (!bringSources().some((s) => s.id === bring.from)) { bring.from = null; return render(); }
      try { bring.rows = await store.readAccount(bring.from); } catch (e) { toast(e.message, true); }
      render();
    },
    "bring-pick"(el) { const set = bring[el.dataset.kind]; if (el.checked) set.add(el.dataset.id); else set.delete(el.dataset.id); render(); },
    async "bring-go"() {
      if (!bring.rows || !bringSources().some((s) => s.id === bring.from)) return;
      const estimate = isEmployee();
      const p = Transfer.plan({ source: bring.rows, target: BAR ? withKitchen() : data, picked: { recipes: [...bring.recipes], items: [...bring.items] }, newId: uid, estimate, note: estimateNote() });
      const same = p.matchedItems.length + p.matchedPreps.length;
      if (!(await ask(`Bring in ${p.recipes.length} recipe(s) and ${p.ingredients.length} new item(s)?${same ? ` ${same} already here will be used as they are.` : ""}${estimate && p.ingredients.length ? " The new items' prices stay as estimates until an administrator checks them." : ""}`, { ok: "Import" }))) return;
      await write(async () => {
        const many = async (table, rows) => { if (rows.length) await store.insert(table, rows.map((r) => Store.shape(table, stamp(table, r)))); };
        await many("ingredients", p.ingredients);
        await many("recipes", p.recipes);
        await many("offers", p.offers);
        await many("lines", p.lines);
        for (const l of p.later) await store.update(l.table, l.id, l.changes);
        data = await store.loadAll();
        rebuild();
        // What they cost today is where their price alerts start from.
        for (const r of p.recipes) await patch("recipes", r.id, { ack_cost: Math.round(coster.recipeCost(r.id).perYield * 10000) / 10000 });
      });
      if (write.failed) return;
      bring.from = null; bring.rows = null; bring.recipes.clear(); bring.items.clear();
      toast(`Imported ${p.recipes.length} recipe(s) and ${p.ingredients.length} item(s).${p.renamed.length ? ` ${p.renamed.length} got "(imported)" added to the name, because one by that name was already here.` : ""}`);
      location.hash = p.recipes.length ? "#/dishes" : "#/ingredients";
    },
    // The unit picked beside a count box: remembered for the item. A number already there is turned into it, so what's
    // in stock and its value stay as they were.
    async "count-unit"(el) {
      const month = el.dataset.month, id = el.dataset.id, isPrep = el.dataset.kind === "prep", unit = el.value;
      if (closedMonth(month)) return render();
      if (Store.part16Old()) { toast(PART16_NOTE, true); return render(); }
      const table = isPrep ? "recipes" : "ingredients", field = isPrep ? "recipe_id" : "ingredient_id", x = get(table, id);
      if (!x) return render();
      const it = isPrep ? { kind: "prep", base: x.yield_unit, recipe: x } : { kind: "ingredient", base: x.base, ing: x };
      const row = data.counts.find((c) => c.month === month && c[field] === id), qty = row ? parseNum(row.qty) : null;
      const priced = qty == null ? null : pricedAmount(it, qty, row.unit || it.base), one = pricedAmount(it, 1, unit);
      await write(async () => {
        // Barback keeps a pick of the priced unit too: left empty, a bottle goes back to being counted in bottles.
        if (isAdmin()) await patch(table, id, { count_unit: unit === it.base && !BAR ? null : unit });
        if (priced != null && one) await patch("counts", row.id, { qty: +(priced / one).toFixed(6), unit });
      });
    },
    // How many containers are on the scale. The scale's number stays; what's left after them changes.
    async "count-containers"(el) {
      const month = el.dataset.month, id = el.dataset.id, isPrep = el.dataset.kind === "prep";
      if (closedMonth(month)) return render();
      const field = isPrep ? "recipe_id" : "ingredient_id", x = get(isPrep ? "recipes" : "ingredients", id);
      const text = el.value.trim(), n = text ? parseNum(text) : 1;
      if (n == null || n < 0) { toast("Containers on the scale: a number, or left empty for one.", true); return render(); }
      const key = (isPrep ? "r:" : "") + id, row = data.counts.find((c) => c.month === month && c[field] === id);
      const tare = parseNum(x && x.container_kg) || 0;
      if (!row || parseNum(row.qty) == null) { pendingContainers.set(key, n); return render(); }
      const was = row.containers != null ? parseNum(row.containers) : 1, qty = Costing.netWeight(parseNum(row.qty) + was * tare, n, tare);
      if (qty == null) { toast(`That's more containers than the scale's number holds (${gramsText(n * tare)}).`, true); return render(); }
      await write(() => patch("counts", row.id, { qty, containers: n }));
    },
    async "count-same"(el) {
      // Same as typing "=" in the box: last month's amount, in the unit it can be kept in.
      await actions.count({ dataset: { ...el.dataset, last: el.dataset.qty }, value: "=" });
      const next = main.querySelector(`[data-k="cnt-${CSS.escape(el.dataset.id)}"]`);
      if (next) next.focus();
    },
    "inv-print"() { window.print(); },
    "sum-toggle"(el) {
      if (summaryOpen.has(el.dataset.key)) summaryOpen.delete(el.dataset.key); else summaryOpen.add(el.dataset.key);
      render.nextFocus = null;
      render();
      const again = main.querySelector(`[data-act="sum-toggle"][data-key="${CSS.escape(el.dataset.key)}"]`);
      if (again) again.focus();
    },
    // A month's food purchases or sales: a number or nothing, saved with the account.
    async "sum-month"(el) {
      const text = el.value.trim(), v = Summary.parseAmount(text), month = el.dataset.month, f = el.dataset.field;
      if (text && v == null) { toast("That has to be an amount, like 12000 or 12 000, or left empty.", true); return render(); }
      const months = settings.stockMonths || {};
      await write(() => saveSettings({ ...settings, stockMonths: { ...months, [month]: { ...(months[month] || {}), [f]: text ? v : null } } }));
    },
    async "sum-group"(el) {
      const cats = settings.categories || {};
      await write(() => saveSettings({ ...settings, categories: { ...cats, groups: { ...(cats.groups || {}), [el.dataset.name]: el.value } } }));
    },
    async "inv-sheet"(el) {
      const month = el.dataset.month, title = monthLabel(month);
      const sheet = settings.drive.sheet;
      try {
        if (!GDrive.connected()) await GDrive.connect();
        const tabs = (await GDrive.sheetTabs(sheet.id)).map((t) => t.title);
        if (tabs.includes(title) && !(await ask(`"${title}" is already in ${sheet.name}. Replace that tab with this count?`, { ok: "Replace tab", danger: true }))) return;
        // Last month's tab for the comparison column: its usual name, else the newest other tab.
        const prevTab = tabs.includes(monthLabel(shiftMonth(month, -1))) ? monthLabel(shiftMonth(month, -1)) : tabs.find((t) => t !== title && MONTHS.some((m) => t.startsWith(m)));
        toast("Sending…");
        // Made like you'd make it by hand: a copy of last month's tab, filled in with this month.
        if (prevTab) {
          const { rows, looks } = inventorySheet(month, prevTab, await GDrive.readColumn(sheet.id, prevTab, "A"));
          await GDrive.writeTabLike(sheet.id, title, rows, prevTab, looks);
        } else await GDrive.writeTab(sheet.id, title, inventorySheetRows(month, null));
        toast(`Sent: "${title}" is now the first tab of ${sheet.name}.`);
      } catch (e) { toast(e.message, true); }
    },
    // No Google Drive here (Commis): the card as a Word file, in the plain layout.
    async "download-card"(el) {
      const r = get("recipes", el.dataset.id);
      try {
        saveBlob(`${MenuFile.fileName(r.name)}.docx`, await MenuFile.cardDocx(cardData(r)));
        toast(`Downloaded the card for “${r.name}”.`);
      } catch (e) { toast(e.message, true); }
    },
    async "save-card"(el) {
      const r = get("recipes", el.dataset.id);
      try {
        if (!GDrive.connected()) await GDrive.connect();
        toast("Saving the card…");
        let doc;
        await write(async () => { doc = await saveCard(r, await cardTemplate()); });
        if (!write.failed) toast(`Saved "${doc.name}" in Recipe cards (${SITE.app}).`, false, { label: "Open", run: () => window.open(cardUrl(doc.id), "_blank", "noopener") });
      } catch (e) { toast(e.message, true); }
    },
    async "save-all-cards"() {
      const list = data.recipes.filter((r) => String(r.method || "").trim()).sort(byName);
      if (!(await ask(`Save ${list.length} recipe cards (every recipe with Preparation steps) to Drive? Cards already there are updated.`, { ok: "Save cards" }))) return;
      try {
        if (!GDrive.connected()) await GDrive.connect();
        let n = 0;
        const tpl = await cardTemplate();
        for (const r of list) { await saveCard(r, tpl); n++; if (n % 5 === 0) toast(`Saved ${n} of ${list.length}…`); }
        toast(`Saved ${n} recipe cards.`);
      } catch (e) { toast(e.message, true); }
      rebuild();
      render();
    },
    async lock(el) { await setLock(el.dataset.kind, el.dataset.id, "today"); },
    async unlock(el) { await setLock(el.dataset.kind, el.dataset.id, null); },
    async "lock-field"(el) {
      const v = parseNum(el.value);
      if (v == null || v < 0) { toast("Type the price to keep, or press Unlock.", true); return render(); }
      await setLock(el.dataset.kind, el.dataset.id, v);
    },
    async "download-sheet"(el) {
      const r = get("recipes", el.dataset.id);
      try {
        const t = settings.drive && settings.drive.costsheet;
        if (!t) { toast("Pick your recipe cost template first (Settings → Google Drive).", true); return; }
        if (!GDrive.connected()) await GDrive.connect();
        toast("Making the costing sheet…");
        const { bytes } = await GDrive.excelOf(t.id);
        const name = r.name.replace(/[\\/:*?"<>|]+/g, "-") + ".xlsx";
        saveBlob(name, await SheetFill.xlsx(bytes, costSheetData(r)));
        toast(`Downloaded "${name}", laid out like your costing sheets.`);
      } catch (e) { toast(e.message, true); }
    },
    async "g-connect"() {
      try { await GDrive.connect(); toast("Google Drive connected."); } catch (e) { toast(e.message, true); }
      render();
    },
    async "g-pick"(el) {
      try {
        const kind = el.dataset.kind;
        const picked = await GDrive.pick(kind);
        if (!picked) return;
        await saveSettings({ ...settings, drive: { ...(settings.drive || {}), [kind]: picked } });
        toast(`${{ folder: "Recipe cards folder", sheet: "Inventory sheet", master: "Master Data sheet", template: "Recipe card template", costsheet: "Recipe cost template" }[kind]}: ${picked.name}`);
      } catch (e) { toast(e.message, true); }
      render();
    },
    async "g-test"() {
      try {
        const f = settings.drive.folder;
        const doc = await GDrive.saveDoc({ name: "Kitchen Costing test", folderId: f.id,
          html: `<h1>It works</h1><p>Kitchen Costing can write to “${esc(f.name)}”. You can delete this page.</p>` });
        toast(`Made "${doc.name}" in ${f.name}.`);
        if (doc.webViewLink) window.open(doc.webViewLink, "_blank", "noopener");
      } catch (e) { toast(e.message, true); }
    },
  };
  const round4 = (v) => Math.round(v * 10000) / 10000;

  /** After you edit a recipe yourself, its current cost becomes the "last seen" one: alerts are for price
   * moves, not for your own changes. Recipes that use it still get flagged. */
  async function settle(recipeId) {
    coster = Costing.create(BAR ? withKitchen() : data);
    const cost = round4(coster.recipeCost(recipeId).perYield);
    const r = get("recipes", recipeId);
    if (r && r.ack_cost !== cost) await patch("recipes", recipeId, { ack_cost: cost });
  }

  // Text fields save when you leave them (or press Enter); selects, radios and files save right away.
  // A field's draft is dropped only once its save went through.
  main.addEventListener("change", async (e) => {
    const el = e.target.closest("[data-act]");
    if (!el || !actions[el.dataset.act]) return;
    if (isEmployee() && !employeeMay(el.dataset.act, el)) return render();
    const key = draftable(el) ? draftKey(el) : null;
    write.failed = false;
    if (key) saving.add(key);
    try { await actions[el.dataset.act](el); }
    finally { if (key) saving.delete(key); }
    if (key && !write.failed) dropDraft(key);
    // The save didn't go through: now it's worth offering to put the text back.
    else if (key) showDrafts();
  });
  main.addEventListener("input", (e) => { if (draftable(e.target)) keepDraft(e.target); });
  main.addEventListener("toggle", (e) => { if (e.target.matches && e.target.matches("details[data-k]")) detailsOpen.set(e.target.dataset.k, e.target.open); }, true);
  // Leaving the page with a field still being typed in: browsers ask first (the draft is kept either way).
  window.addEventListener("beforeunload", (e) => {
    const el = document.activeElement;
    if (draftable(el) && el.value !== el.defaultValue) { e.preventDefault(); e.returnValue = ""; }
  });
  // Invoices dropped on the drop area are read like chosen ones. A file dropped anywhere else is ignored
  // (instead of the browser opening it and leaving the app).
  main.addEventListener("dragover", (e) => { const z = e.target.closest("[data-drop]"); if (z) z.classList.add("drop--over"); });
  main.addEventListener("dragleave", (e) => { const z = e.target.closest("[data-drop]"); if (z && !z.contains(e.relatedTarget)) z.classList.remove("drop--over"); });
  window.addEventListener("dragover", (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) e.preventDefault(); });
  window.addEventListener("drop", (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    const z = e.target.closest && e.target.closest("[data-drop]");
    if (!z) return;
    z.classList.remove("drop--over");
    const files = [...e.dataTransfer.files].filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
    if (files.length) actions["inv-files"]({ files, value: "" });
    else toast("Only PDF invoices can be read.", true);
  });
  main.addEventListener("click", (e) => {
    if (e.target.closest(".btn--back")) render.goingBack = true;
    const el = e.target.closest("button[data-act]");
    if (el && isEmployee() && !employeeMay(el.dataset.act, el)) return;
    if (el && actions[el.dataset.act]) { e.preventDefault(); write.failed = false; actions[el.dataset.act](el); }
  });
  /* ---------- moving a recipe line ---------- */
  // Grab its dots with a mouse or a finger and the row follows. The arrow keys on the dots do the same, one place at a time.
  const lineIds = (body) => [...body.querySelectorAll("tr[data-line]")].map((x) => x.dataset.line);
  async function saveLineOrder(ids) {
    write.failed = false;
    await write(async () => {
      for (const [k, id] of ids.entries()) {
        const l = get("lines", id);
        if (l && l.pos !== k + 1) await patch("lines", id, { pos: k + 1 });
      }
    });
  }
  let lineDrag = null;
  function placeDraggedLine() {
    const d = lineDrag;
    if (!d || !d.row.isConnected) return;
    const next = [...d.body.querySelectorAll("tr[data-line]")].filter((x) => x !== d.row).find((x) => { const b = x.getBoundingClientRect(); return d.y < b.top + b.height / 2; });
    const before = next || d.body.querySelector("tr.addrow");
    if (d.row.nextElementSibling !== before) d.body.insertBefore(d.row, before);
  }
  // Near the top or bottom of the screen the page scrolls, so a line can go anywhere in a long recipe.
  function scrollWhileDragging() {
    if (!lineDrag) return;
    const edge = 70, y = lineDrag.y, h = window.innerHeight;
    const step = y < edge ? (y - edge) / 4 : y > h - edge ? (y - (h - edge)) / 4 : 0;
    if (step) { window.scrollBy(0, step); placeDraggedLine(); }
    requestAnimationFrame(scrollWhileDragging);
  }
  function endLineDrag(keep) {
    const d = lineDrag;
    if (!d) return;
    lineDrag = null;
    d.row.classList.remove("is-dragging");
    document.body.classList.remove("dragging-line");
    if (!d.row.isConnected) return;
    if (!keep) return render();
    const ids = lineIds(d.body);
    if (ids.join() !== d.from.join()) saveLineOrder(ids);
  }
  main.addEventListener("pointerdown", (e) => {
    const handle = e.target.closest("[data-drag-line]");
    if (!handle || e.button !== 0) return;
    // No focus change: leaving a box mid-typing would save and redraw the page under the drag.
    e.preventDefault();
    const row = handle.closest("tr"), body = row.parentElement;
    lineDrag = { row, body, y: e.clientY, from: lineIds(body) };
    try { handle.setPointerCapture(e.pointerId); } catch { /* it still works while the pointer stays on the page */ }
    row.classList.add("is-dragging");
    document.body.classList.add("dragging-line");
    requestAnimationFrame(scrollWhileDragging);
  });
  main.addEventListener("pointermove", (e) => { if (lineDrag) { lineDrag.y = e.clientY; placeDraggedLine(); } });
  main.addEventListener("pointerup", () => endLineDrag(true));
  main.addEventListener("pointercancel", () => endLineDrag(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && lineDrag) endLineDrag(false); });
  main.addEventListener("keydown", (e) => {
    const handle = e.target.closest && e.target.closest("[data-drag-line]");
    if (!handle || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    const ids = lineIds(handle.closest("tbody")), i = ids.indexOf(handle.dataset.dragLine), j = i + (e.key === "ArrowUp" ? -1 : 1);
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    const name = lineName(get("lines", handle.dataset.dragLine));
    saveLineOrder(ids).then(() => { if (!write.failed) toast(`${name} moved ${e.key === "ArrowUp" ? "up" : "down"}.`); });
  });
  main.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches("input.in[data-act]")) {
      e.preventDefault();
      enterMove(e.target);
    }
  });
  main.addEventListener("submit", async (e) => {
    const form = e.target.closest("[data-form]");
    if (!form) return;
    e.preventDefault();
    const kind = form.dataset.form, email = form.email ? form.email.value.trim() : "";
    const button = form.querySelector("button");
    if (button) button.disabled = true;
    try {
      if (kind === "spend-add") {
        const amount = Summary.parseAmount(form.amount.value), date = form.date.value;
        if (amount == null) { toast("The amount has to be a number, like 120 or 1 250.50.", true); return; }
        if (!date) { toast("Which day? The date decides the month it counts in.", true); return; }
        const supplier = form.supplier.value.trim(), group = form.group.value;
        await write(() => insert("saved_invoices", { id: uid(), supplier, date, file: "", total: group === Summary.LEFT_OUT ? 0 : amount, lines: [{ item: supplier || "Purchase", total: amount, group, ing: null }], saved_at: new Date().toISOString() }));
        if (!write.failed) toast(`${money(amount)} added to ${monthLabel(date.slice(0, 7))}.`);
        return;
      }
      if (kind === "sign-in") {
        await Auth.signIn(email, form.password.value);
        authView.mode = "in";
        await start();
        toast("Signed in.");
      } else if (kind === "sign-up") {
        const { confirm } = await Auth.signUp(email, form.password.value, form.restaurant.value.trim(), { terms_accepted_at: new Date().toISOString(), terms_version: TERMS_VERSION, terms_language: "en" });
        if (confirm) Object.assign(authView, { mode: "sent", note: `We sent a link to ${email}. Open it to confirm your email, and you're in.` });
        await start();
      } else if (kind === "forgot") {
        await Auth.forgot(email);
        Object.assign(authView, { mode: "sent", note: `If there's an account for ${email}, a link to choose a new password is on its way.` });
        render();
      } else if (kind === "new-password") {
        await Auth.setPassword(form.password.value);
        authView.mode = "in";
        await start();
        toast("New password saved.");
      }
    } catch (err) { toast(err.message, true); if (button) button.disabled = false; }
  });
  main.addEventListener("click", (e) => {
    const b = e.target.closest("[data-auth]");
    if (b) {
      e.preventDefault();
      Object.assign(authView, { mode: b.dataset.auth, note: "" });
      render();
      // On a phone, the box is further down the homepage.
      const box = main.querySelector(".welcome__card");
      if (box) { box.scrollIntoView({ block: "nearest" }); const field = box.querySelector("input"); if (field) field.focus({ preventScroll: true }); }
    }
    // The homepage's language: the app itself is English for now.
    const pick = e.target.closest("[data-lang-pick]");
    if (pick) {
      document.documentElement.lang = document.documentElement.dataset.homeLang = pick.dataset.langPick;
      try { localStorage.setItem("commis.lang", pick.dataset.langPick); } catch { /* this visit only */ }
    }
  });

  /* ---------- a menu: its page, and its folder ---------- */
  // A menu is the dishes with the same Menu. Its page lists them with prices, costs and what's in them, and the preps
  // they use; its folder (a .zip download, or a folder in Drive) holds the menu list (Excel), the menu lists to print
  // (Word, kitchen and front of house), a recipe card for every dish and prep, and each dish's costing sheet.
  const menuDishList = (name) => data.recipes.filter((r) => r.kind === "dish" && (r.menu || "").trim() === name).sort(byCat);
  function menuModel(name) {
    const dishes = menuDishList(name), preps = new Map();
    const lineItem = (l) => (l.ingredient_id ? get("ingredients", l.ingredient_id) : get("recipes", l.sub_recipe_id));
    // The preps a recipe uses: directly, through another prep, or through an item made from a prep.
    function walk(rid, dish, seen = new Set()) {
      for (const l of data.lines.filter((x) => x.recipe_id === rid)) {
        const ing = l.ingredient_id && get("ingredients", l.ingredient_id);
        const pid = l.sub_recipe_id || (ing && ing.prep_id);
        const p = pid && get("recipes", pid);
        if (!p || seen.has(pid)) continue;
        seen.add(pid);
        if (!preps.has(pid)) preps.set(pid, { recipe: p, usedIn: new Set() });
        preps.get(pid).usedIn.add(dish.name);
        walk(pid, dish, seen);
      }
    }
    const rows = dishes.map((r) => {
      walk(r.id, r);
      const s = coster.summary(r.id);
      const contents = data.lines.filter((l) => l.recipe_id === r.id).sort((a, b) => a.pos - b.pos)
        .map((l) => { const it = lineItem(l); return it ? { name: it.name, amount: amountText(parseNum(l.qty), l.unit).trim() } : null; }).filter(Boolean);
      const a = allergensOf(r.id);
      return { recipe: r, name: r.name, category: dishCat(r) === NO_CAT ? "" : dishCat(r), price: s.menuPrice, cost: s.perPortion,
        foodCost: s.foodCost, target: s.suggested, contents, allergenInfo: a, allergens: allergenText(a) };
    });
    const prepRows = [...preps.values()].sort((a, b) => byName(a.recipe, b.recipe))
      .map((p) => ({ recipe: p.recipe, name: p.recipe.name, makes: cardData(p.recipe).yieldText, usedIn: [...p.usedIn] }));
    // Every item on the menu not checked for allergens yet, once, with the dishes it's in.
    const unchecked = new Map();
    for (const d of rows) for (const i of d.allergenInfo.unchecked) { if (!unchecked.has(i.id)) unchecked.set(i.id, { item: i, dishes: [] }); unchecked.get(i.id).dishes.push(d.name); }
    return { name, date: today(), dishes: rows, preps: prepRows, unchecked: [...unchecked.values()].sort((a, b) => byName(a.item, b.item)) };
  }
  // What to put in the folder (remembered on this device).
  const MENU_PICKS = "costing.menuPicks";
  const menuPicks = () => ({ list: true, print: true, details: true, cards: true, sheets: true, ...readJSON(MENU_PICKS, {}) });
  // The front-of-house template (Menu Item Details), kept with the app's files.
  let detailsTemplate = null;
  async function itemDetailsTemplate() {
    if (detailsTemplate) return detailsTemplate;
    const res = await fetch("templates/menu-item-details.docx").catch(() => null);
    if (!res || !res.ok) throw new Error("Couldn't load the menu item details template. Check your connection.");
    return (detailsTemplate = await res.arrayBuffer());
  }
  main.addEventListener("change", (e) => {
    const b = e.target.closest("[data-menu-pick]");
    if (b) writeJSON(MENU_PICKS, { ...readJSON(MENU_PICKS, {}), [b.dataset.menuPick]: b.checked });
  });
  function menuPage(name) {
    if (!name) return `<p class="empty">No menu picked. <a href="#/dishes">Back to dishes</a></p>`;
    const m = menuModel(name);
    if (!m.dishes.length) return `<p class="empty">No dishes on “${esc(name)}” any more. <a href="#/dishes">Back to dishes</a></p>`;
    const priced = m.dishes.filter((d) => d.foodCost != null);
    const avg = priced.length ? priced.reduce((s, d) => s + d.foodCost, 0) / priced.length : null;
    const d = settings.drive || {}, drive = GDrive.configured() && d.folder;
    const picks = menuPicks(), sheetsOk = GDrive.configured() && d.costsheet;
    const cardsFrom = GDrive.configured() && d.template ? `your template, “${esc(d.template.name)}”` : GDrive.configured() ? "a plain layout (no card template picked)" : "a plain layout";
    const pick = (k, label, sub, ok = true) => `<label class="check menu-pick${ok ? "" : " menu-pick--off"}"><input type="checkbox" data-menu-pick="${k}" ${picks[k] && ok ? "checked" : ""} ${ok ? "" : "disabled"} />
      <span><strong>${label}</strong> <span class="muted small">${sub}</span></span></label>`;
    return `
      <p class="crumbs"><a href="#/dishes">← Dishes</a></p>
      <div class="bar"><h1>${esc(name)}</h1></div>
      <p class="muted">${m.dishes.length} dish${m.dishes.length === 1 ? "" : "es"} · ${m.preps.length} prep${m.preps.length === 1 ? "" : "s"}${avg != null ? ` · average food cost ${pct(avg)}` : ""}${priced.length < m.dishes.length ? ` · ${m.dishes.length - priced.length} without a menu price` : ""}</p>
      <div class="table-wrap"><table class="list cards">
        <thead><tr><th>Dish</th><th>Category</th><th class="num">Menu price</th><th class="num">Cost / portion</th><th class="num">Food cost</th><th>Allergens</th><th>What's in it</th></tr></thead>
        <tbody>${m.dishes.map((x) => `<tr>
          <td><a href="#/recipe/${encodeURIComponent(x.recipe.id)}">${esc(x.name)}</a></td>
          <td>${esc(x.category) || `<span class="muted">—</span>`}</td>
          <td class="num">${x.price == null ? `<span class="muted">—</span>` : money(x.price)}</td>
          <td class="num">${money(x.cost, true)}</td>
          <td class="num">${x.foodCost == null ? `<span class="muted">—</span>` : `<span class="fc ${x.foodCost > 1 / (parseNum(x.recipe.multiplier) || 4) + 1e-9 ? "fc--over" : "fc--ok"}">${pct(x.foodCost)}</span>`}</td>
          <td class="small">${esc(allergenText(x.allergenInfo, false))}${x.allergenInfo.unchecked.length
            ? ` <span class="warn nowrap">${x.allergenInfo.unchecked.length} not checked</span>` : ""}</td>
          <td class="small">${esc(x.contents.map((c) => c.name).join(" · "))}</td></tr>`).join("")}</tbody>
      </table></div>
      ${m.unchecked.length ? `<section class="card unread"><h2>Not checked for allergens yet (${m.unchecked.length})</h2>
        <p class="hint">Open each one and tick what it contains (or “it contains none of these”). Until then the menu files say which items aren't checked.</p>
        <p class="unchecked-items">${m.unchecked.map((u) => `<a href="#/ingredient/${encodeURIComponent(u.item.id)}" title="In ${esc(u.dishes.join(" · "))}">${esc(u.item.name)}</a>`).join(" · ")}</p></section>` : ""}
      ${m.preps.length ? `<section class="card"><h2>Preps used</h2><ul class="menu-preps">${m.preps.map((p) => `<li><a href="#/recipe/${encodeURIComponent(p.recipe.id)}">${esc(p.name)}</a>
        <span class="muted small">makes ${esc(p.makes)} · in ${esc(p.usedIn.join(", "))}</span></li>`).join("")}</ul></section>` : ""}
      <section class="card menu-export">
        <h2>The menu's folder</h2>
        <p>Tick what goes in, then download it as a .zip${GDrive.configured() ? " or save it as a folder in Google Drive" : ""}. Tick just one to get only that.</p>
        <div class="menu-picks">
          ${pick("list", "Menu list (Excel)", "one workbook: Kitchen (prices, costs, what's in each dish with amounts), Front of house (price and what's in it), Preps")}
          ${pick("print", "Menu lists to print (Word)", "two documents: kitchen and front of house")}
          ${pick("details", "Menu item details (Word)", `${SITE.commis ? "for front of house" : "your front-of-house template"}, one entry per dish: name, price, ingredients and allergens filled in; substitutions, tasting notes and pairings left to write`)}
          ${pick("cards", "Recipe cards", `${m.dishes.length + m.preps.length}: every dish and prep, from ${cardsFrom}`)}
          ${GDrive.configured() ? pick("sheets", "Costing sheets (Excel)", sheetsOk ? `${m.dishes.length}: one per dish, from your recipe cost template` : "needs your recipe cost template (Settings → Google Drive)", !!sheetsOk) : ""}
        </div>
        <div class="actions">
          <button class="btn btn--main" data-act="menu-zip" data-menu="${esc(name)}">Download the folder (.zip)</button>
          ${drive ? `<button class="btn" data-act="menu-drive" data-menu="${esc(name)}">Save to Drive, in “${esc(d.folder.name)}”</button>` : ""}
        </div>
        ${GDrive.configured() && !drive ? `<p class="hint"><a href="#/settings">Pick your Drive folder</a> to save menus there too.</p>` : ""}
      </section>`;
  }
  /**
   * The folder's files, made from what's ticked: { files: [{ path, data, mime }], skipped: ["why", …] }. Cards and sheets
   * one at a time, saying how far it is. A card or sheet that can't be made (a dish with more preps than the cost
   * template has Recipe tabs) is left out and said why, instead of stopping the whole folder.
   */
  async function menuFiles(name, picks) {
    const m = menuModel(name), base = MenuFile.fileName(name), files = [], skipped = [], d = settings.drive || {};
    m.say = say; // the bar's words in Barback's files
    const say = (t) => toast(t);
    if (picks.list) files.push({ path: `${base} – menu list.xlsx`, data: await MenuFile.menuXlsx(m), mime: MenuFile.XLSX_TYPE });
    if (picks.print) {
      files.push({ path: `${base} – menu (front of house).docx`, data: await MenuFile.menuDocx(m, "front"), mime: MenuFile.DOCX_TYPE });
      files.push({ path: `${base} – menu (kitchen).docx`, data: await MenuFile.menuDocx(m, "kitchen"), mime: MenuFile.DOCX_TYPE });
    }
    if (picks.details) files.push({ path: `${base} – menu item details.docx`, data: await MenuFile.itemDetailsDocx(await itemDetailsTemplate(), m), mime: MenuFile.DOCX_TYPE });
    if (picks.cards) {
      const tpl = GDrive.configured() && d.template ? await cardTemplate() : null;
      const all = [...m.dishes.map((x) => ["Dishes", x.recipe]), ...m.preps.map((x) => ["Preps", x.recipe])];
      for (const [k, [kind, r]] of all.entries()) {
        if (k % 5 === 0) say(`Making the recipe cards: ${k + 1} of ${all.length}…`);
        const card = cardData(r);
        try {
          files.push({ path: `Recipe cards/${kind}/${MenuFile.fileName(r.name)}.docx`, data: tpl ? await CardFill.docx(tpl.bytes, card) : await MenuFile.cardDocx(card), mime: MenuFile.DOCX_TYPE });
        } catch (e) { skipped.push(`Recipe card for ${r.name}: ${e.message}`); }
      }
    }
    if (picks.sheets && GDrive.configured() && d.costsheet) {
      const { bytes } = await GDrive.excelOf(d.costsheet.id);
      for (const [k, x] of m.dishes.entries()) {
        if (k % 3 === 0) say(`Making the costing sheets: ${k + 1} of ${m.dishes.length}…`);
        try {
          files.push({ path: `Costing sheets/${MenuFile.fileName(x.name)}.xlsx`, data: await SheetFill.xlsx(bytes, costSheetData(x.recipe)), mime: MenuFile.XLSX_TYPE });
        } catch (e) { skipped.push(`Costing sheet for ${x.name}: ${e.message}`); }
      }
    }
    return { files, skipped };
  }
  /** "Downloaded …" or "Saved …", with what was left out (and why, one click away). */
  function menuDone(msg, skipped, open) {
    if (!skipped.length) return toast(msg, false, open);
    const why = `Left out of the folder:\n\n${skipped.join("\n")}`;
    toast(`${msg} ${skipped.length} left out.`, true, { label: "Why", run: async () => {
      if (!open) return ask(why, { ok: "OK" });
      if (await ask(why, { choices: [{ value: "open", label: "Open the folder", main: true }] })) open.run();
    } });
  }
  // The templates for cards and costing sheets come from Drive: connect first (it has to be straight from the click).
  const menuNeedsDrive = (picks) => GDrive.configured() && ((picks.cards && (settings.drive || {}).template) || (picks.sheets && (settings.drive || {}).costsheet));

  /* ---------- Commis: an optional tip ---------- */
  // One quiet link to our Ko-fi page. It unlocks nothing, and the payment happens over there.
  function supportBody() {
    return `<p>${esc(SITE.app)} is free for every restaurant: every feature, no limits. If it helps in your kitchen, you can say thanks.</p>
      <div class="support__options"><a class="btn btn--main" href="${esc(SITE.support)}" target="_blank" rel="noopener">Buy us a soda</a></div>
      <p class="hint">It's a one-time tip, in the amount you choose, on our page at Ko-fi. It doesn't unlock anything: ${esc(SITE.app)} stays free either way.
        We're a business, not a charity, so there's no tax receipt.</p>`;
  }

  /* ---------- Commis: the welcome page (sign in, sign up, forgot password) ---------- */
  const authView = { mode: "in", note: "" };
  // Commis's Terms of Use (sites/commis/pages), French first. Asked once, when signing up; the version says which one was accepted.
  const TERMS_VERSION = "2026-11-07";
  const termsLinks = `<a href="conditions.html" target="_blank" rel="noopener" lang="fr">Conditions d'utilisation</a> / <a href="terms.html" target="_blank" rel="noopener">Terms of Use</a>`;
  const privacyLinks = `<a href="confidentialite.html" target="_blank" rel="noopener" lang="fr">Politique de confidentialité</a> / <a href="privacy.html" target="_blank" rel="noopener">Privacy Policy</a>`;
  // Commis's public homepage (sites/commis/home.html): in the page from the start, then wrapped around the sign-in box.
  const homeHtml = (() => {
    const home = document.querySelector("[data-home]");
    if (!home) return "";
    if (SITE.support) home.querySelectorAll("[data-tip]").forEach((a) => { a.href = SITE.support; a.hidden = false; });
    return home.outerHTML;
  })();
  function authPage() {
    const v = authView, email = `<label class="block">Email<input class="in" type="email" name="email" autocomplete="email" required /></label>`;
    const forms = {
      in: `<h2>Sign in</h2>
        <form data-form="sign-in" class="welcome__form">${email}
          <label class="block">Password<input class="in" type="password" name="password" autocomplete="current-password" required /></label>
          <button class="btn btn--main">Sign in</button></form>
        <p class="welcome__links"><button class="linkish" data-auth="forgot">Forgot your password?</button>
          <span>New here? <button class="linkish" data-auth="up">Create an account</button></span></p>`,
      up: `<h2>Create your account</h2>
        <p class="muted">Free for restaurants. One account per restaurant; use your work email or your own. A restaurant gave you access? Sign up with the email they used, and put your own name or restaurant here.</p>
        <form data-form="sign-up" class="welcome__form">
          <label class="block">Restaurant<input class="in" name="restaurant" autocomplete="organization" required /></label>${email}
          <label class="block">Password <span class="muted small">(8 characters or more)</span><input class="in" type="password" name="password" minlength="8" autocomplete="new-password" required /></label>
          <label class="check welcome__terms"><input type="checkbox" name="terms" required /> <span>I accept the ${termsLinks}, and I've read the ${privacyLinks}.</span></label>
          <button class="btn btn--main">Create account</button></form>
        <p class="welcome__links"><span>Already have one? <button class="linkish" data-auth="in">Sign in</button></span></p>`,
      forgot: `<h2>Forgot your password?</h2>
        <p class="muted">We'll email you a link to choose a new one.</p>
        <form data-form="forgot" class="welcome__form">${email}<button class="btn btn--main">Send the link</button></form>
        <p class="welcome__links"><button class="linkish" data-auth="in">Back to sign in</button></p>`,
      sent: `<h2>Check your email</h2><p>${esc(v.note)}</p><p class="muted small">Nothing after a few minutes? Look in spam, or try again.</p>
        <p class="welcome__links"><button class="linkish" data-auth="in">Back to sign in</button></p>`,
      reset: `<h2>Choose a new password</h2>
        <form data-form="new-password" class="welcome__form">
          <label class="block">New password <span class="muted small">(8 characters or more)</span><input class="in" type="password" name="password" minlength="8" autocomplete="new-password" required /></label>
          <button class="btn btn--main">Save it</button></form>`,
    };
    const card = `<section class="card welcome__card">
        ${v.note && v.mode !== "sent" ? `<p class="note note--bad">${esc(v.note)}</p>` : ""}
        ${forms[v.mode] || forms.in}
      </section>`;
    // (Read back from the page, the browser writes the placeholder as data-auth-slot="".)
    if (homeHtml) return homeHtml.replace(/<div data-auth-slot(="")?><\/div>/, () => card);
    return `<div class="welcome">
      <h1 class="welcome__name">${esc(SITE.name)}</h1>
      <p class="welcome__sub">${esc(SITE.sub)}: recipe costs, supplier prices from your invoices, and the monthly count.</p>
      ${card}
      <p class="welcome__legal">${termsLinks} · ${privacyLinks}</p>
    </div>`;
  }
  window.addEventListener("hashchange", () => { takeSundaeLink(); render(); main.focus({ preventScroll: true }); if (!render.restored) window.scrollTo(0, 0); });

  async function start() {
    store = Store.current();
    const side = chooseAccount(await store.loadTeam());
    // Commis's welcome page is the kitchen's. Barback needs someone signed in.
    Store.setProject(SITE.commis && Auth.configured() && !Auth.signedIn() ? "kitchen" : side);
    // Commis: the restaurant's name under the site's name once signed in.
    $(".brand__sub").textContent = (SITE.commis && Auth.signedIn() && Auth.restaurant()) || SITE.sub;
    const mode = $("#mode");
    if (SITE.commis && Auth.configured()) mode.hidden = true;
    else if (store.kind === "local") {
      mode.hidden = false;
      mode.innerHTML = Auth.configured() ? `Not signed in: showing this browser's data. <a href="#/settings">Sign in</a>` : `Local mode: data is saved in this browser only. <a href="#/settings">Settings</a>`;
    } else mode.hidden = true;
    let loaded = null, saved = {};
    try { loaded = await store.loadAll(); }
    catch (e) { toast(e.message, true); }
    try { saved = await store.getSettings(); settingsProblem = ""; }
    catch (e) {
      saved = {};
      settingsProblem = "Run the updated supabase/schema.sql once in Supabase: it adds the small table that remembers your Drive folder and sheet.";
    }
    // All at once, so nothing is drawn from one set of records with the other's costs. The first time in Barback, it starts with a bar's sections.
    const first = Store.project() === "barback" && !saved.categories && !settingsProblem;
    try { people = Store.teamsReady() && isAdmin() ? await store.people(Store.account()) : []; } catch { people = []; }
    if (loaded) data = loaded;
    settings = first ? { ...saved, ...Barback.firstSettings() } : saved;
    applyProject();
    rebuild();
    render();
    if (first) saveSettings(settings);
  }
  let resizing = null;
  window.addEventListener("resize", () => { clearTimeout(resizing); resizing = setTimeout(drawHistChart, 150); });
  const badgeRoom = () => document.body.classList.toggle("has-badge", !!document.getElementById("nl-badge-frame"));
  new MutationObserver(badgeRoom).observe(document.body, { childList: true });
  // What decides whether a recipe's lines fit: the window, the text size, and the lettering once it has loaded.
  let fitting = 0;
  window.addEventListener("resize", () => { cancelAnimationFrame(fitting); fitting = requestAnimationFrame(fitLines); });
  new MutationObserver(fitLines).observe(document.documentElement, { attributes: true, attributeFilter: ["data-size", "data-dyslexia"] });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitLines);
  badgeRoom();
  $("#projectSwitch").addEventListener("click", (e) => { const b = e.target.closest("[data-project]"); if (b) switchProject(b.dataset.project); });
  $("#accountSwitch").addEventListener("change", (e) => goTo(e.target.value));
  $("#invites").addEventListener("click", (e) => { const b = e.target.closest("[data-invite]"); if (b) answerInvite(b); });
  // The site's own name in the header and the tab.
  $(".brand__name").textContent = SITE.name;
  document.title = SITE.app;
  // Commis's tip button in the top bar, once its link is in config.js. The stylesheet keeps it for signed-in people.
  if (SITE.support) { const tip = $("#tipLink"); tip.href = SITE.support; tip.hidden = false; }
  takeSundaeLink();
  // Coming back from the link in a sign-up or "forgot password" email (Commis).
  Auth.fromLink().then((r) => {
    if (r && r.error) authView.note = `That link didn't work: ${r.error}. Sign in, or ask for a new link.`;
    if (r && r.type === "recovery") authView.mode = "reset";
    if (r && r.type === "signup") toast("Email confirmed. Welcome!");
  }).catch(() => {}).finally(() => start());
})();
