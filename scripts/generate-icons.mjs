#!/usr/bin/env node
/**
 * Renders PWA/iOS icons and the social preview image from SVG using the preinstalled
 * Chromium (Playwright). Re-run after replacing the placeholder mark with official art.
 *   node scripts/generate-icons.mjs
 */
import { chromium } from '@playwright/test'
import { existsSync } from 'node:fs'

const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync)
const mark = (bg = '#3B251B', pad = 0) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-pad} ${-pad} ${64 + pad * 2} ${64 + pad * 2}" width="100%" height="100%">
  <rect x="${-pad}" y="${-pad}" width="${64 + pad * 2}" height="${64 + pad * 2}" fill="${bg}"/>
  <circle cx="32" cy="35" r="17" fill="#FFDE75"/>
  <path d="M15 35h34" stroke="#3B251B" stroke-width="4" stroke-linecap="round"/>
  <circle cx="44" cy="20" r="5" fill="#F4B942"/>
</svg>`

const icons = [
  ['public/icons/icon-192.png', 192, mark()],
  ['public/icons/icon-512.png', 512, mark()],
  ['public/icons/icon-maskable-512.png', 512, mark('#3B251B', 14)],
  ['public/icons/apple-touch-icon.png', 180, mark()],
]

const browser = await chromium.launch(exe ? { executablePath: exe } : {})
const page = await browser.newPage()
for (const [file, size, svg] of icons) {
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(`<html><body style="margin:0">${svg}</body></html>`)
  await page.screenshot({ path: file, omitBackground: false })
}
await page.setViewportSize({ width: 1200, height: 630 })
await page.setContent(`<html><body style="margin:0;width:1200px;height:630px;background:#FFF9EC;display:flex;align-items:center;justify-content:center;gap:48px;font-family:'Plus Jakarta Sans',system-ui,sans-serif">
  <div style="width:220px;height:220px;border-radius:60px;overflow:hidden">${mark()}</div>
  <div><div style="font-size:150px;font-weight:800;color:#3B251B;letter-spacing:-6px;line-height:1">aour</div>
  <div style="font-size:44px;font-weight:600;color:#725c4c;margin-top:12px">Your happy hours, ranked.</div></div></body></html>`)
await page.screenshot({ path: 'public/icons/og.png' })
await browser.close()
console.log('Icons written to public/icons/')
