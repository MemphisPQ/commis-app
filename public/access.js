/* The accessibility options: colour-blind friendly colours, low vision, text size, a dyslexia-friendly font.
 * Saved on this device (a phone and a computer can differ), and put on the page before anything is drawn, so it never
 * flashes the usual look first. It needs nothing from the app, so it also works on Commis's welcome and legal pages.
 * The look itself is in style.css (and sites/commis/pages/legal.css), under html[data-colorblind], [data-lowvision],
 * [data-size] and [data-dyslexia].
 */
(function () {
  const KEY = "costing.access";
  const root = document.documentElement;
  let prefs = {};
  try { prefs = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch { prefs = {}; }

  function apply() {
    root.toggleAttribute("data-colorblind", !!prefs.colorblind);
    root.toggleAttribute("data-lowvision", !!prefs.lowvision);
    root.toggleAttribute("data-dyslexia", !!prefs.dyslexia);
    if (prefs.size === "large" || prefs.size === "xlarge") root.setAttribute("data-size", prefs.size);
    else root.removeAttribute("data-size");
  }
  apply();

  function set(changes) {
    prefs = { ...prefs, ...changes };
    try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* blocked: it still works until the page closes */ }
    apply();
  }

  const WORDS = {
    en: {
      open: "Accessibility options", title: "Accessibility", intro: "Saved on this device. Turn on as many as you like.",
      colorblind: "Colour-blind friendly", colorblindMore: "Blue and orange instead of green and red, with marks and line patterns so nothing depends on colour.",
      lowvision: "Low vision", lowvisionMore: "Strong contrast, thicker outlines, bigger buttons and every link underlined. Turns on Large text.",
      size: "Text size", normal: "Normal", large: "Large", xlarge: "Extra large",
      dyslexia: "Dyslexia-friendly font", dyslexiaMore: "OpenDyslexic, with more room between letters and lines.",
      done: "Done", skip: "Skip to the main content",
    },
    fr: {
      open: "Options d'accessibilité", title: "Accessibilité", intro: "Enregistré sur cet appareil. Activez-en autant que vous voulez.",
      colorblind: "Daltonisme", colorblindMore: "Du bleu et de l'orange au lieu du vert et du rouge, avec des marques et des motifs de lignes pour que rien ne dépende de la couleur.",
      lowvision: "Basse vision", lowvisionMore: "Contraste élevé, contours plus épais, boutons plus grands et tous les liens soulignés. Active le grand texte.",
      size: "Taille du texte", normal: "Normale", large: "Grande", xlarge: "Très grande",
      dyslexia: "Police pour la dyslexie", dyslexiaMore: "OpenDyslexic, avec plus d'espace entre les lettres et les lignes.",
      done: "Fermer", skip: "Aller au contenu principal",
    },
  };
  const say = (k) => (WORDS[root.lang === "fr" ? "fr" : "en"])[k];

  function label() {
    document.querySelectorAll("[data-access-open][aria-label]").forEach((b) => { b.setAttribute("aria-label", say("open")); b.title = say("open"); });
    document.querySelectorAll("[data-skip]").forEach((b) => { b.textContent = say("skip"); });
  }

  function dialog() {
    let d = document.getElementById("access");
    if (!d) {
      d = document.createElement("dialog");
      d.id = "access";
      d.className = "ask access";
      d.setAttribute("aria-labelledby", "accessTitle");
      document.body.append(d);
      d.addEventListener("change", (e) => {
        const f = e.target.dataset.pref;
        if (!f) return;
        if (f === "size") return set({ size: e.target.value });
        // Low vision starts at Large text, which can still be changed just below it.
        if (f === "lowvision" && e.target.checked && !prefs.size) { set({ lowvision: true, size: "large" }); d.querySelector('[data-pref="size"]').value = "large"; return; }
        set({ [f]: e.target.checked });
      });
    }
    const tick = (f) => `<label class="access__row"><input type="checkbox" data-pref="${f}"${prefs[f] ? " checked" : ""} />
      <span><strong>${say(f)}</strong><span class="access__more">${say(f + "More")}</span></span></label>`;
    d.innerHTML = `<h2 id="accessTitle">${say("title")}</h2>
      <p class="access__intro">${say("intro")}</p>
      ${tick("colorblind")}${tick("lowvision")}
      <label class="access__size"><strong>${say("size")}</strong>
        <select class="in" data-pref="size">${["", "large", "xlarge"].map((v) => `<option value="${v}"${(prefs.size || "") === v ? " selected" : ""}>${say(v || "normal")}</option>`).join("")}</select></label>
      ${tick("dyslexia")}
      <form method="dialog" class="actions"><button class="btn btn--main">${say("done")}</button></form>`;
    return d;
  }

  document.addEventListener("click", (e) => {
    const t = e.target.closest ? e.target : e.target.parentElement;
    if (t.closest("[data-access-open]")) dialog().showModal();
    if (t.closest("[data-skip]")) { const m = document.querySelector("main"); if (m) { m.focus(); m.scrollIntoView(); } }
    if (t.closest("[data-lang-pick]")) setTimeout(label);
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", label);
  else label();
})();
