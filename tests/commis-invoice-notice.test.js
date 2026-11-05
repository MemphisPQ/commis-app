/* The email to the owner when a restaurant sends in an invoice (part 14 of supabase/schema.sql), and what watches it
 * (part 15: the alarm's check and the weekly test).
 * Parts 11, 14 and 15 run for real here, on a real Postgres (PGlite, in memory). What only Supabase has is stood in for:
 * net.http_post (pg_net) writes down what it would have sent, its results table is filled by hand, cron.schedule (pg_cron)
 * writes the job down, and the Vault is a plain table. So this proves what the SQL asks for, not that Resend delivers it:
 * that's the last steps of README, "Commis", setting up, step 4.
 * The SQL runs as project_owner, who like Supabase's "postgres" role isn't a superuser and only has the rights Supabase
 * documents for it: reading the Vault and pg_net's results, calling pg_net, and scheduling with pg_cron.
 */
const { test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
const schema = read("supabase", "schema.sql");
/** One numbered part of schema.sql, up to the next part or the end of the file. */
function part(n) {
  const m = new RegExp(`^-- ${n}\\. [\\s\\S]*?(?=^-- ${n + 1}\\. |(?![\\s\\S]))`, "m").exec(schema);
  assert.ok(m, `part ${n} of schema.sql`);
  return m[0];
}
const guarded = (name) => new RegExp(`do \\$\\$\\s+begin\\s+if not exists \\(select 1 from pg_catalog\\.pg_extension where extname = '${name}'\\) then[\\s\\S]*?\\$\\$;`);
const PG_NET = guarded("pg_net");
const part14 = () => part(14).replace(PG_NET, ""); // PGlite has no pg_net: the stand-in below replaces it.
const PG_CRON = guarded("pg_cron");
const part15 = () => part(15).replace(PG_CRON, ""); // Nor pg_cron.

const A = "00000000-0000-4000-8000-00000000000a", B = "00000000-0000-4000-8000-00000000000b";
const FAKE_KEY = "fake-key-for-tests";
let db;
const asOwner = async (sql) => {
  await db.exec("set role project_owner;");
  try { await db.exec(sql); } finally { await db.exec("reset role;"); }
};

before(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create role project_owner nologin nosuperuser;
    grant create on schema public to project_owner;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated, project_owner;
    grant references on auth.users to project_owner;
    insert into auth.users values ('${A}'), ('${B}');

    create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (bucket_id text, name text);
    create function storage.foldername(name text) returns text[] language sql as $$ select string_to_array(name, '/') $$;
    grant usage on schema storage to project_owner;
    grant insert, select on storage.buckets to project_owner;
    alter table storage.objects owner to project_owner;

    create schema extensions;
    create schema vault;
    create table vault.decrypted_secrets (name text, decrypted_secret text);
    create view vault.secrets as select name from vault.decrypted_secrets;
    grant usage on schema vault to project_owner;
    grant select on vault.decrypted_secrets, vault.secrets to project_owner;

    create schema cron;
    create table cron.job (jobname text primary key, schedule text, command text);
    create function cron.schedule(a text, b text, c text) returns bigint language plpgsql security definer as $$
      begin
        insert into cron.job values (a, b, c) on conflict (jobname) do update set schedule = b, command = c;
        return 1;
      end $$;
    revoke all on function cron.schedule(text, text, text) from public;
    grant usage on schema cron to project_owner;
    grant execute on function cron.schedule(text, text, text) to project_owner;

    create schema net;
    create table net.sent (url text, body jsonb, headers jsonb, timeout_milliseconds int);
    create table net.broken (why text);
    create table net._http_response (id bigint, status_code integer, error_msg text, created timestamptz not null default now());
    grant select on net._http_response to project_owner;
    create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}',
      headers jsonb default '{"Content-Type": "application/json"}', timeout_milliseconds int default 2000) returns bigint
      language plpgsql security definer as $$
      begin
        if exists (select 1 from net.broken) then raise exception 'pg_net is down'; end if;
        insert into net.sent values (url, body, headers, timeout_milliseconds);
        return 1;
      end $$;
    revoke all on function net.http_post(text, jsonb, jsonb, jsonb, int) from public;
    grant usage on schema net to project_owner;
    grant execute on function net.http_post(text, jsonb, jsonb, jsonb, int) to project_owner;
  `);
  await asOwner(part(11));
  await asOwner(part14());
  await asOwner(part15());
});
after(() => db.close());
beforeEach(async () => {
  await db.exec(`
    delete from public.invoice_requests; delete from net.sent; delete from net.broken; delete from vault.decrypted_secrets;
    delete from net._http_response;
    insert into vault.decrypted_secrets values ('resend_api_key', '${FAKE_KEY}');
  `);
});

/** What a restaurant's browser does: the row goes in as that signed-in account, under row level security. */
async function send(user, { name = "invoice.pdf", note = "", filePath = `${user}/2026-11-04-invoice.pdf` } = {}) {
  await db.exec(`set test.uid = '${user}'; set role authenticated;`);
  try {
    await db.query("insert into public.invoice_requests (file_path, file_name, note) values ($1, $2, $3)", [filePath, name, note]);
  } finally {
    await db.exec("reset role;");
  }
}
const sent = async () => (await db.query("select * from net.sent")).rows;
const saved = async () => +(await db.query("select count(*) n from public.invoice_requests")).rows[0].n;

test("a sent invoice queues one plain-text email to the owner: file name, note, dashboard link, never the PDF", async () => {
  await send(A, { name: "made-up.pdf", note: "the egg price is wrong", filePath: `${A}/2026-made-up.pdf` });
  const emails = await sent();
  assert.equal(emails.length, 1);
  const [{ url, body, headers, timeout_milliseconds }] = emails;
  assert.equal(url, "https://api.resend.com/emails");
  assert.equal(body.from, "Commis <noreply@example.com>");
  assert.deepEqual(body.to, ["you@example.com"]);
  assert.match(body.subject, /invoice arrived \(made-up\.pdf\)/);
  assert.match(body.text, /File: made-up\.pdf\n/);
  assert.match(body.text, /Note from the restaurant: the egg price is wrong\n/);
  assert.ok(body.text.includes("https://supabase.com/dashboard/project/YOUR-PROJECT-REF/storage/files/buckets/invoice-inbox"));
  assert.ok(body.text.includes(`Folder and file: ${A}/2026-made-up.pdf`));
  assert.deepEqual(Object.keys(body).sort(), ["from", "subject", "text", "to"], "no attachment, no HTML");
  // Resend refuses a call with no User-Agent (403), and pg_net only sends JSON.
  assert.equal(headers.Authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(headers["Content-Type"], "application/json");
  assert.ok(headers["User-Agent"]);
  assert.ok(timeout_milliseconds >= 5000);
});

test("an empty note says so", async () => {
  await send(A, { note: "   " });
  assert.match((await sent())[0].body.text, /Note from the restaurant: \(none\)\n/);
});

test("the key stays out of reach: not in our files, and restaurants can't run the function", async () => {
  const site = ["public/config.js", "public/store.js", "public/app.js", "sites/commis/config.js"].map((f) => read(f)).join("\n");
  for (const text of [schema, site]) assert.doesNotMatch(text, /\bre_[A-Za-z0-9]{16,}/);
  assert.doesNotMatch(site, /api\.resend\.com/, "the site itself never calls Resend");
  const { rows: [fn] } = await db.query(`select prosecdef, proconfig,
      has_function_privilege('anon', oid, 'execute') anon, has_function_privilege('authenticated', oid, 'execute') auth
    from pg_proc where proname = 'notify_invoice_request'`);
  assert.equal(fn.prosecdef, true, "runs with the owner's rights, so restaurants never need any on the Vault");
  assert.deepEqual(fn.proconfig, ['search_path=""']);
  assert.equal(fn.anon, false);
  assert.equal(fn.auth, false);
  // And a restaurant's own session can't read the secret or call pg_net, yet its insert still sent the email.
  await db.exec(`set test.uid = '${A}'; set role authenticated;`);
  try {
    await assert.rejects(db.query("select * from vault.decrypted_secrets"), /permission denied/);
    await assert.rejects(db.query("select net.http_post('https://example.com')"), /permission denied/);
  } finally {
    await db.exec("reset role;");
  }
  await send(A);
  assert.equal((await sent()).length, 1);
});

test("no key in the Vault yet: the invoice is saved, no email", async () => {
  await db.exec("delete from vault.decrypted_secrets");
  await send(A);
  assert.equal(await saved(), 1);
  assert.equal((await sent()).length, 0);
});

test("a key pasted with a stray space or line break still works", async () => {
  await db.exec(`update vault.decrypted_secrets set decrypted_secret = E'  ${FAKE_KEY}\\r\\n'`);
  await send(A);
  assert.equal((await sent())[0].headers.Authorization, `Bearer ${FAKE_KEY}`);
});

test("the email side broken: the invoice is still saved, the restaurant sees nothing", async () => {
  await db.exec("insert into net.broken values ('down')");
  await send(A);
  assert.equal(await saved(), 1);
  assert.equal((await sent()).length, 0);
});

test("what a restaurant types can't break the email", async () => {
  await send(A, { name: "bad\r\nBcc: someone@example.com\n<b>name</b>.pdf", note: "<script>alert(1)</script> 100% %s\n" + "x".repeat(5000) });
  const { body } = (await sent())[0];
  assert.doesNotMatch(body.subject, /[\r\n]/);
  assert.equal(body.html, undefined, "plain text, so nothing in it can run");
  assert.ok(body.text.includes("<script>alert(1)</script> 100% %s"), "kept as typed");
  assert.ok(body.text.length < 3000, "a long note is cut");
  await send(A, { name: "y".repeat(500) });
  assert.ok((await sent())[1].body.subject.length < 150);
  await send(A, { name: "" });
  assert.match((await sent())[2].body.subject, /\(no name\)/);
});

test("no cap: every invoice sends its email, however many arrive in a day", async () => {
  for (let i = 0; i < 120; i++) await send(i % 2 ? A : B);
  assert.equal(await saved(), 120);
  assert.equal((await sent()).length, 120);
});

test("part 14 is safe to run twice: still one email", async () => {
  await asOwner(part14());
  await send(A);
  assert.equal((await sent()).length, 1);
});

/* ---------- Part 15: the alarm's check ---------- */

/** What GitHub's check does: calls the function with the public key. */
async function alarmSaysOk() {
  await db.exec("set role anon;");
  try {
    return (await db.query("select public.invoice_email_check() as ok")).rows[0].ok;
  } finally {
    await db.exec("reset role;");
  }
}
/** Resend's or the network's answer to one email, as pg_net would record it. */
const answered = (status, ago = "1 minute", error = null) =>
  db.query("insert into net._http_response (id, status_code, error_msg, created) values (1, $1, $2, now() - $3::interval)", [status, error, ago]);
const ageInvoices = (ago) => db.query("update public.invoice_requests set created_at = now() - $1::interval", [ago]);

test("the alarm stays quiet when all is well: no invoices, or each one's email accepted", async () => {
  assert.equal(await alarmSaysOk(), true);
  await send(A);
  await ageInvoices("1 hour");
  await answered(200, "59 minutes");
  assert.equal(await alarmSaysOk(), true);
  await send(B);
  await ageInvoices("1 hour");
  await answered(200, "59 minutes");
  assert.equal(await alarmSaysOk(), true);
});

test("a brand-new invoice gets 10 minutes for its email to go out", async () => {
  await send(A);
  assert.equal(await alarmSaysOk(), true);
  await ageInvoices("11 minutes");
  assert.equal(await alarmSaysOk(), false);
});

test("the alarm goes off when an email is refused or gets no answer", async () => {
  for (const status of [401, 403, 422, 429, 500]) {
    await db.exec("delete from net._http_response");
    await answered(status);
    assert.equal(await alarmSaysOk(), false, String(status));
  }
  await db.exec("delete from net._http_response");
  await answered(null, "1 minute", "Timeout was reached");
  assert.equal(await alarmSaysOk(), false, "timed out");
  // One good answer doesn't hide a bad one.
  await answered(200);
  assert.equal(await alarmSaysOk(), false);
});

test("the alarm goes off when sending is stuck: more invoices than accepted emails", async () => {
  await send(A);
  await send(B);
  await ageInvoices("1 hour");
  assert.equal(await alarmSaysOk(), false, "no answer at all");
  await answered(200);
  assert.equal(await alarmSaysOk(), false, "one of two");
  await answered(200);
  assert.equal(await alarmSaysOk(), true);
});

test("the alarm goes off when the key isn't in the Vault, even with no invoices", async () => {
  await db.exec("delete from vault.decrypted_secrets");
  assert.equal(await alarmSaysOk(), false);
});

test("it stops by itself once a failure is 5 hours old", async () => {
  await answered(401, "5 hours 1 minute");
  await send(A);
  await ageInvoices("5 hours 1 minute");
  assert.equal(await alarmSaysOk(), true);
});

test("a busy day is no exception: every invoice needs its accepted email", async () => {
  for (let i = 0; i < 27; i++) await send(i % 2 ? A : B);
  await ageInvoices("1 hour");
  for (let i = 0; i < 26; i++) await answered(200);
  assert.equal(await alarmSaysOk(), false, "one short");
  await answered(200);
  assert.equal(await alarmSaysOk(), true);
});

test("the check says true or false and nothing else, and only the public key can ask", async () => {
  const { rows: [fn] } = await db.query(`select pronargs, provolatile, prosecdef, proconfig, prorettype::regtype::text rettype,
      has_function_privilege('anon', oid, 'execute') anon, has_function_privilege('authenticated', oid, 'execute') auth
    from pg_proc where proname = 'invoice_email_check'`);
  assert.equal(fn.rettype, "boolean");
  assert.equal(fn.pronargs, 0);
  assert.equal(fn.provolatile, "s", "it can't change anything, and works with a plain GET");
  assert.equal(fn.prosecdef, true);
  assert.deepEqual(fn.proconfig, ['search_path=""']);
  assert.equal(fn.anon, true);
  assert.equal(fn.auth, false);
});

/* ---------- Part 15: the weekly test ---------- */

const weeklyTest = () => db.query("select public.invoice_email_weekly_test()");

test("the weekly test emails the owner the way an invoice does, with how many invoices are waiting", async () => {
  await send(A);
  await send(B);
  await db.exec("delete from net.sent");
  await weeklyTest();
  const emails = await sent();
  assert.equal(emails.length, 1);
  const [{ url, body, headers }] = emails;
  assert.equal(url, "https://api.resend.com/emails");
  assert.equal(body.from, "Commis <noreply@example.com>");
  assert.deepEqual(body.to, ["you@example.com"]);
  assert.match(body.subject, /invoice emails are working/);
  assert.match(body.text, /Invoices waiting in invoice-inbox: 2\n/);
  assert.ok(body.text.includes("https://supabase.com/dashboard/project/YOUR-PROJECT-REF/storage/files/buckets/invoice-inbox"));
  assert.deepEqual(Object.keys(body).sort(), ["from", "subject", "text", "to"], "no attachment, no HTML");
  assert.equal(headers.Authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(headers["Content-Type"], "application/json");
  assert.ok(headers["User-Agent"]);
});

test("the weekly test says so out loud if the key is missing, and sends nothing", async () => {
  await db.exec("delete from vault.decrypted_secrets");
  await assert.rejects(weeklyTest(), /No resend_api_key in Vault/);
  assert.equal((await sent()).length, 0);
});

test("nobody outside can run the weekly test", async () => {
  const { rows: [fn] } = await db.query(`select prosecdef, proconfig,
      has_function_privilege('anon', oid, 'execute') anon, has_function_privilege('authenticated', oid, 'execute') auth
    from pg_proc where proname = 'invoice_email_weekly_test'`);
  assert.equal(fn.prosecdef, true);
  assert.deepEqual(fn.proconfig, ['search_path=""']);
  assert.equal(fn.anon, false);
  assert.equal(fn.auth, false);
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set role ${role};`);
    try {
      await assert.rejects(weeklyTest(), /permission denied/, role);
    } finally {
      await db.exec("reset role;");
    }
  }
  assert.equal((await sent()).length, 0);
});

