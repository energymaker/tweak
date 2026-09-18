// The test browser, built from Electron's own Chromium. Nothing extra to
// download. A tweak is injected the way a content script runs: in an isolated
// world that shares the page's DOM.
import { BrowserWindow, session, app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';

export const VIEWPORT = { width: 1280, height: 800 };
const SETTLE_MS = Number(process.env.TWEAK_SETTLE_MS || 3500);
const TWEAK_WORLD = 999;
const CHECK_WORLD = 1000;



class Page {
  constructor(win) { this.win = win; this.wc = win.webContents; }
  url() { try { return this.wc.getURL(); } catch { return ''; } }
  async evaluate(fn, arg) {
    const code = `(${fn.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`;
    return this.wc.executeJavaScriptInIsolatedWorld(CHECK_WORLD, [{ code }]);
  }
  async screenshot({ path: file }) {
    // A picture is nice to have, never worth stalling a run for.
    const img = await Promise.race([
      this.wc.capturePage(),
      new Promise(r => setTimeout(() => r(null), 8000))
    ]);
    if (!img) return false;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, img.toJPEG(70));
    return true;
  }
  waitForTimeout(ms) { return new Promise(r => setTimeout(r, ms)); }
}

class Context {
  constructor(win, ses, inject) { this.win = win; this.ses = ses; this._page = new Page(win); this.inject = inject || {}; }
  setInject(next) { this.inject = next || {}; }
  // tell me when the person closes this window
  onClosed(fn) { this.win.on('closed', fn); }
  isOpen() { try { return !this.win.isDestroyed(); } catch { return false; } }
  pages() { return [this._page]; }
  async newPage() { return this._page; }
  async cookies() { return this.ses.cookies.get({}); }
  async addCookies(list) {
    for (const c of list) {
      const host = String(c.domain || '').replace(/^\./, '');
      if (!host) continue;
      const url = `http${c.secure ? 's' : ''}://${host}${c.path || '/'}`;
      await this.ses.cookies.set({
        url, name: c.name, value: c.value, domain: c.domain, path: c.path,
        secure: !!c.secure, httpOnly: !!c.httpOnly,
        expirationDate: c.expires && c.expires > 0 ? c.expires : undefined
      }).catch(() => {});
    }
  }
  async storageState() { return { cookies: await this.cookies() }; }
  async close() { try { if (!this.win.isDestroyed()) this.win.destroy(); } catch {} }
}

