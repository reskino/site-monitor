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
After a minute, open your dashboard URL. Done — it now checks every 10 minutes on its own.

---

## Day-to-day

- **Add / remove a site (easiest):** repo **Actions** tab → **Manage sites** →
  **Run workflow**, type the address, click the green button. The dashboard also
  has an **"+ Add / manage sites"** button. (Or edit `sites.json` by hand.)
- **See status anytime:** your dashboard URL.
- **A site blocks bots (401/403 but is really up):** add `"expectStatus": 403`
  to that site in `sites.json`.

## Monitoring subdomains

A subdomain is just another web address, so it's monitored exactly like any
site. To watch `blog.example.com`, add it the same way (the **Manage sites**
form or `sites.json`).

**Forgot which subdomains you have?** Run the finder — it lists every subdomain
that ever had an SSL certificate (from public Certificate Transparency logs):

    node find-subdomains.mjs example.com

It only lists them; you pick which to add. Ignore plumbing entries like
`cpanel.`, `webmail.`, `webdisk.`, `mail.`, `cpcalendars.` — those aren't public
web pages, just hosting services.

## Good to know
- GitHub sometimes delays scheduled runs by a few minutes when it's busy — normal.
- A cold/sleeping host can take 30–60s to answer the first time; the monitor
  waits up to 60s and marks slow-but-alive sites as **Slow** (no email for those).
- You only get an email when a site is genuinely **down**, so no inbox spam.