test("the weekly test is scheduled once for Monday, and part 15 is safe to run twice", async () => {
  const jobs = async () => (await db.query("select * from cron.job")).rows;
  assert.deepEqual(await jobs(), [{ jobname: "commis-invoice-email-test", schedule: "17 13 * * 1", command: "select public.invoice_email_weekly_test()" }]);
  await asOwner(part15());
  assert.equal((await jobs()).length, 1);
  await send(A);
  assert.equal((await sent()).length, 1, "still one email per invoice");
});

test("part 15 turns on pg_cron the way Supabase documents, and leaves part 14 alone", () => {
  const guard = PG_CRON.exec(part(15));
  assert.ok(guard, "the guarded block");
  for (const line of ["create extension pg_cron with schema pg_catalog;", "grant usage on schema cron to postgres;", "grant all privileges on all tables in schema cron to postgres;"]) {
    assert.ok(guard[0].includes(line), line);
    assert.equal(part(15).split(line).length, 2, `only inside the block: ${line}`);
  }
  assert.doesNotMatch(part(15), /invoice_requests_notify|notify_invoice_request/);
});

// Supabase's setup script for pg_cron fails if it runs again ("dependent privileges exist"), so a second run must never reach it.
// pg_net has no such script today, but part 14 is pasted again too, so it's treated the same way.
for (const [name, regex, n] of [["pg_cron", PG_CRON, 15], ["pg_net", PG_NET, 14]]) {
  test(`part ${n} only creates ${name} when it isn't there yet, so running it again never reaches Supabase's setup script`, async () => {
    const guard = regex.exec(part(n))[0];
    assert.equal(part(n).match(/^\s*create extension/gm).length, 1, "nowhere else");
    await assert.rejects(asOwner(guard), new RegExp(name), "a new project: it tries to create it (PGlite has none to give)");
    await db.query("insert into pg_extension (oid, extname, extowner, extnamespace, extrelocatable, extversion) values (99999, $1, 10, 11, false, '1.0')", [name]);
    try {
      await asOwner(guard); // Already there: nothing is attempted, so nothing fails.
    } finally {
      await db.query("delete from pg_extension where extname = $1", [name]);
    }
  });
}

/* ---------- The schedule on GitHub ---------- */

test("part 14 turns on pg_net, and the email only goes after the PDF is in the bucket", () => {
  assert.ok(PG_NET.test(part(14)));
  const store = read("public", "store.js");
  const upload = store.indexOf("/storage/v1/object/invoice-inbox/"), row = store.indexOf('this._call("invoice_requests"');
  assert.ok(upload > 0 && row > upload);
});
