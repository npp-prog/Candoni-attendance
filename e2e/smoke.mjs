/**
 * End-to-end smoke test of the real app against the Firebase emulators.
 * Prerequisites: `npm run emulators:fresh`, `npm run seed`, and `npm run dev` running.
 * Run: node e2e/smoke.mjs   (uses Playwright's Chromium with emulated geolocation)
 * Geolocation is simulated by the browser automation; this is NOT a physical-device test.
 */
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.APP_URL || 'http://127.0.0.1:5173';
const PASS = 'DevOnly-Password1!';
const OFFICE = { latitude: 14.5896, longitude: 120.9811, accuracy: 20 };
const FAR = { latitude: 14.6100, longitude: 120.9811, accuracy: 20 };
const SHOTS = process.env.SHOTS_DIR || 'docs/screenshots';
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};

async function login(page, email) {
  await page.goto(BASE);
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(PASS);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

// Reset the EMULATOR (never a real project) and re-seed so runs are repeatable.
import { execFileSync } from 'node:child_process';
await fetch('http://127.0.0.1:8080/emulator/v1/projects/demo-candoni/databases/(default)/documents', { method: 'DELETE' });
await fetch('http://127.0.0.1:9099/emulator/v1/projects/demo-candoni/accounts', { method: 'DELETE' });
execFileSync('node', ['scripts/seed-emulator.mjs'], { stdio: 'ignore' });

const browser = await chromium.launch();
try {
  // 1. Employee: first login privacy notice → clock in inside geofence → receipt
  {
    const ctx = await browser.newContext({ ...phone, geolocation: OFFICE, permissions: ['geolocation'] });
    const page = await ctx.newPage();
    await page.goto(BASE);
    await page.screenshot({ path: `${SHOTS}/01-login.png` });
    await login(page, 'employee@candoni.dev');
    await page.getByText('Location privacy notice').waitFor();
    await page.screenshot({ path: `${SHOTS}/02-privacy-notice.png` });
    check('First login shows the location privacy notice', true);
    await page.getByRole('button', { name: 'I have read and understand' }).click();
    const clockIn = page.getByRole('button', { name: 'Clock In', exact: true });
    await clockIn.waitFor({ timeout: 20000 });
    await page.screenshot({ path: `${SHOTS}/03-home.png` });
    check('Home shows Clock In as the next valid action', await clockIn.isEnabled());
    await clockIn.click();
    await page.getByRole('dialog', { name: 'Confirm Clock In' }).waitFor({ timeout: 20000 });
    const reviewText = await page.getByRole('dialog').innerText();
    check('Review shows accuracy and distance before submit', /±20 m/.test(reviewText) && /Inside 150 m/.test(reviewText));
    await page.screenshot({ path: `${SHOTS}/04-location-review.png` });
    await page.getByRole('button', { name: 'Submit Clock In' }).click();
    await page.getByRole('dialog', { name: 'Attendance recorded' }).waitFor({ timeout: 30000 });
    const receipt = await page.getByRole('dialog').innerText();
    check('Server-validated receipt shows action, time and location', /Clock In accepted/.test(receipt) && /Main Office/.test(receipt));
    await page.screenshot({ path: `${SHOTS}/05-receipt.png` });
    await page.getByRole('button', { name: 'Done' }).click();
    const out = page.getByRole('button', { name: 'Clock Out', exact: true });
    await out.waitFor();
    const reason = await page.locator('#action-reason').innerText();
    check('Next action becomes Clock Out and is blocked briefly (double-submit guard)', (await out.isDisabled()) && /wait a moment/i.test(reason), reason);

    // Offline: banner + disabled button, nothing queued
    await ctx.setOffline(true);
    await page.getByText('You are offline').first().waitFor();
    check('Offline message shown and attendance disabled', await out.isDisabled());
    await page.screenshot({ path: `${SHOTS}/06-offline.png` });
    await ctx.setOffline(false);

    // History + requests pages render
    await page.getByRole('link', { name: 'History', exact: true }).click();
    await page.getByRole('heading', { name: 'Attendance history' }).waitFor();
    await page.getByText('In progress').first().waitFor({ timeout: 20000 });
    check('History lists today as in progress', true);
    await page.screenshot({ path: `${SHOTS}/07-history.png` });
    await page.getByRole('link', { name: 'Requests', exact: true }).click();
    await page.getByRole('button', { name: '+ New request' }).click();
    await page.getByLabel('Request type').selectOption('explanation');
    await page.getByLabel('Explanation').fill('Traffic accident on the highway delayed my arrival.');
    await page.getByRole('button', { name: 'Submit for approval' }).click();
    await page.getByText('Request submitted for review.').waitFor({ timeout: 20000 });
    check('Employee can submit an exception explanation request', true);
    await page.screenshot({ path: `${SHOTS}/08-requests.png` });
    await ctx.close();
  }

  // 2. Outside the geofence → client warns and the submit button is disabled
  {
    const ctx = await browser.newContext({ ...phone, geolocation: FAR, permissions: ['geolocation'] });
    const page = await ctx.newPage();
    await login(page, 'split@candoni.dev');
    const btn = page.getByRole('button', { name: /^(Clock In|AM In|PM In|AM Out|PM Out|No action available)$/ });
    await btn.waitFor({ timeout: 20000 });
    if (await btn.isEnabled()) {
      await btn.click();
      await page.getByText('Outside your authorized area').waitFor({ timeout: 20000 });
      const submit = page.getByRole('button', { name: /^Submit / });
      check('Outside geofence: warning shown and submit disabled', await submit.isDisabled());
      await page.screenshot({ path: `${SHOTS}/09-outside-geofence.png` });
    } else {
      check('Outside geofence check skipped (split shift not open at this time of day)', true, await page.locator('#action-reason').innerText());
    }
    await ctx.close();
  }

  // 3. Permission denied → practical instructions + retry
  {
    const ctx = await browser.newContext({ ...phone, permissions: [] });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      navigator.geolocation.getCurrentPosition = (_ok, err) => setTimeout(() => err({ code: 1, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3, message: 'denied' }), 50);
    });
    await login(page, 'employee@candoni.dev');
    const out = page.getByRole('button', { name: 'Clock Out', exact: true });
    await out.waitFor({ timeout: 20000 });
    await page.waitForTimeout(61000 - 0); // wait for the minimum action interval to pass
    await page.reload();
    await out.waitFor({ timeout: 20000 });
    await out.click();
    const cont = page.getByRole('button', { name: 'Continue' });
    if (await cont.isVisible().catch(() => false)) {
      await page.screenshot({ path: `${SHOTS}/10-location-explainer.png` });
      await cont.click();
    }
    await page.getByRole('dialog', { name: 'Location permission is blocked' }).waitFor({ timeout: 20000 });
    check('Permission denied shows instructions and a retry button', await page.getByRole('button', { name: 'Retry' }).isVisible());
    await page.screenshot({ path: `${SHOTS}/11-permission-denied.png` });
    await ctx.close();
  }

  // 4. Supervisor sees the employee in the daily dashboard (department scope)
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await login(page, 'supervisor@candoni.dev');
    await page.getByRole('link', { name: 'Admin console →' }).click();
    await page.getByRole('heading', { name: 'Daily attendance' }).waitFor();
    await page.getByText('Erin Santos (DEV Employee)').first().waitFor({ timeout: 20000 });
    const text = await page.locator('main').innerText();
    check('Supervisor dashboard shows the clocked-in employee', /Erin Santos/.test(text));
    check('Supervisor does not see other departments', !/Nina Garcia/.test(text));
    await page.screenshot({ path: `${SHOTS}/12-admin-dashboard.png` });
    await page.getByRole('link', { name: 'Approvals' }).click();
    await page.getByText('Traffic accident on the highway').first().waitFor({ timeout: 20000 });
    await page.getByRole('button', { name: '✓ Approve' }).first().click();
    await page.getByRole('button', { name: 'Confirm approve' }).click();
    await page.getByText('Request approved.').waitFor({ timeout: 20000 });
    check('Supervisor approves an in-scope request', true);
    await ctx.close();
  }

  // 5. HR: reports + audit log; inactive account blocked
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await login(page, 'hr@candoni.dev');
    await page.getByText('Good day,').waitFor({ timeout: 20000 });
    await page.goto(`${BASE}/admin/reports`);
    await page.getByRole('button', { name: 'Generate report' }).click();
    await page.getByRole('button', { name: '⬇ CSV' }).waitFor({ timeout: 30000 });
    check('HR daily report generated', /Erin Santos/.test(await page.locator('main').innerText()));
    await page.screenshot({ path: `${SHOTS}/13-reports.png` });
    await page.goto(`${BASE}/admin/audit`);
    await page.getByRole('listitem').filter({ hasText: 'request.approve' }).first().waitFor({ timeout: 20000 });
    await page.screenshot({ path: `${SHOTS}/14-audit.png` });
    check('Audit log records the approval', true);
    await ctx.close();
    const ctx2 = await browser.newContext(phone);
    const p2 = await ctx2.newPage();
    await login(p2, 'inactive@candoni.dev');
    await p2.getByText(/deactivated|inactive/i).first().waitFor({ timeout: 20000 });
    check('Inactive account cannot sign in', true);
    await ctx2.close();
  }
} catch (e) {
  check('Unexpected error', false, e.message.split('\n')[0]);
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
