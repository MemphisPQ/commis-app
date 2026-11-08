# Commis

Free recipe costing, supplier invoices, monthly inventory and menus for restaurants. Built from real experience in restaurant kitchens, to make people's lives easier.

The service runs at **[commisapp.ca](https://commisapp.ca)**, free for every restaurant. You don't need any of this code to use it. This repository is for anyone who wants to read how it works, suggest something, or run their own copy.

## What it does

- **Recipe costing:** dishes and preps, down to the gram, with cost per portion, food cost and a target price that stay up to date as prices move.
- **Supplier invoices:** drop in a PDF and it reads the lines, remembers your item names and keeps each price's history. PDFs are read in the browser and don't leave it unless you choose to send one in.
- **Monthly inventory:** count on a phone or a printed sheet, see what it's worth, and keep a closed record of each month.
- **Menus:** a page for each menu, with menu lists, item details and recipe cards to download in Word and Excel.
- **Barback:** a bar's own side of the same account, in blue. Cocktails in ounces, bottles with their size and weights, and a monthly count of full bottles plus weighed opened ones. Cocktails can use the kitchen's items and preps at their prices today.
- **People in an account:** give staff access as administrators or employees, to the kitchen, Barback or both. Employees see costs, make their own recipes and add items with an estimated price for an administrator to check. The database itself decides who can change what. Recipes can be brought from your own account into a restaurant's.
- **Allergens:** tick what each item contains or may contain, and it adds them up through your recipes. It only knows what you enter, so always check your labels.

## Try it on your computer

You need [Node.js](https://nodejs.org). From this folder:

```
npx serve .
```

Then open `/public/` at the address it prints. With the settings left empty it runs in **local mode**: everything stays in that browser, with no account. Settings → Download backup saves it all as one file.

## Run your own copy

This is the version with sign-ups, for several restaurants. Run `node scripts/build-commis.js`, and it builds the site into `dist/commis/`, ready for any static host.

1. **Database:** create a [Supabase](https://supabase.com) project. In its SQL Editor, paste all of `supabase/schema.sql` and run it. It's safe to run again. Each account can only reach its own rows, enforced by row level security.
2. **Sign-ups:** in Authentication, turn on email sign-ups with "Confirm email". Set the Site URL and Redirect URLs to your address.
3. **Email:** Supabase's built-in sender only reaches your own team, so restaurants can't sign up without your own. Any SMTP provider works. We use [Resend](https://resend.com).
4. **Settings:** put your Project URL and publishable key in `sites/commis/config.js`. Both are safe to be public. Never put a secret key there. `barback: true` and `teams: true` there turn on Barback and people in an account; take either out to leave it off.
5. **Your own pages:** replace the name, `sites/commis/home.html` and the legal pages in `sites/commis/pages/`. They describe the service at commisapp.ca, not yours. See `NOTICE.md`.

Optional extras:

- **An email when someone sends you an invoice:** parts 14 and 15 of `supabase/schema.sql`. Replace `you@example.com`, `noreply@example.com` and `YOUR-PROJECT-REF` with your own first, and store your email key in Supabase's Vault as `resend_api_key`.
- **An anonymous error log:** run `supabase/client_errors.sql`.
- **A tip link:** set `support` in `sites/commis/config.js`. While it's empty, the link stays hidden.
- **Google Drive:** set up your own Google Cloud project and put its values in the config. Your app needs Google's review before other people can use it.

If you run it on a free Supabase project, note that free projects pause after a period of inactivity.

## Tests

```
npm ci
npm test
```

Invoices in the tests are made up.

## What isn't here

This is a clean copy of a private repository, so it starts with one commit. It leaves out private notes, and the import tools for one restaurant's own spreadsheets, along with the tests for those tools. Some code comments mention notes that aren't in this copy.

## Suggestions and problems

Open an issue. **If you find a security problem, please don't post it publicly.** Email [frznswts@gmail.com](mailto:frznswts@gmail.com) instead.

## Licence

The code is under the [MIT licence](LICENSE). The Commis name and the legal pages aren't covered: see [NOTICE.md](NOTICE.md).

Commis is made by Sweets Suite, in Quebec, Canada. If it helps your kitchen, you can [buy us a soda](https://ko-fi.com/commistips).
