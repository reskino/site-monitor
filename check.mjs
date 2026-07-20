// Site Monitor — checks every site in sites.json, records the result,
// keeps sleepy hosts awake (the check IS the ping), and prepares an email
// alert when something is actually down. No external dependencies.

import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

// --- Tunables -------------------------------------------------------------
const TIMEOUT_MS = 60000; // give a cold/sleeping host up to 60s to wake up
const SLOW_MS = 8000; // slower than this = flag as "slow / waking up"
const HISTORY_LIMIT = 2000; // how many past checks to keep for uptime %
// -------------------------------------------------------------------------

const config = JSON.parse(await readFile('sites.json', 'utf8'));
const sites = config.sites || [];
const dashboardUrl = config.dashboardUrl || '';

async function check(site) {
  const url = site.url;
  const name = site.name || url;
  const start = Date.now();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

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
    const up =
      (res.status >= 200 && res.status < 400) || site.expectStatus === res.status;

    return {
      name,
      url,
      up,
      status: res.status,
      ms,
      slow: up && ms > SLOW_MS,
      error: up ? null : `HTTP ${res.status}`,
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    const ms = Date.now() - start;
    let error;
    if (err.name === 'AbortError') {
      error = `No response within ${TIMEOUT_MS / 1000}s`;
    } else {
      // Surface the real cause where we can (DNS, refused connection, TLS…).
      const code = err.cause?.code;
      const map = {
        ENOTFOUND: 'Domain not found (DNS)',
        EAI_AGAIN: 'DNS lookup failed',
        ECONNREFUSED: 'Connection refused',
        ECONNRESET: 'Connection reset',
        ETIMEDOUT: 'Connection timed out',
        CERT_HAS_EXPIRED: 'SSL certificate expired',
      };
      error = map[code] || code || err.message;
    }
    return {
      name,
      url,
      up: false,
      status: 0,
      ms,
      slow: false,
      error,
      checkedAt: new Date().toISOString(),
    };
  }
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
  console.log(`  [${state}] ${r.name} — ${r.up ? r.status : r.error} (${r.ms} ms)`);
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
    down.length === 1
      ? `[ALERT] 1 site is down`
      : `[ALERT] ${down.length} sites are down`;

  await appendFile(process.env.GITHUB_OUTPUT, `has_problems=${hasProblems}\n`);
  await appendFile(process.env.GITHUB_OUTPUT, `email_subject=${subject}\n`);
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `email_body<<SITE_MONITOR_EOF\n${buildEmailBody()}\nSITE_MONITOR_EOF\n`,
  );
}
