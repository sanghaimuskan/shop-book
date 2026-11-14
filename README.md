# Shop Book

An installable web app (PWA) for running a small shop. It covers customer dues with bill photos, call and WhatsApp reminders, stock with buying, wholesale and retail prices, bills you can speak aloud, and printing. It works on Android, iPhone, and desktop from one codebase. It also works fully offline and backs up to the cloud when the internet comes back.

No build step: these are plain static files.

## How the data is protected

There are five layers, and each works on its own:

1. **On the device (IndexedDB).** Every change is saved locally first, so the app never needs the internet to work. The app asks the browser for *persistent storage* so the phone doesn't clear it when space runs low.
2. **Cloud sync (Supabase Postgres).** Changes upload within seconds of going online. A new or replacement phone gets everything back after sign-in.
3. **Nothing is ever hard-deleted.** "Remove" only marks a row, and the database role has no DELETE permission at all. Dues are a ledger of `+bill` and `−payment` entries, never a single stored balance, so two devices editing at once can't corrupt the totals. Stale writes from an old device are rejected by a trigger.
4. **Nightly encrypted dump** to GitHub via `.github/workflows/backup.yml`. These are kept for 90 days and are independent of Supabase.
5. **A copy in your own hands.** Settings → *Download full backup* saves a JSON file (to Drive, WhatsApp, or wherever), and *Restore from backup* merges it back in. The app reminds you weekly.

On top of these, Supabase's paid plan adds daily backups and point-in-time recovery. For real business records it's worth it; check current pricing.

## Setup (about 20 minutes)

### 1. Supabase
1. Create a project at supabase.com. Pick the **Mumbai (ap-south-1)** region.
2. **SQL Editor → New query**: paste `supabase/schema.sql` and run it. This creates the tables, security rules, and the private `bill-photos` storage bucket.
3. **Authentication → Sign In / Providers → Email**: turn **off** "Confirm email" and save. The app signs in with email and password, so no emails are ever sent. That avoids Supabase's email limits and the need for your own email server.
4. **Project Settings → API**: copy the Project URL and the anon (publishable) key into `js/config.js`.
5. On the first device, tap **Create the shop account** and choose a password (8+ characters). On every other device, use **Sign in** with the same email and password. Then turn off new sign-ups at **Authentication → Sign In / Providers → "Allow new users to sign up" → off**, so nobody else can create an account.
   Everyone who should see the same shop uses **the same email**; each email account has its own separate data.

Keep the password somewhere safe. If it's lost, set a new one from Supabase → Authentication → Users → select the user. **Never delete the user**: their records are deleted with them.

### 2. Try it locally
```
cd shop-book
python3 -m http.server 8080     # or: npx serve .
```
Open http://localhost:8080. Service workers and the microphone work on localhost without HTTPS.

### 3. Deploy (any static host with HTTPS)
- **Netlify / Cloudflare Pages / Vercel**: drag and drop the folder, or connect the repo with no build command and the root as the output directory.
- **GitHub Pages**: push to a repo and enable Pages. All paths are relative, so a sub-path works.

**After every change you deploy, bump `VERSION` in `sw.js`**, otherwise phones keep the cached copy. The app shows an "Update now" banner when a new version arrives.

### 4. Install on each device
- **Android (Chrome):** open the site → menu → *Install app* (or *Add to Home screen*).
- **iPhone (Safari):** Share → *Add to Home Screen*. This must be Safari; other iOS browsers can't install apps.
- **Desktop (Chrome / Edge):** use the install icon in the address bar.

### 5. Nightly backup (recommended)
Push the folder to a **private** GitHub repo and add two secrets (Settings → Secrets and variables → Actions):
- `SUPABASE_DB_URL`: Supabase → **Connect** → *Session pooler* URI, with the database password filled in.
- `BACKUP_PASSPHRASE`: a long passphrase. Save it somewhere outside GitHub too.

Run it once by hand (Actions → *Nightly database backup* → Run workflow) to confirm it works. To open a backup: `gpg -d shop-book-DATE.tar.gz.gpg | tar xz`.

Bill **photos** live in Supabase Storage and are not part of the SQL dump. They're also kept on the phone that took them.

## Using it

- **Dues:** take a photo of a bill or add one by hand, and the customer is created automatically. *Got payment / history* records a payment and shows every entry with its photos.
- **Stock:** enter buying, wholesale and retail prices to see profit per unit and margin. Stock goes down automatically when a bill is saved, and comes back if the bill is cancelled.
- **New bill:** tap the mic and speak, for example:
  *"Ramesh 98400 12345 from Tambaram, rice 5 kg at 60, sugar 2 kg at 45, oil 1 litre for 160, paid 200, done."*
  - "at / into / x / each" means price per unit; "for / total" means price for that whole line.
  - If no price is said, the retail price from Stock is used.
  - If the mic isn't available, type the same sentence instead.
  - Any amount left unpaid goes to that customer's dues.
- **Printing:** in Settings, choose a normal printer (A5) or a 58 mm thermal printer. On Android, most Bluetooth thermal printers work through their maker's print-service app or a "RawBT"-style driver, which then shows up in the normal print dialog.

## Known limits

- **Voice input** uses the browser's speech recognition. It works well in Chrome on Android and desktop. On iPhone, support depends on the iOS version, so typing is the reliable fallback. Speech is recognised by Google/Apple servers, so voice entry needs internet; everything else works offline.
- **Bill photos aren't read automatically yet.** The photo is stored with the due entry, and the amount is typed in. Automatic reading can be added later with a Supabase Edge Function calling an OCR or vision API.
- **Stock quantities** use last-write-wins. If two phones sell the same item while both are offline, one decrement can be lost. Money is not affected, because dues use the ledger.
- **Bill numbers** (`YYMMDD-n`) are per device. Two phones billing offline on the same day can repeat a number. Records stay separate because each has its own ID.

## Files

```
index.html             app shell
app.css                styles (light + dark)
js/app.js              screens and business logic
js/db.js               on-device database + upload queue
js/sync.js             Supabase sync (push, pull, photos)
js/parse.js            speech/typed bill → items
js/config.js           your Supabase URL + key
sw.js                  offline support and updates
manifest.webmanifest   install info and icons
vendor/supabase.js     supabase-js 2.45.4 (bundled so the app loads offline)
supabase/schema.sql    database, security, storage
.github/workflows/backup.yml   nightly encrypted backup
```
