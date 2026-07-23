// Local real-time watcher. Runs the checks on a short interval, serves the
// dashboard locally (so you see updates the instant they happen), pops a
// desktop notification whenever a site changes state or something is expiring,
// and can optionally push results to GitHub so the public dashboard updates too.
//
//   node watch.mjs                 real-time, dashboard at http://localhost:8787
//   node watch.mjs --interval=30   check every 30s
//   node watch.mjs --push          also commit+push results to GitHub
//   node watch.mjs --open          open the dashboard in your browser
//
// Stop with Ctrl+C.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { spawn } from 'node:child_process';
import { runOnce } from './check.mjs';
import { notify } from './notify.mjs';

// --- args -----------------------------------------------------------------
const args = process.argv.slice(2);
const getArg = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : def;
};
const has = (name) => args.includes(`--${name}`);

const INTERVAL_MS = Math.max(15, Number(getArg('interval', 60))) * 1000;
const PORT = Number(getArg('port', 8787));
const DO_PUSH = has('push');
const PUSH_THROTTLE_MS = Math.max(1, Number(getArg('push-every', 10))) * 60 * 1000;
const DOCS = join(process.cwd(), 'docs');

// --- static dashboard server ---------------------------------------------
const MIME = { '.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = createServer(async (req, res) => {
  let path = decodeURIComponent((req.url || '/').split('?')[0]);
  if (path === '/') path = '/index.html';
  const file = normalize(join(DOCS, path));
  if (!file.startsWith(DOCS) || !existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('Not found');
  }
  const ext = file.slice(file.lastIndexOf('.'));
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-store', // always serve the freshest data
    });
    res.end(body);
  } catch {
    res.writeHead(500).end('Error');
  }
});
server.on('error', (err) => {
  // Another watcher is probably already serving the dashboard — keep checking
  // anyway (results still get written and pushed), just without a second server.
  if (err.code === 'EADDRINUSE') console.log(`  (port ${PORT} in use — dashboard already served elsewhere; still checking)`);
  else console.log(`  (dashboard server error: ${err.message}; still checking)`);
});
server.listen(PORT, () => {
  console.log(`\n  Dashboard (live):  http://localhost:${PORT}\n`);
  if (has('open')) openBrowser(`http://localhost:${PORT}`);
});

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const cmdArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true }).unref(); } catch {}
}

// --- git push (optional) --------------------------------------------------
function git(cmdArgs) {
  return new Promise((resolve) => {
    const p = spawn('git', cmdArgs, { cwd: process.cwd() });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
    p.on('error', () => resolve({ code: 1, out: 'git not found' }));
  });
}

let lastPush = 0;
async function pushResults(force) {
  if (!DO_PUSH) return;
  if (!force && Date.now() - lastPush < PUSH_THROTTLE_MS) return;
  lastPush = Date.now();
  await git(['add', 'docs/status.json', 'docs/history.json', 'docs/incidents.json', 'docs/meta.json']);
  const diff = await git(['diff', '--cached', '--quiet']);
  if (diff.code === 0) return; // nothing changed
  await git(['commit', '-m', 'Update site status (live watcher)']);
  const push = await git(['push']);
  console.log(push.code === 0 ? '  ↑ pushed to GitHub' : `  ! push failed: ${push.out.trim().split('\n').pop()}`);
}

// --- notification logic ---------------------------------------------------
let prevDown = new Set();
let prevCertWarn = new Set();
let prevDomWarn = new Set();
let firstRun = true;

function announce(run) {
  const nowDown = new Set(run.down.map((r) => r.name));
  const nowCert = new Set(run.certWarn.map((r) => r.name));
  const nowDom = new Set(run.domWarn.map((r) => r.name));

  // Newly down / recovered.
  for (const r of run.down) if (!prevDown.has(r.name)) notify(`🔴 ${r.name} is DOWN`, r.error || 'No response');
  for (const name of prevDown) if (!nowDown.has(name)) notify(`✅ ${name} recovered`, 'Site is back up');

  // Expiry warnings (announce once when they first appear).
  for (const r of run.certWarn) if (!prevCertWarn.has(r.name)) notify(`⚠️ SSL expiring: ${r.name}`, `Certificate expires in ${r.ssl.daysLeft} days`);
  for (const r of run.domWarn) if (!prevDomWarn.has(r.name)) notify(`⚠️ Domain expiring: ${r.name}`, `Registration expires in ${r.domain.daysLeft} days`);

  // On the very first run, summarize anything already broken.
  if (firstRun && (run.down.length || run.certWarn.length || run.domWarn.length)) {
    const bits = [];
    if (run.down.length) bits.push(`${run.down.length} down`);
    if (run.certWarn.length) bits.push(`${run.certWarn.length} SSL expiring`);
    if (run.domWarn.length) bits.push(`${run.domWarn.length} domain(s) expiring`);
    notify('Site Monitor started', bits.join(' · '));
  }

  prevDown = nowDown; prevCertWarn = nowCert; prevDomWarn = nowDom;
  firstRun = false;
}

// --- main loop ------------------------------------------------------------
let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    const run = await runOnce({ log: () => {} });
    const stamp = new Date().toLocaleTimeString();
    const line = `[${stamp}] ${run.results.length - run.down.length} up · ${run.down.length} down`
      + (run.slow.length ? ` · ${run.slow.length} slow` : '')
      + (run.certWarn.length ? ` · ${run.certWarn.length} SSL⚠` : '')
      + (run.domWarn.length ? ` · ${run.domWarn.length} domain⚠` : '');
    console.log(line);
    const stateChanged = [...new Set(run.down.map((r) => r.name))].sort().join() !== [...prevDown].sort().join();
    announce(run);
    await pushResults(stateChanged);
  } catch (err) {
    console.error('  ! check failed:', err.message);
  } finally {
    running = false;
  }
}

console.log(`Site Monitor — live watcher (every ${INTERVAL_MS / 1000}s)${DO_PUSH ? ', pushing to GitHub' : ''}`);
console.log('Press Ctrl+C to stop.\n');
await tick();
const timer = setInterval(tick, INTERVAL_MS);

process.on('SIGINT', () => { clearInterval(timer); console.log('\nStopped.'); process.exit(0); });
