/**
 * Opticlick Sandbox Service Worker
 *
 * Acts as a transparent proxy for the mock browser iframe:
 * 1. Intercepts requests to /__proxy__/?url=<target>
 * 2. Fetches the target URL
 * 3. Strips X-Frame-Options and restrictive CSP headers
 * 4. Rewrites all absolute/relative URLs in HTML to go through the proxy
 * 5. Injects the Opticlick content script shim at end of <body>
 * 6. Returns the modified response from the sandbox origin (making it same-origin)
 */

const PROXY_PREFIX = '/__proxy__/';
const CONTENT_SCRIPT_ID = '__opticlick_cs__';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  if (!url.pathname.startsWith(PROXY_PREFIX)) return;

  const target = url.searchParams.get('url');
  if (!target) return;

  event.respondWith(handleProxy(target, event.request));
});

async function handleProxy(targetUrl, originalRequest) {
  let resolvedUrl = targetUrl;

  try {
    const resp = await fetch(resolvedUrl, {
      method: originalRequest.method,
      headers: buildProxyHeaders(originalRequest.headers),
      redirect: 'follow',
      credentials: 'omit',
    });

    // Track final URL after redirects
    resolvedUrl = resp.url || resolvedUrl;

    const headers = new Headers();
    // Copy safe headers
    for (const [k, v] of resp.headers.entries()) {
      const lower = k.toLowerCase();
      // Strip all security headers that would block embedding
      if (
        lower === 'x-frame-options' ||
        lower === 'content-security-policy' ||
        lower === 'content-security-policy-report-only' ||
        lower === 'x-content-type-options' ||
        lower === 'strict-transport-security'
      ) continue;
      headers.set(k, v);
    }
    headers.set('access-control-allow-origin', '*');

    const ct = resp.headers.get('content-type') ?? '';
    const isHtml = ct.includes('text/html');
    const isCss = ct.includes('text/css');
    const isJs = ct.includes('javascript') || ct.includes('ecmascript');

    if (isHtml) {
      let html = await resp.text();
      html = rewriteHtml(html, resolvedUrl);
      html = injectContentScript(html);
      headers.set('content-type', 'text/html; charset=utf-8');
      return new Response(html, { status: resp.status, headers });
    }

    if (isCss) {
      let css = await resp.text();
      css = rewriteCssUrls(css, resolvedUrl);
      return new Response(css, { status: resp.status, headers });
    }

    // Binary/other: pass through
    return new Response(resp.body, { status: resp.status, headers });
  } catch (err) {
    return new Response(
      `<html><body style="font-family:sans-serif;padding:2rem;background:#1a1a2e;color:#e2e8f0;">
        <h2 style="color:#f87171">⚠️ Cannot proxy this page</h2>
        <p>URL: <code>${targetUrl}</code></p>
        <p>Error: ${err.message}</p>
        <p>Try a different URL, or check if the site blocks cross-origin requests.</p>
      </body></html>`,
      { status: 502, headers: { 'content-type': 'text/html' } }
    );
  }
}

function buildProxyHeaders(originalHeaders) {
  const h = new Headers();
  // Only forward safe request headers
  const safe = ['accept', 'accept-language', 'cache-control'];
  for (const k of safe) {
    const v = originalHeaders.get(k);
    if (v) h.set(k, v);
  }
  return h;
}

/**
 * Rewrite all URLs in HTML to go through the proxy.
 * Handles: href, src, action, srcset, data-src, @import in <style> blocks.
 */
function rewriteHtml(html, baseUrl) {
  // Inject <base> to handle relative URLs
  const base = new URL(baseUrl);
  const baseTag = `<base href="${base.origin}${base.pathname}" />`;

  // Rewrite src and href attributes
  html = html
    // Rewrite href="..."
    .replace(/\bhref="((?!#|javascript:|mailto:|tel:)[^"]+)"/gi, (_, u) => `href="${proxyUrl(u, baseUrl)}"`)
    .replace(/\bhref='((?!#|javascript:|mailto:|tel:)[^']+)'/gi, (_, u) => `href='${proxyUrl(u, baseUrl)}'`)
    // Rewrite src="..."
    .replace(/\bsrc="([^"]+)"/gi, (_, u) => `src="${proxyUrl(u, baseUrl)}"`)
    .replace(/\bsrc='([^']+)'/gi, (_, u) => `src='${proxyUrl(u, baseUrl)}'`)
    // Rewrite action="..."
    .replace(/\baction="([^"]+)"/gi, (_, u) => `action="${proxyUrl(u, baseUrl)}"`)
    // Rewrite srcset
    .replace(/\bsrcset="([^"]+)"/gi, (_, s) => `srcset="${rewriteSrcset(s, baseUrl)}"`)
    // Rewrite <link rel="stylesheet">
    // Already handled by href above
    // Remove integrity attributes (would fail after rewrite)
    .replace(/\s+integrity="[^"]*"/gi, '')
    .replace(/\s+crossorigin(="[^"]*")?/gi, '');

  // Inject base tag after <head>
  html = html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);

  return html;
}

function rewriteSrcset(srcset, baseUrl) {
  return srcset.split(',').map(part => {
    const trimmed = part.trim();
    const [u, ...rest] = trimmed.split(/\s+/);
    return [proxyUrl(u, baseUrl), ...rest].join(' ');
  }).join(', ');
}

