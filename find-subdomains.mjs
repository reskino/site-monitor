// Discover subdomains for a domain using public Certificate Transparency logs
// (crt.sh) — a public record of every SSL certificate ever issued. Great for
// finding subdomains you forgot you had (blog., shop., staging., mail., ...).
//
// Usage:  node find-subdomains.mjs example.com
//
// It only LISTS what it finds — nothing is added automatically. Pick the ones
// you care about and add them with the "Manage sites" form (or sites.json).

const domain = (process.argv[2] || '').trim().toLowerCase();
if (!domain) {
  console.error('Usage: node find-subdomains.mjs example.com');
  process.exit(1);
}

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 45000);

let data;
try {
  const res = await fetch(`https://crt.sh/?q=%25.${encodeURIComponent(domain)}&output=json`, {
    headers: { 'User-Agent': 'SiteMonitor/1.0' },
    signal: controller.signal,
  });
  clearTimeout(timer);
  if (!res.ok) {
    console.error(`crt.sh returned HTTP ${res.status}. It can be busy — try again shortly.`);
    process.exit(1);
  }
  data = await res.json();
} catch (err) {
  console.error(
    'Could not reach crt.sh (' +
      (err.name === 'AbortError' ? 'timed out' : err.message) +
      '). Try again shortly.',
  );
  process.exit(1);
}

const found = new Set();
for (const row of data) {
  for (const name of String(row.name_value || '').split('\n')) {
    const n = name.trim().toLowerCase();
    if (n && !n.startsWith('*.') && n.endsWith(domain)) found.add(n);
  }
}

const subs = [...found].sort();
console.log(`Found ${subs.length} name(s) for ${domain} in certificate logs:`);
for (const s of subs) console.log('  ' + s);
