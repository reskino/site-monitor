// Site Monitor — the core run. Checks every site in sites.json and writes rich
// data for the dashboard: uptime, response time, SSL + domain expiry, redirect
// chains, content checks, subdomains, and an incident log. No dependencies.
//
// Used by both the local real-time watcher (watch.mjs) and GitHub Actions.
//   node check.mjs        -> run once, write docs/*.json

import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import {
  checkHttp, checkTls, checkDomainExpiry, discoverSubdomains,
  normalizeUrl, registrableDomain, sleep,
} from './lib/checks.mjs';

// --- Tunables -------------------------------------------------------------
export const TUNE = {
  TIMEOUT_MS: 45000,       // per-request timeout
  SLOW_MS: 8000,           // slower than this = "slow"
  RETRIES: 3,              // failed attempts before a site is DOWN
  RETRY_DELAY_MS: 3000,    // wait between retries
  HISTORY_LIMIT: 3000,     // checks kept per history file
  INCIDENT_LIMIT: 500,     // incidents kept
  DOMAIN_TTL_MS: 12 * 3600e3,   // re-fetch RDAP domain expiry this often
  SUBDOMAIN_TTL_MS: 3 * 86400e3, // re-fetch crt.sh subdomains this often
  RETRY_TTL_MS: 3600e3,         // if a meta lookup failed, retry after this
  TLS_WARN_DAYS: 21,       // warn when a cert expires within this many days
  DOMAIN_WARN_DAYS: 30,    // warn when a domain expires within this many days
};

const readJson = async (path, fallback) => {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
};

// One site: HTTP (with retries) + a fresh SSL check.
async function checkSite(site) {
  const url = normalizeUrl(site.url);
  const name = site.name || new URL(url).host;
  const host = new URL(url).host;

  let http;
  let tries = 0;
  for (let i = 0; i < TUNE.RETRIES; i++) {
    tries++;
    http = await checkHttp(url, {
      timeoutMs: TUNE.TIMEOUT_MS,
      expectStatus: site.expectStatus,
      expectText: site.expectText,
    });
    if (http.up) break;
    if (i < TUNE.RETRIES - 1) await sleep(TUNE.RETRY_DELAY_MS);
  }

  const tls = await checkTls(host, { timeoutMs: 15000 });

  return {
    name,
    url,
    host,
    up: http.up,
    status: http.status,
    ms: http.ms,
    slow: http.up && http.ms > TUNE.SLOW_MS,
    error: http.error,
    finalUrl: http.finalUrl,
    redirects: http.redirects,
    redirected: http.finalUrl !== url,
    contentOk: http.contentOk,
    expectText: site.expectText || null,
    tries,
    ssl: tls.ok
      ? { issuer: tls.issuer, validTo: tls.validTo, daysLeft: tls.daysLeft, valid: tls.authorized, warn: tls.daysLeft <= TUNE.TLS_WARN_DAYS }
      : { error: tls.error },
    checkedAt: new Date().toISOString(),
  };
}

// Slow-changing data (domain expiry, subdomains) cached per registrable domain.
async function refreshMeta(sites, meta) {
  const now = Date.now();
  const domains = [...new Set(sites.map((s) => registrableDomain(new URL(normalizeUrl(s.url)).host)))];
  meta.domains = meta.domains || {};

  // Refresh if it's never succeeded, succeeded long ago (TTL), or last failed
  // long enough ago to retry — so a temporary outage (e.g. crt.sh 502) doesn't
  // freeze the data for the full TTL.
  const isDue = (okAt, failAt, ttl) => {
    if (okAt && now - new Date(okAt).getTime() <= ttl) return false;
    if (!okAt && failAt && now - new Date(failAt).getTime() <= TUNE.RETRY_TTL_MS) return false;
    return true;
  };

  await Promise.all(domains.map(async (d) => {
    const entry = (meta.domains[d] = meta.domains[d] || {});

    if (isDue(entry.domainOkAt, entry.domainFailAt, TUNE.DOMAIN_TTL_MS)) {
      const dom = await checkDomainExpiry(d);
      if (dom.ok) {
        entry.domain = { expiration: dom.expiration, registrar: dom.registrar, daysLeft: dom.daysLeft, warn: dom.daysLeft != null && dom.daysLeft <= TUNE.DOMAIN_WARN_DAYS };
        entry.domainOkAt = new Date().toISOString();
      } else {
        if (!entry.domain) entry.domain = { error: dom.error };
        entry.domainFailAt = new Date().toISOString();
      }
    }

    if (isDue(entry.subOkAt, entry.subFailAt, TUNE.SUBDOMAIN_TTL_MS)) {
      const sub = await discoverSubdomains(d);
      if (sub.ok) { entry.subdomains = sub.subdomains; entry.subOkAt = new Date().toISOString(); }
      else entry.subFailAt = new Date().toISOString();
    }
  }));

  return meta;
}

