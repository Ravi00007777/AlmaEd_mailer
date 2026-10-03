# AlmaEd Mailer

Outreach tools for **AlmaED**, which offers 1-on-1 mentoring by IIT, NIT and AIIMS students. Both tools read the alumni list from the same Google Sheet.

| Folder | What it does | Runs on |
| --- | --- | --- |
| [`email/`](email/) | Sends a personalised email to every alumnus in the Sheet, about 100 a day, and marks each row as Sent | Google Apps Script, inside the Sheet |
| [`whatsapp-engine/`](whatsapp-engine/) | Sends the WhatsApp opener a few at a time from a spare number. Positive replies get the details and demo link automatically, and other replies wait for you on a dashboard | Your laptop (Windows or Mac), using [gowa](https://github.com/aldinokemal/go-whatsapp-web-multidevice) |

> **No personal data goes in this repo.** The alumni Sheet, the downloaded `.xlsx`, the engine's progress (`data/`), logs and the WhatsApp session all stay on your machine. `.gitignore` keeps them out.

---

## Email (Google Apps Script)

1. Open the alumni Google Sheet while signed in to the account the emails should come from.
2. Go to **Extensions → Apps Script**, replace the sample code with [`email/AlmaED_Email.gs`](email/AlmaED_Email.gs) and save. Then reload the Sheet.
3. Use the new **AlmaED Email** menu:
   1. **Set up / refresh email list.** This builds the *Email list* tab and skips people the call notes say not to contact.
   2. **Send a test email to me.**
   3. **Send next batch now**, or **Start auto-send (hourly)**.
4. Edit the subject, body and daily limit in the *Email template* tab. No code changes are needed.

## WhatsApp engine (Node.js + gowa)

**Requirements:** [Node.js](https://nodejs.org) LTS, and gowa v9.5.0 from the [gowa releases page](https://github.com/aldinokemal/go-whatsapp-web-multidevice/releases/tag/v9.5.0):

| Your laptop | Download | File to put in `whatsapp-engine/gowa/` |
| --- | --- | --- |
| Windows | `whatsapp_9.5.0_windows_amd64.zip` | `windows-amd64.exe` |
| Mac (Apple chip) | `whatsapp_9.5.0_darwin_arm64.zip` | `darwin-arm64` |
| Mac (Intel) | `whatsapp_9.5.0_darwin_amd64.zip` | `darwin-amd64` |

```bash
cd whatsapp-engine
npm install
# 1. In Google Sheets: File -> Download -> Microsoft Excel (.xlsx), and put the file in this folder
# 2. Put your own number in config.json -> "testNumber"
npm start          # or double-click "Start AlmaED WhatsApp.bat" / ".command"
```

The dashboard opens at <http://localhost:4000>. From there:

1. Click **Show QR code** and scan it from the spare phone (WhatsApp → Linked devices → Link a device).
2. Click **Send test to my number**.
3. Click **Start sending**.

Plain-language instructions and troubleshooting are in [`whatsapp-engine/SETUP GUIDE.txt`](whatsapp-engine/SETUP%20GUIDE.txt).

### How it works

- **Contacts:** read from every region tab's *WA number* column, with duplicates merged. People whose call notes say *not interested*, *wrong number*, *blocked*, *not an alumnus* or *passed away* are skipped.
- **Pacing:** warm-up of 15, then 25, then 35 messages a day, and then `dailyLimit` (default 50). Each message waits a random 90–240 s and runs only between 10:00 and 19:00 IST. A typing indicator shows before each message, and greeting variations (`[[Hi|Hello]]`) keep messages from being identical.
- **Replies:** come in through gowa's signed webhook. *Yes / please share / my son…* automatically get the details message. *No / not interested / stop* are closed. Questions go to **Needs your reply** on the dashboard.
- **Messages:** live in `messages.json`, and the limits and hours in `config.json`. The gowa password and webhook secret are generated on the first run.
- **Code:** `src/index.js` (engine and dashboard API), `src/rules.js` (names, numbers, opt-outs, reply classification), `src/importer.js` (Sheet import), `src/gowa.js` (gowa API and process manager), and `public/dashboard.html`.

### Safety

Use a **spare WhatsApp number**, not the one your students and parents use. Keep `dailyLimit` at 80 or below. gowa is an unofficial WhatsApp client, so numbers that send many cold messages can be banned.

### Cloud (experimental): Vercel + Supabase

The same engine and dashboard can run without a laptop. Vercel can't keep gowa running between requests, so every 2 minutes Supabase's `pg_cron` calls `/api/tick`. Each call starts gowa for up to about 4 minutes, sends what is due and collects replies, then shuts gowa down. The WhatsApp login is stored in Supabase Postgres, and engine state is stored in one Supabase row.

**Trade-offs:** replies are picked up in batches, within about 2 minutes while sending and every 15 minutes when idle. Reconnecting often can raise the ban risk. Vercel's free Hobby plan is for non-commercial use only, so check its terms and keep an eye on the *Usage* tab.

1. **Supabase:** create a project, then in *SQL Editor* run parts 1 and 2 of [`whatsapp-engine/supabase.sql`](whatsapp-engine/supabase.sql), with your own gowa password filled in.
2. **Vercel:** `npm i -g vercel`, then `cd whatsapp-engine && vercel`, and add these environment variables (Project → Settings → Environment Variables):

   | Variable | Value |
   | --- | --- |
   | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API |
   | `GOWA_DB_URI` | Supabase → Connect → **Session pooler** URI, with the user changed to `gowa.<project-ref>` and the password from step 1, plus `?sslmode=require` |
   | `DASHBOARD_PASSWORD` | the dashboard password (any username works) |
   | `CRON_SECRET` | a random string, e.g. `openssl rand -hex 24` |
   | `TEST_NUMBER` | your own number, for *Send test to my number* |

   Then run `vercel --prod`. The build downloads gowa's Linux binary.
3. **Supabase again:** run part 3 of `supabase.sql`, with your Vercel URL and `CRON_SECRET` filled in.
4. Open the Vercel URL, link WhatsApp (use the QR code or the pairing code), and upload the `.xlsx` with **Import**.

`node whatsapp-engine/test/cloud.test.js` checks the auth, lock and action-queue paths against a fake Supabase.
