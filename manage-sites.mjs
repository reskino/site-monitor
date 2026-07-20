// Adds or removes a site in sites.json. Driven by the "Manage sites" workflow
// (Actions tab), so you can add a site from any browser without editing files.

import { readFile, writeFile } from 'node:fs/promises';

const action = (process.env.ACTION || 'add').toLowerCase();
const rawUrl = (process.env.SITE_URL || '').trim();
const name = (process.env.SITE_NAME || '').trim();
const expectStatus = (process.env.EXPECT_STATUS || '').trim();

if (!rawUrl) {
  console.error('No URL provided.');
  process.exit(1);
}

// Accept "example.com" or "https://example.com" — add https:// if missing.
let url = rawUrl;
if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

let host;
try {
  host = new URL(url).host.replace(/^www\./, '');
} catch {
  console.error('That does not look like a valid web address: ' + rawUrl);
  process.exit(1);
}

const config = JSON.parse(await readFile('sites.json', 'utf8'));
config.sites = config.sites || [];

const sameSite = (u) => {
  try {
    return new URL(u).host.replace(/^www\./, '') === host;
  } catch {
    return false;
  }
};

if (action === 'remove') {
  const before = config.sites.length;
  config.sites = config.sites.filter((s) => !sameSite(s.url));
  console.log(`Removed ${before - config.sites.length} site(s) matching ${host}.`);
} else {
  if (config.sites.some((s) => sameSite(s.url))) {
    console.log(`${host} is already on the list — nothing to add.`);
  } else {
    const entry = { name: name || host, url };
    if (expectStatus) entry.expectStatus = Number(expectStatus);
    config.sites.push(entry);
    console.log(`Added ${entry.name} (${entry.url}).`);
  }
}

await writeFile('sites.json', JSON.stringify(config, null, 2) + '\n');