function rewriteCssUrls(css, baseUrl) {
  return css.replace(/url\(['"]?([^'"\)]+)['"]?\)/gi, (_, u) => `url(${proxyUrl(u, baseUrl)})`);
}

function proxyUrl(url, baseUrl) {
  if (!url || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:')) {
    return url;
  }
  try {
    const abs = new URL(url, baseUrl).href;
    if (abs.startsWith('http://') || abs.startsWith('https://')) {
      return `/__proxy__/?url=${encodeURIComponent(abs)}`;
    }
    return url;
  } catch {
    return url;
  }
}

/**
 * Inject the Opticlick content script shim into the page.
 * This mimics what the real extension's content.ts does.
 */
function injectContentScript(html) {
  const script = `
<script id="${CONTENT_SCRIPT_ID}">
(function() {
  'use strict';
  if (window.__opticlick_cs_loaded__) return;
  window.__opticlick_cs_loaded__ = true;

  const CANVAS_ID = '__opticlick_overlay__';
  const BLOCKER_ID = '__opticlick_blocker__';

  // ── Overlay (SOM) ────────────────────────────────────────────────────────
  function collectInteractables() {
    const tags = 'a,button,input,select,textarea,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[onclick],[tabindex]';
    return [...document.querySelectorAll(tags)].filter(el => {
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    });
  }

  function getLabel(el) {
    return (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.alt || el.tagName.toLowerCase()).slice(0, 80).trim();
  }

  function drawOverlay() {
    destroyOverlay();
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth, h = window.innerHeight;
    const els = collectInteractables();
    const canvas = document.createElement('canvas');
    canvas.id = CANVAS_ID;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.cssText = 'position:fixed;top:0;left:0;width:' + w + 'px;height:' + h + 'px;z-index:2147483647;pointer-events:none;';
    (document.body || document.documentElement).appendChild(canvas);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const map = [];
    let id = 1;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      ctx.strokeStyle = 'rgba(255,100,0,0.9)';
      ctx.lineWidth = 1.5;
      ctx.fillStyle = 'rgba(255,100,0,0.12)';
      ctx.strokeRect(r.left+.5,r.top+.5,r.width-1,r.height-1);
      ctx.fillRect(r.left+1,r.top+1,r.width-2,r.height-2);
      const label = String(id);
      const bw = Math.max(label.length*7+8,20), bh = 16;
      ctx.fillStyle='#ff6400';
      ctx.fillRect(r.left, Math.max(0,r.top-bh-1), bw, bh);
      ctx.fillStyle='#fff';
      ctx.font='bold 10px sans-serif';
      ctx.textBaseline='middle';
      ctx.fillText(label, r.left+4, Math.max(bh/2, r.top-bh/2-1));
      map.push({ id, tag: el.tagName.toLowerCase(), text: getLabel(el), rect: { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2), left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) } });
      id++;
    }
    return map;
  }

  function destroyOverlay() {
    document.getElementById(CANVAS_ID)?.remove();
  }

  // ── Blocker ──────────────────────────────────────────────────────────────
  function installBlocker() {
    if (document.getElementById(BLOCKER_ID)) return;
    const div = document.createElement('div');
    div.id = BLOCKER_ID;
    div.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,0.3);cursor:not-allowed;';
    const banner = document.createElement('div');
    banner.style.cssText = 'position:absolute;top:0;left:0;right:0;padding:10px;background:#1a1a2e;color:#fff;font:bold 13px sans-serif;text-align:center;letter-spacing:1px;';
    banner.textContent = 'Opticlick Agent Running — Tab Locked';
    div.appendChild(banner);
    document.body.appendChild(div);
  }

  function removeBlocker() {
    document.getElementById(BLOCKER_ID)?.remove();
  }

  // ── Message bridge ───────────────────────────────────────────────────────
  window.addEventListener('message', function(event) {
    if (!event.data?.__opticlick__) return;
    const { id, type } = event.data;
    const reply = function(data) {
      event.source.postMessage({ __opticlick_reply__: true, id, response: data }, '*');
    };

    switch (type) {
      case 'DRAW_MARKS': {
        const coordinateMap = drawOverlay();
        reply({ success: true, coordinateMap, dpr: window.devicePixelRatio || 1 });
        break;
      }
      case 'DESTROY_MARKS': destroyOverlay(); reply({ success: true }); break;
      case 'BLOCK_INPUT': installBlocker(); reply({ success: true }); break;
      case 'UNBLOCK_INPUT': removeBlocker(); reply({ success: true }); break;
      case 'PING': reply({ alive: true }); break;
      case 'GET_ELEMENT_DOM': {
        const el = document.elementFromPoint(event.data.x, event.data.y);
        reply({ success: true, outerHTML: el?.outerHTML?.slice(0, 2000) ?? '' });
        break;
      }
      default: reply({ success: false, error: 'unknown type: ' + type });
    }
  });

  console.log('[Opticlick] Content script (sandbox) loaded on', location.href);
})();
<\/script>`;

  if (html.includes('</body>')) {
    return html.replace(/<\/body>/i, script + '</body>');
  }
  return html + script;
}
