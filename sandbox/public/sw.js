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

  // In local dev mode, let the Vite dev server handle proxy requests server-side (Node.js) to bypass browser CORS restrictions.
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    return;
  }

  if (!url.pathname.startsWith(PROXY_PREFIX)) return;

  const target = url.searchParams.get('url');
  if (!target) return;

  event.respondWith(handleProxy(target, event.request));
});

async function handleProxy(targetUrl, originalRequest) {
  let resolvedUrl = targetUrl;

  try {
    const fetchInit = {
      method: originalRequest.method === 'GET' ? 'GET' : originalRequest.method,
      headers: buildProxyHeaders(originalRequest.headers),
      redirect: 'follow',
      credentials: 'omit',
      cache: 'no-store',
    };

    let resp;
    try {
      resp = await fetch(resolvedUrl, fetchInit);
    } catch (firstErr) {
      // Some browsers block http→https fetches from SW in dev mode.
      // Try with mode: 'no-cors' as last resort (returns opaque response).
      try {
        resp = await fetch(resolvedUrl, { ...fetchInit, mode: 'no-cors' });
      } catch {
        throw firstErr; // throw original error
      }
    }

    // Opaque response (no-cors) — can't read body, serve a redirect page instead
    if (resp.type === 'opaque' || resp.status === 0) {
      const redirectHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>body{font-family:sans-serif;padding:2rem;background:#f8fafc;color:#1e293b;max-width:600px;margin:auto}</style>
</head><body>
<h2>🔒 This site requires direct access</h2>
<p>The proxy couldn't load <strong>${targetUrl}</strong> due to browser security restrictions in local dev mode.</p>
<p>This works fine when deployed to GitHub Pages (HTTPS). In local dev, try sites that allow cross-origin requests.</p>
<hr>
<p><strong>Suggested test sites:</strong></p>
<ul>
  <li><a href="/__proxy__/?url=https://example.com" onclick="event.preventDefault();parent.postMessage({__opticlick_navigate__:true,url:'https://en.wikipedia.org/wiki/Main_Page'},'*')">en.wikipedia.org</a></li>
  <li><a href="/__proxy__/?url=https://httpbin.org/html">httpbin.org/html</a></li>
  <li><a href="/__proxy__/?url=https://news.ycombinator.com">news.ycombinator.com</a></li>
</ul>
</body></html>`;
      return new Response(redirectHtml, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    // Track final URL after redirects
    resolvedUrl = resp.url || resolvedUrl;

    const headers = new Headers();
    // Copy safe headers, strip anything that would block embedding
    for (const [k, v] of resp.headers.entries()) {
      const lower = k.toLowerCase();
      if (
        lower === 'x-frame-options' ||
        lower === 'content-security-policy' ||
        lower === 'content-security-policy-report-only' ||
        lower === 'x-content-type-options' ||
        lower === 'strict-transport-security' ||
        lower === 'cross-origin-opener-policy' ||
        lower === 'cross-origin-embedder-policy' ||
        lower === 'cross-origin-resource-policy'
      ) continue;
      headers.set(k, v);
    }
    headers.set('access-control-allow-origin', '*');

    const ct = resp.headers.get('content-type') ?? '';
    const isHtml = ct.includes('text/html');
    const isCss = ct.includes('text/css');

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
    const isNetworkErr = err.message?.includes('fetch') || err.message?.includes('network') || err.name === 'TypeError';
    return new Response(
      `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2rem;background:#1a1a2e;color:#e2e8f0;">
        <h2 style="color:#f87171">⚠️ Cannot proxy this page</h2>
        <p>URL: <code>${targetUrl}</code></p>
        <p>Error: ${err.message}</p>
        ${isNetworkErr ? `<p style="color:#94a3b8;font-size:13px">💡 In local dev mode, some sites block cross-origin requests from the proxy.
        Try: <a href="/__proxy__/?url=https://httpbin.org/html" style="color:#60a5fa">httpbin.org/html</a> or
        <a href="/__proxy__/?url=https://en.wikipedia.org/wiki/Main_Page" style="color:#60a5fa">wikipedia.org</a></p>` : ''}
      </body></html>`,
      { status: 502, headers: { 'content-type': 'text/html; charset=utf-8' } }
    );
  }
}

function buildProxyHeaders(originalHeaders) {
  const h = new Headers();
  // Forward safe request headers + spoof a real browser User-Agent
  h.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
  h.set('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8');
  h.set('Accept-Language', 'en-US,en;q=0.9');
  const v = originalHeaders.get('cache-control');
  if (v) h.set('Cache-Control', v);
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

  const LIGHT = {
    markStroke:    '#0284c7',
    markFill:      'rgba(2, 132, 199, 0.07)',
    badgeBg:       '#0284c7',
    badgeText:     '#ffffff',
    blockerBg:     'radial-gradient(ellipse at center, rgba(14, 165, 233, 0) 60%, rgba(14, 165, 233, 0.9) 120%)',
    bannerBg:      'rgba(2, 132, 199, 0)',
  };
  const DARK = {
    markStroke:    '#38bdf8',
    markFill:      'rgba(56, 189, 248, 0.08)',
    badgeBg:       '#0369a1',
    badgeText:     '#ffffff',
    blockerBg:     'radial-gradient(ellipse at center, rgba(2, 132, 199, 0.20) 60%, rgba(2, 132, 199, 0.9) 120%)',
    bannerBg:      'rgba(3, 105, 161, 0)',
  };

  async function getTheme() {
    try {
      if (window.parent && window.parent.chrome?.storage?.local) {
        const res = await window.parent.chrome.storage.local.get('opticlickTheme');
        if (res && res.opticlickTheme) {
          return res.opticlickTheme === 'dark' ? DARK : LIGHT;
        }
      }
    } catch(e){}
    return LIGHT;
  }

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

  async function drawOverlay() {
    destroyOverlay();
    const theme = await getTheme();
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
      
      ctx.strokeStyle = theme.markStroke;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(r.left + 0.5, r.top + 0.5, r.width - 1, r.height - 1);
      
      ctx.fillStyle = theme.markFill;
      ctx.fillRect(r.left + 1, r.top + 1, r.width - 2, r.height - 2);
      
      const label = String(id);
      const badgeW = Math.max(label.length * 7 + 8, 20);
      const badgeH = 16;
      const badgeX = r.left;
      const badgeY = r.top - badgeH - 1;
      
      ctx.fillStyle = theme.badgeBg;
      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(badgeX, Math.max(0, badgeY), badgeW, badgeH, 3);
      } else {
        ctx.rect(badgeX, Math.max(0, badgeY), badgeW, badgeH);
      }
      ctx.fill();
      
      ctx.fillStyle = theme.badgeText;
      ctx.font = 'bold 10px -apple-system, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, badgeX + 4, Math.max(badgeH / 2, badgeY + badgeH / 2));
      
      map.push({
        id,
        tag: el.tagName.toLowerCase(),
        text: getLabel(el),
        rect: {
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
          left: Math.round(r.left),
          top: Math.round(r.top),
          width: Math.round(r.width),
          height: Math.round(r.height)
        }
      });
      id++;
    }
    return map;
  }

  function destroyOverlay() {
    document.getElementById(CANVAS_ID)?.remove();
  }

  async function installBlocker() {
    if (document.getElementById(BLOCKER_ID)) return;
    const theme = await getTheme();
    const div = document.createElement('div');
    div.id = BLOCKER_ID;
    div.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:' + theme.blockerBg + ';cursor:not-allowed;pointer-events:none;box-sizing:border-box;';
    
    const banner = document.createElement('div');
    banner.style.cssText = 'position:absolute;top:0;left:0;right:0;padding:10px 0;background:' + theme.bannerBg + ';color:#fff;font:bold 14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;text-align:center;letter-spacing:1.5px;text-transform:uppercase;pointer-events:none;animation:__opticlick_pulse__ 1.5s ease-in-out infinite;';
    banner.textContent = 'Opticlick Agent Running — Tab Locked';
    div.appendChild(banner);
    
    const style = document.createElement('style');
    style.textContent = '@keyframes __opticlick_pulse__ { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } } body.' + BLOCKER_ID + '-active, body.' + BLOCKER_ID + '-active * { cursor: not-allowed !important; }';
    div.appendChild(style);
    
    (document.body || document.documentElement).appendChild(div);
    document.body?.classList.add(BLOCKER_ID + '-active');
  }

  function removeBlocker() {
    document.getElementById(BLOCKER_ID)?.remove();
    document.body?.classList.remove(BLOCKER_ID + '-active');
  }

  window.addEventListener('message', async function(event) {
    if (!event.data?.__opticlick__) return;
    const { id, type } = event.data;
    const reply = data => event.source.postMessage({ __opticlick_reply__: true, id, response: data }, '*');
    switch (type) {
      case 'DRAW_MARKS': {
        const coordinateMap = await drawOverlay();
        reply({ success: true, coordinateMap, dpr: window.devicePixelRatio || 1 });
        break;
      }
      case 'DESTROY_MARKS': {
        destroyOverlay();
        reply({ success: true });
        break;
      }
      case 'BLOCK_INPUT': {
        await installBlocker();
        reply({ success: true });
        break;
      }
      case 'UNBLOCK_INPUT': {
        removeBlocker();
        reply({ success: true });
        break;
      }
      case 'PING': {
        reply({ alive: true });
        break;
      }
      case 'GET_ELEMENT_DOM': {
        const el = document.elementFromPoint(event.data.x, event.data.y);
        reply({ success: true, outerHTML: el?.outerHTML?.slice(0, 2000) ?? '' });
        break;
      }
      default:
        reply({ success: false, error: 'unknown:' + type });
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
