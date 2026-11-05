/* Builds Commis's site: the same files as My Kitchen's (public/), with Commis's settings (sites/commis/config.js).
 *   node scripts/build-commis.js        → dist/commis/
 * the one-restaurant site is still uploaded straight from public/, so every change reaches both.
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const from = path.join(root, "public");
const to = path.join(root, "dist", "commis");
const config = path.join(root, "sites", "commis", "config.js");

fs.rmSync(to, { recursive: true, force: true });
fs.cpSync(from, to, { recursive: true });
fs.copyFileSync(config, path.join(to, "config.js"));
// Its Terms of Use (French and English), at the top of the site.
fs.cpSync(path.join(root, "sites", "commis", "pages"), to, { recursive: true });
// Its public homepage goes inside the page itself: it reads before the app starts, and without it. Signed-in visitors skip it.
const indexPath = path.join(to, "index.html");
let page = fs.readFileSync(indexPath, "utf8");
const swap = (a, b) => { if (!page.includes(a)) throw new Error("public/index.html no longer has: " + a); page = page.replace(a, () => b); };
swap('<html lang="en">', '<html lang="fr" data-home-lang="fr">');
swap("<title>Kitchen Costing</title>", `<title>Commis: recipe costs, invoices and inventory, free for restaurants</title>
  <meta name="description" content="Coût des recettes, factures des fournisseurs, inventaire et menus, gratuit pour tous les restaurants. Recipe costs, supplier invoices, inventory and menus, free for every restaurant." />`);
swap('<link rel="stylesheet" href="style.css" />', `<link rel="stylesheet" href="style.css" />
  <link rel="stylesheet" href="home.css" />
  <script src="errors.js"></script>
  <script>
    try {
      var d = document.documentElement, saved = localStorage.getItem("commis.lang");
      d.lang = d.dataset.homeLang = saved || (/^en/i.test(navigator.language || "") ? "en" : "fr");
      if (localStorage.getItem("costing.session")) d.classList.add("home-wait");
    } catch (e) { /* French, as the page starts */ }
  </script>`);
swap('<span class="brand__name">My Kitchen</span><span class="brand__sub">Kitchen Costing</span>', '<span class="brand__name">Commis</span><span class="brand__sub">Costing &amp; inventory</span>');
swap("<body>", '<body class="signed-out">');
swap('<p class="muted">Loading…</p>', fs.readFileSync(path.join(root, "sites", "commis", "home.html"), "utf8").trim());
fs.writeFileSync(indexPath, page);

const cfg = fs.readFileSync(config, "utf8");
const missing = /supabaseUrl:\s*""/.test(cfg) || /supabaseAnonKey:\s*""/.test(cfg);
console.log(`Built ${path.relative(root, to)} (${fs.readdirSync(to).length} files).`);
if (missing) console.log("Note: sites/commis/config.js has no Supabase project yet, so this build runs in local mode (data in the browser only).");
