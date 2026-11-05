const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const page = (f) => fs.readFileSync(path.join(root, "sites", "commis", "pages", f), "utf8");
const en = page("terms.html"), fr = page("conditions.html");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const headings = (t) => [...t.matchAll(/<h2>(\d+)\./g)].map((m) => +m[1]);

test("the two versions match: same numbered sections, links to each other, the right language", () => {
  assert.deepEqual(headings(en), Array.from({ length: 15 }, (_, k) => k + 1));
  assert.deepEqual(headings(fr), headings(en));
  assert.match(en, /<html lang="en"/);
  assert.match(fr, /<html lang="fr"/);
  assert.ok(en.includes('href="conditions.html"'));
  assert.ok(fr.includes('href="terms.html"'));
  for (const t of [en, fr]) {
    assert.match(t, /Sweets Suite/);
    assert.match(t, /Qu[eé]bec/);
    assert.ok(t.includes('href="legal.css"') && t.includes('href="favicon.svg"'));
  }
});

test("free, with no limits and no throttling: nothing can be read as a usage cap", () => {
  assert.match(en, /We set no limit on how many dishes, items, invoices or counts you have or on how often you use it, and we don't throttle anyone/);
  assert.match(fr, /Nous ne fixons aucune limite au nombre de plats, d'articles, de factures ou d'inventaires, ni à la fréquence d'utilisation, et nous ne ralentissons personne/);
  assert.match(en, /none of this is a usage limit/);
  assert.match(fr, /n'est pas une limite d'utilisation/);
  assert.match(en, /never because of how much it is used/);
  assert.match(fr, /jamais à cause de la quantité d'utilisation/);
});

test("the soda: optional, a tip for the service, unlocks nothing, no tax receipt, 14-day refund", () => {
  assert.match(en, /a one-time tip for a service you're already using/);
  assert.match(fr, /un pourboire unique pour un service que vous utilisez déjà/);
  assert.match(en, /It doesn't unlock or change anything/);
  assert.match(fr, /Ça ne débloque et ne change rien/);
  assert.match(en, /no tax receipt is issued/);
  assert.match(fr, /aucun reçu fiscal n'est émis/);
  assert.match(en, /within <strong>14 days<\/strong> of a tip[^<]*within 15 days of your request/);
  assert.match(fr, /dans les <strong>14 jours<\/strong> suivant un pourboire[^<]*dans les 15 jours suivant votre demande/);
});

test("from experience, not advice; allergens are only what's entered", () => {
  assert.match(en, /are <strong>not<\/strong> accounting, tax, legal, financial, medical, nutrition or food-safety advice/);
  assert.match(fr, /Ce ne sont <strong>pas<\/strong> des conseils comptables, fiscaux, juridiques, financiers, médicaux ou nutritionnels/);
  assert.match(en, /<strong>only what you and your team enter<\/strong>/);
  assert.match(fr, /<strong>uniquement ce que vous et votre équipe y entrez<\/strong>/);
  assert.match(en, /Never rely on the Service alone/);
  assert.match(fr, /Ne vous fiez jamais au Service seul/);
  // The wording the app shows for a clean result is the one the terms explain.
  assert.ok(app.includes("None of the main allergens"));
  assert.ok(en.includes("None of the main allergens"));
});

test("Quebec rules: notice before the limits, what can't be limited, 30 days' notice of changes, French first", () => {
  assert.match(en, /<h2>12\. Limits on our responsibility<\/h2>\n<p><strong>For consumers in Quebec:<\/strong>/);
  assert.match(fr, /<h2>12\. Limites de notre responsabilité<\/h2>\n<p><strong>Pour les consommateurs du Québec :<\/strong>/);
  assert.match(en, /including for bodily or moral injury or for our intentional or gross fault/);
  assert.match(fr, /notamment en cas de préjudice corporel ou moral ou de faute intentionnelle ou lourde/);
  assert.match(en, /at least 30 days before it takes effect[^<]*right to refuse it/);
  assert.match(fr, /au moins 30 jours avant son entrée en vigueur[^<]*droit de la refuser/);
  assert.match(en, /offered first in French/);
  assert.match(fr, /offertes d'abord en français/);
});

test("signing up asks for the terms once, French link first, and keeps which version was accepted", () => {
  assert.match(app, /<input type="checkbox" name="terms" required \/>/);
  assert.ok(app.indexOf('href="conditions.html"') < app.indexOf('href="terms.html"'), "French first");
  assert.match(app, /terms_version: TERMS_VERSION/);
  // The date of the version matches the date on the pages.
  assert.match(app, /TERMS_VERSION = "2026-11-04"/);
  assert.match(en, /November 4, 2026/);
  assert.match(fr, /4 novembre 2026/);
});

test("never sold, and a sent invoice is deleted once its reader is built, only our copy", () => {
  assert.match(en, /<strong>We never sell anyone's data, to anyone\.<\/strong> We aren't using Commis to collect data/);
  assert.match(fr, /<strong>Nous ne vendons jamais les données de qui que ce soit, à personne\.<\/strong> Nous n'utilisons pas Commis pour recueillir des données/);
  assert.match(en, /<strong>Once the reader is built, or if we find we can't build one, we delete the copy you sent\.<\/strong> That only removes our copy/);
  assert.match(fr, /<strong>Une fois le lecteur bâti, ou si nous constatons que nous ne pouvons pas en bâtir un, nous supprimons la copie que vous avez envoyée\.<\/strong> Cela retire seulement notre copie/);
  // The email that says it arrived (schema part 14) goes too, and whoever handles that email is named.
  assert.match(en, /with its name and your note but never the PDF, and we delete that email too/);
  assert.match(fr, /avec son nom et votre note mais jamais le PDF, et nous supprimons ce courriel aussi/);
  assert.match(en, /Gmail \(our inbox\)/);
  assert.match(fr, /Gmail \(notre boîte de courriel\)/);
});

test("none of our data sets go to other restaurants: the ready-made list is out of the app, the build and the terms", () => {
  const build = fs.readFileSync(path.join(root, "scripts", "build-commis.js"), "utf8");
  for (const [name, text] of [["app", app], ["build", build], ["en", en], ["fr", fr]]) assert.doesNotMatch(text, /starter|ready-made|liste de départ/i, name);
});

test("every invoice can be sent to us on Commis, and the site says it deletes its copy", () => {
  assert.match(app, /data-act="inv-report"/);
  assert.match(app, /data-act="inv-pick-send"/);
  assert.match(app, /const canSendInvoices = \(\) => SITE\.commis && store\.kind === "supabase"/);
  assert.match(app, /then we delete our copy/);
});

test("the code is open source: both versions link to it, in the short version and section 9, and say what the licence leaves out", () => {
  const url = 'href="https://github.com/MemphisPQ/commis-app"';
  for (const t of [en, fr]) {
    assert.equal(t.split(url).length - 1, 2, "one link at the top, one in section 9");
    assert.ok(t.indexOf(url) < t.indexOf("<h2>1."), "the first link is in the short version");
  }
  assert.match(en, /The code is open source:<\/strong> you can read it and reuse it under the MIT licence/);
  assert.match(fr, /Le code source est ouvert :<\/strong> vous pouvez le lire et le réutiliser selon la licence MIT/);
  assert.match(en, /The licence covers the code, not our names or these pages/);
  assert.match(fr, /La licence couvre le code, pas nos noms ni ces pages/);
  // Nothing still forbids what the licence allows, and passing off a copy as ours stays out.
  assert.doesNotMatch(en, /copy, resell or republish the Service or its software/);
  assert.doesNotMatch(fr, /copier, revendre ou republier le Service ou son logiciel/);
  assert.match(en, /present a copy of it as ours/);
  assert.match(fr, /présenter une copie comme étant la nôtre/);
});

test("the Commis build puts the terms on its site, and the one-restaurant files don't get them", () => {
  const build = fs.readFileSync(path.join(root, "scripts", "build-commis.js"), "utf8");
  assert.match(build, /"sites", "commis", "pages"/);
  assert.ok(!fs.existsSync(path.join(root, "public", "terms.html")));
});
