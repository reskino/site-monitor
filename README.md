# Site Monitor

Checks your websites every 10 minutes, keeps sleepy free-tier hosts awake,
emails you when a site goes down, and shows everything on a dashboard.
Runs 24/7 in the cloud on **free GitHub Actions** — your computer can be off.

---

## One-time setup (about 15 minutes)

### 1. Make a free GitHub account
Go to <https://github.com> and sign up (free) if you don't have one.

### 2. Create a repository
- Click the **+** (top right) → **New repository**.
- Name it `site-monitor`.
- Keep it **Public** (there are no passwords in these files — email settings
  are stored separately as "Secrets"). Public also lets the dashboard work for free.
- Click **Create repository**.

### 3. Upload these files
On the new repo page click **uploading an existing file**, then drag in
**everything from this `site-monitor` folder** (including the hidden
`.github` folder and the `docs` folder). Click **Commit changes**.

> Prefer the command line? From this folder:
> ```
> git init && git add . && git commit -m "Site monitor"
> git branch -M main
> git remote add origin https://github.com/YOUR-USERNAME/site-monitor.git
> git push -u origin main
> ```

### 4. Add your sites
Open **`sites.json`** on GitHub → click the pencil ✏️ → replace the examples
with your real sites, and set `dashboardUrl` to
`https://YOUR-USERNAME.github.io/site-monitor/`. Commit the change.

```json
{
  "dashboardUrl": "https://YOUR-USERNAME.github.io/site-monitor/",
  "sites": [
    { "name": "My Portfolio", "url": "https://my-portfolio.com" },
    { "name": "Client Site",  "url": "https://client.com" }
  ]
}
```

### 5. Turn on the dashboard (GitHub Pages)
Repo **Settings** → **Pages** → under *Source* choose **Deploy from a branch**,
pick branch **main** and folder **/docs**, then **Save**.
Your dashboard will live at `https://YOUR-USERNAME.github.io/site-monitor/`.

### 6. Set up email alerts (recommended)
Repo **Settings** → **Secrets and variables** → **Actions** →
**New repository secret**. Add these five:

| Secret name | Value (for Gmail / Google Workspace) |
|-------------|--------------------------------------|
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `465` |
| `SMTP_USER` | your full email address |
| `SMTP_PASS` | a Gmail **App Password** (see below) |
| `ALERT_TO`  | where to send alerts (can be the same address) |

**Gmail App Password:** at <https://myaccount.google.com/security> turn on
**2-Step Verification**, then go to **App passwords**, create one named
"Site Monitor", and paste that 16-character code as `SMTP_PASS`
(not your normal login password).

> Using another email provider? Just use their SMTP host/port instead.
> Skipping email for now? That's fine — leave the secrets out and the
> dashboard still works; email just won't send.

### 7. Test it
Repo **Actions** tab → **Site Monitor** → **Run workflow**.
After a minute, open your dashboard URL. Done — the cloud now checks your sites
in the background around the clock, even when your computer is off.

> **How often does the cloud really check?** The workflow is *scheduled* for
> every 10 minutes, but GitHub's free scheduler is heavily throttled and often
> only runs it every 1–3 hours under load. For **real-time** checks, run the
> live watcher on your PC (next section) — the two work together.

---

## Real-time monitoring on your PC (the live watcher)

For instant results — checks every 60 seconds, a dashboard that updates live,
and **desktop notifications** the moment a site goes down or recovers — run the
watcher on this machine:

    node watch.mjs

Then open **http://localhost:8787**. Leave it running; it checks continuously,
pops a Windows notification on any change, and shows the freshest data.

**Windows shortcut:** double-click **`start-watcher.cmd`** — it starts the
watcher and opens the dashboard for you.

Options:

    node watch.mjs --interval=30   # check every 30 seconds
    node watch.mjs --open          # also open the dashboard in your browser
    node watch.mjs --push          # also push results to the public GitHub dashboard

With `--push`, the watcher commits and pushes updates so your public
`github.io` dashboard stays fresh too (it pushes on any status change, and at
most once every 10 minutes otherwise). This is the **hybrid** setup: real-time
while your PC is on, GitHub Actions as the 24/7 fallback when it's off.

---

## Day-to-day

- **Add / remove a site (easiest):** repo **Actions** tab → **Manage sites** →
  **Run workflow**, type the address, click the green button. The dashboard also
  has an **"+ Add / manage sites"** button. (Or edit `sites.json` by hand.)
- **See status anytime:** your dashboard URL.
- **A site blocks bots (401/403 but is really up):** add `"expectStatus": 403`
  to that site in `sites.json`.

## What each site card shows

Click any site on the dashboard to expand its full detail:

- **Status, HTTP code, response time** and an uptime % from history.
- **SSL certificate** — issuer and exact expiry date, with a warning when it's
  within 21 days of expiring.
- **Domain registration** — registrar and expiry date (via RDAP/WHOIS), with a
  warning within 30 days. Never lose a site to a lapsed domain again.
- **Redirect chain** — every hop, so a broken redirect target is obvious.
- **Content check** — set `"expectText": "some phrase"` on a site in
  `sites.json` and it's only "up" if that phrase is on the page (catches blank
  or hacked pages that still return HTTP 200).
- **Subdomains** — automatically discovered from Certificate Transparency logs.
- **Incident history** — when it went down, and how long for.

## Monitoring subdomains

The dashboard auto-discovers subdomains for each site and lists them in the
detail view. To actively *monitor* one (`blog.example.com`), add it like any
site (the **Manage sites** form or `sites.json`). You can also list them from
the command line:

    node find-subdomains.mjs example.com

Ignore plumbing entries like `cpanel.`, `webmail.`, `webdisk.`, `mail.`,
`cpcalendars.` — those aren't public web pages, just hosting services.

## Good to know
- The **live watcher** (`node watch.mjs`) gives real-time results; GitHub
  Actions is the always-on fallback. Use both for full coverage.
- A cold/sleeping host can take 30–60s to answer the first time; the monitor
  retries and marks slow-but-alive sites as **Slow** (no alert for those).
- You only get alerted when a site is genuinely **down** (after 3 retries) or
  something is about to expire — so no spam.
- SSL & domain expiry data is cached and refreshed periodically (12h for
  domains, 3 days for subdomains) to stay fast and polite to those services.
