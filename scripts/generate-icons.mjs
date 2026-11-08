// Renders the SVG icons to PNG sizes required by Android/iOS using the
// preinstalled Playwright Chromium. Run: npm run icons
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
// Playwright is resolved via require so a globally preinstalled copy also works.
const { chromium } = createRequire(import.meta.url)('playwright');

const targets = [
  ['public/icons/icon.svg', 'public/icons/icon-192.png', 192],
  ['public/icons/icon.svg', 'public/icons/icon-512.png', 512],
  ['public/icons/maskable.svg', 'public/icons/maskable-512.png', 512],
  ['public/icons/maskable.svg', 'public/icons/apple-touch-icon.png', 180],
];
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [src, out, size] of targets) {
  const svg = readFileSync(src, 'utf8');
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  console.log('wrote', out);
}
await browser.close();
