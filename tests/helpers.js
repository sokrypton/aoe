// Shared plumbing for the multiplayer test suite: spin up a host page,
// click Host, join a guest via the ?join= link, wait for the first full
// sync. Real PeerJS/WebRTC between two browser contexts — nothing mocked.
const { chromium } = require('playwright');

const BASE = (process.env.AOE_URL || 'http://127.0.0.1:8471/') + 'index.html';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
function check(cond, name) {
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name);
  if (!cond) failures++;
}
function finish() {
  console.log(failures ? 'RESULT: ' + failures + ' FAILURES' : 'RESULT: ALL PASS');
  process.exit(failures ? 1 : 0);
}

// Returns { browser, hostCtx, guestCtx, host, guest, hostId, errors }.
// `errors` collects pageerror events from both pages — assert it's empty
// at the end of a test.
async function startMatch() {
  const browser = await chromium.launch();
  const errors = [];
  const hostCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  host.on('pageerror', e => errors.push('host: ' + e.message));
  await host.goto(BASE);
  await host.waitForTimeout(800);
  await host.evaluate(() => onHostClicked());
  await host.waitForFunction(() => typeof netPeer !== 'undefined' && netPeer && netPeer.id, null, { timeout: 20000 });
  const hostId = await host.evaluate(() => netPeer.id);
  const guestCtx = await browser.newContext();
  const guest = await guestCtx.newPage();
  guest.on('pageerror', e => errors.push('guest: ' + e.message));
  await guest.goto(BASE + '?join=' + hostId);
  await guest.waitForFunction(() => typeof map !== 'undefined' && map.length > 0 && entities.length > 0, null, { timeout: 30000 });
  return { browser, hostCtx, guestCtx, host, guest, hostId, errors };
}

module.exports = { BASE, sleep, check, finish, startMatch };