// inject is null for the page as it is, or { css, js } for the page with a tweak
export async function launchTestBrowser(inject, headless = true, persist = false, which = 'tests') {
  await app.whenReady();
  // One session for testing, reused. Creating a fresh one per window made
  // Chromium refuse the next page load.
  // Separate sessions keep the page being tested in its own process, so a busy
  // tweak cannot freeze the page we compare against.
  const ses = session.fromPartition(persist ? 'persist:tweak' : `tweak-${which}`);
  const win = new BrowserWindow({
    show: !headless, width: VIEWPORT.width, height: VIEWPORT.height, title: 'Tweak test browser',
    webPreferences: { session: ses, sandbox: false, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const ctx = new Context(win, ses, inject);
  // The tweak is applied on every load, the way a content script would be.
  win.webContents.on('did-finish-load', async () => {
    const now = ctx.inject || {};
    try {
      if (now.css) await win.webContents.insertCSS(now.css);
      if (now.js) await win.webContents.executeJavaScriptInIsolatedWorld(TWEAK_WORLD, [{ code: now.js }]);
    } catch {}
  });
  ctx.tweakProfileDir = null;
  return ctx;
}

export async function goto(page, url) {
  // A fresh window sometimes refuses the very first load, so try once more.
  try { await page.wc.loadURL(url); }
  catch (e) {
    if (!/ERR_ABORTED|ERR_FAILED/.test(String(e && e.message))) throw e;
    await page.waitForTimeout(600);
    await page.wc.loadURL(url);
  }
  await page.waitForTimeout(SETTLE_MS);
}

export async function freshProfile() { return null; }
export async function dropProfile() {}
export async function sweepProfiles() {}

export async function loadCookies(ctx, file) {
  try {
    const { cookies } = JSON.parse(await fs.readFile(file, 'utf8'));
    if (Array.isArray(cookies) && cookies.length) await ctx.addCookies(cookies);
  } catch {}
}
export async function saveCookies(ctx, file) {
  try {
    const cookies = await ctx.cookies();
    if (cookies.length) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify({ cookies, saved: new Date().toISOString() }, null, 2)); }
  } catch {}
}

export function isConsentHost(url) {
  try { return /(^|\.)consent\.(youtube|google)\.com/i.test(new URL(url).hostname); } catch { return false; }
}

export async function consentWall(page) {
  if (isConsentHost(page.url())) return 'the site sent the test browser to its consent page';
  return page.evaluate(() => {
    const body = document.body ? document.body.innerText || '' : '';
    const t = body.slice(0, 4000).toLowerCase();
    const title = (document.title || '').toLowerCase();
    if (title.includes('before you continue')) return 'the page is a cookie consent wall';
    if (document.querySelector('form[action*="consent"], [id*="consent-bump"], #cookie-banner')) return 'the page is showing a cookie consent wall';
    const both = t.includes('accept all') && (t.includes('reject all') || t.includes('reject cookies'));
    if (both && body.length < 4000 && document.querySelectorAll('a').length < 20) return 'the page looks like a cookie consent wall (it offers accept and reject and has almost nothing else on it)';
    return '';
  });
}

export async function outline(page, request) {
  const stop = new Set('the and for with that this from into onto make show hide add remove page button when what your you all any can have more less like just every each only them they then than its also want need please'.split(' '));
  const words = String(request).toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  const keywords = [...new Set(words.filter(w => !stop.has(w)).flatMap(w => (w.endsWith('s') && w.length > 4 ? [w, w.slice(0, -1)] : [w])))];
  return page.evaluate(({ keywords, limit }) => {
    const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'LINK', 'META', 'PATH', 'svg', 'path', 'g', 'defs', 'use', 'TEMPLATE']);
    const hit = s => keywords.some(k => s.includes(k));
    const groups = new Map();
    const els = [...document.body.querySelectorAll('*')].slice(0, 25000);
    els.forEach((el, order) => {
      if (skip.has(el.tagName)) return;
      let sig = el.tagName.toLowerCase();
      if (el.id && el.id.length < 40) sig += '#' + el.id;
      const cls = [...el.classList].filter(c => c.length < 40).slice(0, 3);
      if (cls.length) sig += '.' + cls.join('.');
      let score = 0;
      for (const a of el.attributes) {
        if (['id', 'class', 'style'].includes(a.name)) continue;
        const n = a.name.toLowerCase(), v = String(a.value || '').toLowerCase();
        if (['aria-label', 'title', 'role', 'data-testid', 'name', 'type'].includes(n) && v && v.length < 50) sig += `[${a.name}="${a.value}"]`;
        else if (hit(n)) { sig += `[${a.name}]`; score += 3; }
        else if (v && v.length < 50 && hit(v)) { sig += `[${a.name}="${a.value}"]`; score += 2; }
      }
      if (hit(sig.toLowerCase())) score += 3;
      const name = (el.id + ' ' + el.className).toLowerCase();
      if (/(^|[-_ ])(content|article|main|body|feed|results|list|container|post|entry)([-_ ]|$)/.test(name)) score += 4;
      if (['MAIN', 'ARTICLE', 'SECTION', 'NAV', 'ASIDE', 'HEADER', 'FOOTER', 'FORM', 'TABLE', 'UL', 'OL'].includes(el.tagName)) score += 2;
      if (el.tagName === 'A' || el.tagName === 'SPAN' || el.tagName === 'LI') score -= 2;
      if (el.getBoundingClientRect().height > 200) score += 2;
      let g = groups.get(sig);
      if (!g) { g = { sig, count: 0, text: '', score: 0, order, custom: el.tagName.includes('-') || !!el.id }; groups.set(sig, g); }
      g.count++;
      const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join(' ').replace(/\s+/g, ' ').trim();
      if (own && !g.text) g.text = own.slice(0, 60);
      if (own && hit(own.toLowerCase())) score += 2;
      g.score = Math.max(g.score, score);
    });
    const all = [...groups.values()];
    const relevant = all.filter(g => g.score > 0).sort((a, b) => b.score - a.score || a.order - b.order).slice(0, 30);
    const landmarks = all.filter(g => g.custom && g.score <= 0).sort((a, b) => b.score - a.score || a.order - b.order).slice(0, 25);
    const line = g => `${g.sig}${g.count > 1 ? ` (x${g.count})` : ''}${g.text ? ` "${g.text}"` : ''}`;
    let text = `Title: ${document.title}\nAddress: ${location.href}\n`;
    text += relevant.length ? `\nElements matching the request:\n${relevant.map(line).join('\n')}\n` : '\nNo elements obviously matched the request words.\n';
    text += `\nOther landmark elements, in page order:\n${landmarks.map(line).join('\n')}\n`;
    return text.slice(0, limit);
  }, { keywords, limit: Number(process.env.TWEAK_OUTLINE_CHARS || 5000) });
}

export async function runChecks(page, checks) {
  return page.evaluate((checks) => {
    const visible = el => {
      const s = getComputedStyle(el), r = el.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity || '1') > 0 && (r.width > 0 || r.height > 0);
    };
    return checks.map(c => {
      try {
        const els = [...document.querySelectorAll(c.selector)];
        const vis = els.filter(visible).length;
        let pass = false, detail = `${els.length} matched, ${vis} visible`;
        switch (c.type) {
          case 'hidden': pass = vis === 0; break;
          case 'visible': pass = vis > 0; break;
          case 'exists': pass = els.length > 0; break;
          case 'absent': pass = els.length === 0; break;
          case 'textContains': {
            const t = els[0] ? els[0].textContent.replace(/\s+/g, ' ').trim() : '';
            pass = !!els[0] && t.toLowerCase().includes(String(c.text || '').toLowerCase());
            detail = els[0] ? `text is "${t.slice(0, 60)}"` : 'nothing matched';
            break;
          }
          case 'style': {
            const v = els[0] ? getComputedStyle(els[0]).getPropertyValue(c.property).trim() : '';
            pass = !!els[0] && v === String(c.value || '').trim();
            detail = els[0] ? `${c.property} is "${v}"` : 'nothing matched';
            break;
          }
          default: detail = `unknown check type "${c.type}"`;
        }
        return { ...c, pass, detail };
      } catch (e) {
        return { ...c, pass: false, detail: 'invalid selector' };
      }
    });
  }, checks);
}

export async function isResponsive(page, ms = 5000) {
  try { await Promise.race([page.evaluate(() => 1 + 1), new Promise((_, bad) => setTimeout(() => bad(new Error('busy')), ms))]); return true; }
  catch { return false; }
}

export async function tweakError(page) {
  return page.evaluate(() => document.documentElement.getAttribute('data-tweak-error'));
}
