/* Commis's settings: the copy of the app restaurants sign up to. Same files as the one-restaurant site in public/; only
 * this file differs (scripts/build-commis.js puts it in place of public/config.js).
 * Your own Supabase project's values go here: both are safe to be public, data is protected by sign-in.
 */
window.COSTING_CONFIG = {
  supabaseUrl: "",
  supabaseAnonKey: "",

  googleClientId: "",
  googleApiKey: "",
  googleProjectNumber: "",

  site: {
    edition: "commis", name: "Commis", sub: "Costing & inventory", barback: true, teams: true,
    // Optional tip: the address of your tip page. While it's empty, the button, card and link stay hidden.
    support: "",
  },
};
