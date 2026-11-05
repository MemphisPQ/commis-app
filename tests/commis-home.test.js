const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const page = (f) => fs.readFileSync(path.join(root, "sites", "commis", "pages", f), "utf8");
const home = fs.readFileSync(path.join(root, "sites", "commis", "home.html"), "utf8");
const en = page("privacy.html"), fr = page("confidentialite.html");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");

test("the homepage says what Commis does in both languages, and links its privacy policy, terms and contact", () => {
  for (const words of ["Recipe costing", "Coût des recettes", "Supplier invoices", "Factures des fournisseurs", "Monthly count", "Inventaire du mois", "Allergens", "Allergènes"]) assert.ok(home.includes(words), words);
  for (const link of ["privacy.html", "confidentialite.html", "terms.html", "conditions.html", "mailto:frznswts@gmail.com"]) assert.ok(home.includes(`href="${link}"`), link);
  assert.match(home, /data-auth="up"/);
  assert.match(home, /<div data-auth-slot><\/div>/);
  assert.match(home, /never sell anyone's data/);
  assert.match(home, /ne vendons jamais les données/);
  assert.doesNotMatch(home, /My Kitchen|My Kitchen/);
});

test("the build puts the homepage in the page itself, under Commis's name, and leaves the one-restaurant page alone", () => {
  execFileSync(process.execPath, [path.join(root, "scripts", "build-commis.js")], { stdio: "ignore" });
  const built = fs.readFileSync(path.join(root, "dist", "commis", "index.html"), "utf8");
  assert.match(built, /<main id="main" tabindex="-1"><div class="home" data-home>/);
  assert.match(built, /<title>Commis:/);
  assert.match(built, /href="home\.css"/);
  assert.doesNotMatch(built, /My Kitchen|Kitchen Costing/);
  for (const f of ["privacy.html", "confidentialite.html", "terms.html", "conditions.html", "home.css", "legal.css"]) assert.ok(fs.existsSync(path.join(root, "dist", "commis", f)), f);
  assert.ok(!fs.existsSync(path.join(root, "dist", "commis", "home.html")), "the homepage is in index.html, not a page of its own");
  const own = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  assert.match(own, /<p class="muted">Loading…<\/p>/);
  assert.ok(!fs.existsSync(path.join(root, "public", "privacy.html")));
});

test("the two policies match, name who handles data, and link each other", () => {
  const nums = (t) => [...t.matchAll(/<h2>(\d+)\./g)].map((m) => +m[1]);
  assert.deepEqual(nums(en), Array.from({ length: 12 }, (_, k) => k + 1));
  assert.deepEqual(nums(fr), nums(en));
  assert.ok(en.includes('href="confidentialite.html"') && fr.includes('href="privacy.html"'));
  for (const t of [en, fr]) for (const name of ["Supabase", "Netlify", "Resend", "Ko-fi", "PayPal", "Stripe", "Google Fonts", "cdnjs", "cai.gouv.qc.ca", "priv.gc.ca", "Sweets Suite", "frznswts@gmail.com", "drive.file", "api-services-user-data-policy"]) assert.ok(t.includes(name), name);
});

test("what the policy promises: never sold, invoices stay in the browser unless sent, deleted after, no cookies", () => {
  assert.match(en, /We never sell anyone's data,<\/strong> to anyone/);
  assert.match(fr, /Nous ne vendons jamais les données de qui que ce soit,<\/strong> à personne/);
  assert.match(en, /read in your browser and doesn't leave it/);
  assert.match(fr, /lu dans votre navigateur et n'en sort pas/);
  assert.match(en, /once the reader is built, or if we find we can't build one, we delete the file and your note/);
  assert.match(fr, /une fois le lecteur bâti, ou si nous constatons que nous ne pouvons pas en bâtir un, nous supprimons le fichier et votre note/);
  // The email that says an invoice arrived (schema part 14): who handles it, what's in it, and that it goes too.
  assert.match(en, /tells us an invoice you sent has arrived \(its file name and your note, never the PDF\)/);
  assert.match(fr, /de l'arrivée d'une facture que vous avez envoyée \(son nom et votre note, jamais le PDF\)/);
  assert.match(en, /<strong>Google \(Gmail\):<\/strong> our inbox/);
  assert.match(fr, /<strong>Google \(Gmail\) :<\/strong> notre boîte de courriel/);
  assert.match(en, /we delete the file and your note, along with the email that told us it arrived/);
  assert.match(fr, /nous supprimons le fichier et votre note, ainsi que le courriel qui nous a avisés de son arrivée/);
  assert.match(en, /Limited Use requirements/);
  // True of the code: no cookies, nothing to do with tracking, only the outside hosts it names.
  const code = ["app.js", "auth.js", "store.js", "google.js", "invoices.js", "pdftext.js", "menufile.js", "sheetfill.js", "cardfill.js"].map((f) => fs.readFileSync(path.join(root, "public", f), "utf8")).join("\n");
  assert.doesNotMatch(code, /document\.cookie|googletagmanager|google-analytics|umami|plausible/i);
  const hosts = new Set([...code.matchAll(/https:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase()));
  for (const h of hosts) assert.match(h, /(^|\.)(cloudflare\.com|google\.com|googleapis\.com|supabase\.co)$|example|^x$/, h);
});

test("the tip is one Ko-fi link, one-time, in the top bar, Settings and the homepage, with no checkout of our own", () => {
  const config = fs.readFileSync(path.join(root, "sites", "commis", "config.js"), "utf8");
  assert.match(config, /support: "(https:\/\/ko-fi\.com\/[^"]*)?",/);
  // The Settings card and the homepage link only appear with a real https address.
  assert.match(app, /function tipLink\(u\) \{ return typeof u === "string" && u\.startsWith\("https:\/\/"\) \? u : ""; \}/);
  assert.match(app, /\$\{SITE\.support \? `<section class="card"><h2>Buy us a soda<\/h2>/);
  for (const lang of ["Payez-nous une liqueur", "Buy us a soda"]) assert.ok(home.includes(`<a data-tip target="_blank" rel="noopener" hidden>${lang}</a>`), lang);
  assert.match(app, /querySelectorAll\("\[data-tip\]"\)\.forEach\(\(a\) => \{ a\.href = SITE\.support; a\.hidden = false; \}\)/);
  // The button in the top bar: a plain link, shown by the app only with a real link, and only to people already using it.
  const css = fs.readFileSync(path.join(root, "public", "style.css"), "utf8");
  const shared = fs.readFileSync(path.join(root, "public", "index.html"), "utf8") + css;
  assert.match(shared, /<a class="top__tip" id="tipLink" target="_blank" rel="noopener" aria-label="Buy us a soda" hidden>/);
  assert.match(app, /if \(SITE\.support\) \{ const tip = \$\("#tipLink"\); tip\.href = SITE\.support; tip\.hidden = false; \}/);
  assert.match(css, /\.signed-out \.top__tip \{ display: none; \}/);
  // No outside script for it: Ko-fi only sees someone who clicks. The hosts test above can't see the page itself, so check it here.
  assert.doesNotMatch(shared + home + config, /storage\.ko-fi\.com|kofiwidget/);
  // Gone for good: the old Support box, the monthly option and the way back from Stripe.
  assert.doesNotMatch(shared, /supportBtn|top__support/);
  assert.doesNotMatch(app, /supportBtn|takeThanks|thanks=support|Give once|monthly support|Stripe/);
  // The pages say the same thing, in both languages, and nothing about paying monthly is left.
  const terms = page("terms.html"), conditions = page("conditions.html");
  assert.match(terms, /You tip on our page at Ko-fi, outside Commis, and the payment goes to us through PayPal or Stripe/);
  assert.match(conditions, /Le pourboire se donne sur notre page Ko-fi, à l'extérieur de Commis, et le paiement nous parvient par PayPal ou Stripe/);
  assert.match(terms, /Nothing renews/);
  assert.match(conditions, /Rien ne se renouvelle/);
  for (const t of [terms, conditions, en, fr]) assert.doesNotMatch(t, /monthly|mensuel|chaque mois/i);
  // Ko-fi isn't one of the companies that run the Service: it never sees a restaurant's data.
  assert.doesNotMatch(terms, /Stripe \(payments\)/);
  assert.doesNotMatch(conditions, /Stripe \(paiements\)/);
  assert.doesNotMatch(en, /<strong>Stripe:<\/strong>/);
  assert.doesNotMatch(fr, /<strong>Stripe :<\/strong>/);
});

test("signing up names the privacy policy too, and the homepage only shows when signed out", () => {
  assert.match(app, /I accept the \$\{termsLinks\}, and I've read the \$\{privacyLinks\}/);
  // The app's pattern has to find the placeholder as a browser writes it back, and as the file has it.
  const pattern = app.match(/homeHtml\.replace\((\/.+?\/), \(\) => card\)/);
  assert.ok(pattern, "the app fills the sign-in box in");
  const slot = new RegExp(pattern[1].slice(1, -1).replace(/\\\//g, "/"));
  assert.match('<div data-auth-slot=""></div>', slot);
  assert.match(home, slot);
  assert.match(app, /classList\.remove\("home-wait"\)/);
  // The language switch only hides the homepage's own blocks, not a French link inside the English sign-up box.
  assert.doesNotMatch(fs.readFileSync(path.join(root, "sites", "commis", "pages", "home.css"), "utf8"), /\.home \[lang=/);
  const terms = page("terms.html"), conditions = page("conditions.html");
  assert.ok(terms.includes('href="privacy.html"') && conditions.includes('href="confidentialite.html"'));
});