// Diff current vs previous to record incidents (state transitions).
function recordIncidents(prev, results, incidents, generatedAt) {
  const prevByName = new Map((prev?.results || []).map((r) => [r.name, r]));
  for (const r of results) {
    const before = prevByName.get(r.name);
    if (!before) continue; // first time we've seen this site
    const wasUp = before.up, isUp = r.up;
    if (wasUp && !isUp) {
      incidents.push({ name: r.name, url: r.url, type: 'down', at: generatedAt, error: r.error });
    } else if (!wasUp && isUp) {
      // Close the most recent open incident for this site.
      const open = [...incidents].reverse().find((i) => i.name === r.name && i.type === 'down' && !i.resolvedAt);
      if (open) {
        open.resolvedAt = generatedAt;
        open.downMs = new Date(generatedAt).getTime() - new Date(open.at).getTime();
      }
      incidents.push({ name: r.name, url: r.url, type: 'up', at: generatedAt });
    }
  }
  if (incidents.length > TUNE.INCIDENT_LIMIT) incidents = incidents.slice(-TUNE.INCIDENT_LIMIT);
  return incidents;
}

export async function runOnce({ log = () => {} } = {}) {
  const config = await readJson('sites.json', { sites: [] });
  const sites = config.sites || [];
  const dashboardUrl = config.dashboardUrl || '';

  await mkdir('docs', { recursive: true });
  const prev = await readJson('docs/status.json', null);
  let history = await readJson('docs/history.json', []);
  let incidents = await readJson('docs/incidents.json', []);
  let meta = await readJson('docs/meta.json', { domains: {} });

  const results = await Promise.all(sites.map(checkSite));

  // Attach cached domain/subdomain data to each result for easy rendering.
  meta = await refreshMeta(sites, meta);
  for (const r of results) {
    const d = registrableDomain(r.host);
    const m = meta.domains[d] || {};
    r.domain = m.domain || null;
    r.registrableDomain = d;
    r.subdomains = m.subdomains || [];
  }

  const generatedAt = new Date().toISOString();

  incidents = recordIncidents(prev, results, incidents, generatedAt);

  history.push({ t: generatedAt, r: results.map((r) => ({ n: r.name, up: r.up, ms: r.ms })) });
  if (history.length > TUNE.HISTORY_LIMIT) history = history.slice(-TUNE.HISTORY_LIMIT);

  await writeFile('docs/status.json', JSON.stringify({ generatedAt, dashboardUrl, results }, null, 2));
  await writeFile('docs/history.json', JSON.stringify(history));
  await writeFile('docs/incidents.json', JSON.stringify(incidents, null, 2));
  await writeFile('docs/meta.json', JSON.stringify(meta, null, 2));

  const down = results.filter((r) => !r.up);
  const slow = results.filter((r) => r.up && r.slow);
  const certWarn = results.filter((r) => r.ssl?.warn);
  const domWarn = results.filter((r) => r.domain?.warn);

  log(`Checked ${results.length} site(s) at ${generatedAt}`);
  for (const r of results) {
    const state = !r.up ? 'DOWN' : r.slow ? 'SLOW' : 'up';
    const note = !r.up ? `${r.error} (after ${r.tries} tries)` : `${r.status}`;
    log(`  [${state}] ${r.name} — ${note} (${r.ms} ms)`);
  }

  return { generatedAt, dashboardUrl, results, down, slow, certWarn, domWarn, incidents };
}

// --- GitHub Actions email hand-off (only used in CI) ----------------------
function buildEmailBody(run) {
  const { results, down, slow, certWarn, domWarn, dashboardUrl } = run;
  const L = [];
  L.push(`${down.length} of ${results.length} site(s) are DOWN as of ${run.generatedAt}.`, '');
  if (down.length) { L.push('DOWN:'); for (const r of down) L.push(`  - ${r.name} (${r.url}) — ${r.error}`); L.push(''); }
  if (slow.length) { L.push('Slow to respond:'); for (const r of slow) L.push(`  - ${r.name} — ${(r.ms / 1000).toFixed(1)}s`); L.push(''); }
  if (certWarn.length) { L.push('SSL certificates expiring soon:'); for (const r of certWarn) L.push(`  - ${r.name} — ${r.ssl.daysLeft} days`); L.push(''); }
  if (domWarn.length) { L.push('Domains expiring soon:'); for (const r of domWarn) L.push(`  - ${r.name} — ${r.domain.daysLeft} days`); L.push(''); }
  if (dashboardUrl) L.push(`Dashboard: ${dashboardUrl}`);
  return L.join('\n');
}

// Run directly (node check.mjs) — used by CI and manual runs.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('check.mjs')) {
  const run = await runOnce({ log: console.log });

  if (process.env.GITHUB_OUTPUT) {
    const problems = run.down.length + run.certWarn.length + run.domWarn.length;
    const subject = run.down.length
      ? (run.down.length === 1 ? '[ALERT] 1 site is down' : `[ALERT] ${run.down.length} sites are down`)
      : '[Site Monitor] Expiry warning';
    await appendFile(process.env.GITHUB_OUTPUT, `has_problems=${problems > 0}\n`);
    await appendFile(process.env.GITHUB_OUTPUT, `email_subject=${subject}\n`);
    await appendFile(process.env.GITHUB_OUTPUT, `email_body<<SITE_MONITOR_EOF\n${buildEmailBody(run)}\nSITE_MONITOR_EOF\n`);
  }
}
