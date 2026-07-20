// Site Monitor — checks every site in sites.json, records the result,
// keeps sleepy hosts awake (the check IS the ping), and prepares an email
// alert when something is actually down. No external dependencies.

import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

// --- Tunables -------------------------------------------------------------
const TIMEOUT_MS = 60000; // give a cold/sleeping host up to 60s to wake up
const SLOW_MS = 8000; // slower than this = flag as "slow / waking up"
const RETRIES = 3; // re-try a failing site before calling it DOWN
const RETRY_DELAY_MS = 4000; // wait between retries (rides out brief blips)
const HISTORY_LIMIT = 2000; // how many past checks to keep for uptime %
// -------------------------------------------------------------------------

const config = JSON.parse(await readFile('sites.json', 'utf8'));
const sites = config.sites || [];
const dashboardUrl = config.dashboardUrl || '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function describeError(err) {
  if (err.name === 'AbortError') return `No response within ${TIMEOUT_MS / 1000}s`;
  const code = err.cause?.code;
  const map = {
    ENOTFOUND: 'Domain not found (DNS)',
    EAI_AGAIN: 'DNS lookup failed',
    ECONNREFUSED: 'Connection refused',
    ECONNRESET: 'Connection reset',
    ETIMEDOUT: 'Connection timed out',
    CERT_HAS_EXPIRED: 'SSL certificate expired',
  };
  return map[code] || code || err.message;
}

// A single request. Returns { up, status, ms, error }.
async function attempt(url, site) {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'SiteMonitor/1.0 (uptime + keep-alive)' },
    });
    clearTimeout(timer);
    const ms = Date.now() - start;
    // Any 2xx/3xx counts as "up". Some sites reply 401/403 to bots but are
    // really online — set "expectStatus" on that site to treat it as up.
    const up = (res.status >= 200 && res.status < 400) || site.expectStatus === res.status;
    return { up, status: res.status, ms, error: up ? null : `HTTP ${res.status}` };
  } catch (err) {
    clearTimeout(timer);
    return { up: false, status: 0, ms: Date.now() - start, error: describeError(err) };
  }
}

// A site is only DOWN after several attempts fail — one blip won't alert you.
async function check(site) {
  let url = site.url;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const name = site.name || url;

  let r;
  let tries = 0;
  for (let i = 0; i < RETRIES; i++) {
    tries++;
    r = await attempt(url, site);
    if (r.up) break;
    if (i < RETRIES - 1) await sleep(RETRY_DELAY_MS);
  }

  return {
    name,
    url,
    up: r.up,
    status: r.status,
    ms: r.ms,
    slow: r.up && r.ms > SLOW_MS,
    error: r.error,
    tries,
    checkedAt: new Date().toISOString(),
  };
}

// Check every site in parallel.
const results = await Promise.all(sites.map(check));

// --- Write the dashboard data --------------------------------------------
await mkdir('docs', { recursive: true });

const generatedAt = new Date().toISOString();
await writeFile(
  'docs/status.json',
  JSON.stringify({ generatedAt, dashboardUrl, results }, null, 2),
);

// Append a compact record to history (for uptime % + the little strip).
let history = [];
if (existsSync('docs/history.json')) {
  try {
    history = JSON.parse(await readFile('docs/history.json', 'utf8'));
  } catch {
    history = [];
  }
}
history.push({
  t: generatedAt,
  r: results.map((r) => ({ n: r.name, up: r.up, ms: r.ms })),
});
if (history.length > HISTORY_LIMIT) history = history.slice(-HISTORY_LIMIT);
await writeFile('docs/history.json', JSON.stringify(history));

// --- Console summary (shows in the Actions log) --------------------------
const down = results.filter((r) => !r.up);
const slow = results.filter((r) => r.up && r.slow);

console.log(`Checked ${results.length} site(s) at ${generatedAt}`);
for (const r of results) {
  const state = !r.up ? 'DOWN' : r.slow ? 'SLOW' : 'up';
  const note = !r.up ? `${r.error} (after ${r.tries} tries)` : `${r.status}`;
  console.log(`  [${state}] ${r.name} — ${note} (${r.ms} ms)`);
}

// --- Prepare the email alert (only when something is DOWN) ---------------
function buildEmailBody() {
  const lines = [];
  lines.push(`${down.length} of ${results.length} site(s) are DOWN as of ${generatedAt}.`);
  lines.push('');
  lines.push('DOWN:');
  for (const r of down) lines.push(`  - ${r.name} (${r.url}) — ${r.error}`);
  if (slow.length) {
    lines.push('');
    lines.push('Slow to respond (may have just woken from sleep):');
    for (const r of slow) lines.push(`  - ${r.name} (${r.url}) — ${(r.ms / 1000).toFixed(1)}s`);
  }
  if (dashboardUrl) {
    lines.push('');
    lines.push(`Dashboard: ${dashboardUrl}`);
  }
  return lines.join('\n');
}

// Hand results to the GitHub Actions workflow so it can decide to email.
if (process.env.GITHUB_OUTPUT) {
  const hasProblems = down.length > 0;
  const subject =
    down.length === 1 ? `[ALERT] 1 site is down` : `[ALERT] ${down.length} sites are down`;

  await appendFile(process.env.GITHUB_OUTPUT, `has_problems=${hasProblems}\n`);
  await appendFile(process.env.GITHUB_OUTPUT, `email_subject=${subject}\n`);
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `email_body<<SITE_MONITOR_EOF\n${buildEmailBody()}\nSITE_MONITOR_EOF\n`,
  );
}
