// Rich checks for the Site Monitor. Zero external dependencies — only Node
// built-ins. Every function is defensive: it returns a partial result and an
// `error` string instead of throwing, so one failing check never breaks a run.

import tls from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';

// --- Small helpers --------------------------------------------------------

export const sleep = (ms) => delay(ms);

// Turn a URL or bare host into a clean https URL.
export function normalizeUrl(input) {
  let url = String(input || '').trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  return url;
}

// The registrable ("eTLD+1") domain — what a WHOIS/RDAP lookup wants.
// Handles the common multi-part public suffixes without a full PSL dependency.
const MULTI_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk', 'gov.uk', 'ac.uk',
  'com.au', 'net.au', 'org.au', 'com.br', 'com.cn', 'com.mx', 'co.nz', 'co.za', 'co.in',
  'com.gh', 'org.gh', 'com.ng', 'co.ke',
]);

export function registrableDomain(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  const lastTwo = parts.slice(-2).join('.');
  const lastThree = parts.slice(-3).join('.');
  if (MULTI_PART_TLDS.has(lastTwo)) return lastThree;
  return lastTwo;
}

function describeError(err, timeoutMs) {
  if (err.name === 'AbortError') return `No response within ${Math.round(timeoutMs / 1000)}s`;
  const code = err.cause?.code || err.code;
  const map = {
    ENOTFOUND: 'Domain not found (DNS)',
    EAI_AGAIN: 'DNS lookup failed',
    ECONNREFUSED: 'Connection refused',
    ECONNRESET: 'Connection reset',
    ETIMEDOUT: 'Connection timed out',
    CERT_HAS_EXPIRED: 'SSL certificate expired',
    ERR_TLS_CERT_ALTNAME_INVALID: 'SSL certificate name mismatch',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'SSL certificate not trusted',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'SSL certificate self-signed',
  };
  return map[code] || code || err.message;
}

// --- HTTP check -----------------------------------------------------------
// Follows redirects manually so we can report the redirect chain and give a
// clear message when a redirect points somewhere broken (a common misconfig).

export async function checkHttp(url, { timeoutMs = 60000, userAgent, expectStatus, expectText } = {}) {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const chain = [];
  let current = url;

  try {
    for (let hop = 0; hop < 10; hop++) {
      const res = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': userAgent || 'SiteMonitor/2.0 (+uptime)' },
      });

      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        const next = new URL(res.headers.get('location'), current).toString();
        chain.push({ from: current, status: res.status, to: next });
        current = next;
        continue;
      }

      // Terminal response.
      const ms = Date.now() - start;
      let bodyText = '';
      if (expectText) {
        try { bodyText = (await res.text()).slice(0, 200000); } catch {}
      } else {
        // Drain so the socket can be reused / closed cleanly.
        try { await res.arrayBuffer(); } catch {}
      }
      clearTimeout(timer);

      const statusOk = (res.status >= 200 && res.status < 400) || expectStatus === res.status;
      const contentOk = !expectText || bodyText.toLowerCase().includes(String(expectText).toLowerCase());
      const up = statusOk && contentOk;
      let error = null;
      if (!statusOk) error = `HTTP ${res.status}`;
      else if (!contentOk) error = `Expected text not found: "${expectText}"`;

      return {
        up,
        status: res.status,
        ms,
        finalUrl: current,
        redirects: chain,
        contentOk: expectText ? contentOk : null,
        error,
      };
    }
    clearTimeout(timer);
    return { up: false, status: 0, ms: Date.now() - start, finalUrl: current, redirects: chain, contentOk: null, error: 'Too many redirects' };
  } catch (err) {
    clearTimeout(timer);
    let msg = describeError(err, timeoutMs);
    // Make broken-redirect targets obvious instead of a bare DNS error.
    if (chain.length) {
      const target = new URL(current).host;
      msg = `Redirects to ${target} which fails: ${msg}`;
    }
    return { up: false, status: 0, ms: Date.now() - start, finalUrl: current, redirects: chain, contentOk: null, error: msg };
  }
}

// --- SSL certificate check ------------------------------------------------
// Opens a TLS socket and reads the peer certificate. Returns issuer + expiry.

export function checkTls(host, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => { if (!done) { done = true; try { socket.destroy(); } catch {} resolve(val); } };

    const socket = tls.connect(
      { host, port: 443, servername: host, rejectUnauthorized: false, timeout: timeoutMs },
      () => {
        const cert = socket.getPeerCertificate();
        if (!cert || !cert.valid_to) return finish({ ok: false, error: 'No certificate' });
        const validTo = new Date(cert.valid_to);
        const validFrom = new Date(cert.valid_from);
        const daysLeft = Math.floor((validTo.getTime() - Date.now()) / 86400000);
        const issuer = cert.issuer?.O || cert.issuer?.CN || 'Unknown';
        finish({
          ok: true,
          issuer,
          validFrom: validFrom.toISOString(),
          validTo: validTo.toISOString(),
          daysLeft,
          authorized: socket.authorized,
          authError: socket.authorizationError ? String(socket.authorizationError) : null,
          error: null,
        });
      },
    );
    socket.on('timeout', () => finish({ ok: false, error: 'TLS timeout' }));
    socket.on('error', (err) => finish({ ok: false, error: err.code || err.message }));
  });
}

// --- Domain (WHOIS) expiry via RDAP ---------------------------------------
// RDAP is the modern, JSON-over-HTTPS successor to WHOIS. rdap.org bootstraps
// to the right registry. Not every TLD is covered — we return null gracefully.

export async function checkDomainExpiry(domain, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
      headers: { 'User-Agent': 'SiteMonitor/2.0', Accept: 'application/rdap+json' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, error: `RDAP HTTP ${res.status}` };
    const data = await res.json();
    const events = data.events || [];
    const find = (a) => events.find((e) => e.eventAction === a)?.eventDate || null;
    const expiration = find('expiration');
    const registration = find('registration');
    const registrar = (data.entities || []).find((e) => (e.roles || []).includes('registrar'));
    const registrarName = registrar?.vcardArray?.[1]?.find((x) => x[0] === 'fn')?.[3] || null;
    let daysLeft = null;
    if (expiration) daysLeft = Math.floor((new Date(expiration).getTime() - Date.now()) / 86400000);
    return {
      ok: true,
      expiration,
      registration,
      registrar: registrarName,
      status: data.status || [],
      daysLeft,
      error: expiration ? null : 'No expiration date published',
    };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, error: err.name === 'AbortError' ? 'RDAP timeout' : err.message };
  }
}

// --- Subdomain discovery via Certificate Transparency (crt.sh) ------------

export async function discoverSubdomains(domain, { timeoutMs = 45000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://crt.sh/?q=%25.${encodeURIComponent(domain)}&output=json`, {
      headers: { 'User-Agent': 'SiteMonitor/2.0' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, error: `crt.sh HTTP ${res.status}`, subdomains: [] };
    const data = await res.json();
    const found = new Set();
    for (const row of data) {
      for (const name of String(row.name_value || '').split('\n')) {
        const n = name.trim().toLowerCase();
        if (n && !n.startsWith('*.') && n.endsWith(domain)) found.add(n);
      }
    }
    return { ok: true, subdomains: [...found].sort(), error: null };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, error: err.name === 'AbortError' ? 'crt.sh timeout' : err.message, subdomains: [] };
  }
}
