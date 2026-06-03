import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import type { IncomingMessage, ServerResponse } from 'http';

// ── Dev-mode server-side proxy plugin ─────────────────────────────────────────
// In dev (http://localhost), the service worker can't fetch cross-origin HTTPS
// URLs due to browser security restrictions. This Vite plugin handles
// /__proxy__/?url=<target> requests server-side (Node.js has no CORS limits).
// In production (GitHub Pages HTTPS), the SW handles everything.
function devProxyPlugin() {
  return {
    name: 'sandbox-dev-proxy',
    configureServer(server: { middlewares: { use: (fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void } }) {
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (!req.url?.startsWith('/__proxy__/')) return next();

        const rawQuery = req.url.slice('/__proxy__/'.length - 1); // includes leading ?
        let targetUrl: string | null = null;
        try {
          targetUrl = new URL('http://x' + rawQuery).searchParams.get('url');
        } catch { /* */ }

        if (!targetUrl) return next();

        try {
          const resp = await fetch(targetUrl, {
            method: (req.method as string) || 'GET',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9',
            },
            redirect: 'follow',
          });

          const BLOCKED_HEADERS = new Set([
            'x-frame-options', 'content-security-policy',
            'content-security-policy-report-only', 'x-content-type-options',
            'strict-transport-security', 'cross-origin-opener-policy',
            'cross-origin-embedder-policy', 'cross-origin-resource-policy',
            'transfer-encoding', // Node handles this itself
          ]);

          for (const [k, v] of resp.headers.entries()) {
            if (!BLOCKED_HEADERS.has(k.toLowerCase())) {
              res.setHeader(k, v);
            }
          }
          res.setHeader('access-control-allow-origin', '*');

          const finalUrl = resp.url || targetUrl;
          const ct = resp.headers.get('content-type') ?? '';
          const isHtml = ct.includes('text/html');
          const isCss = ct.includes('text/css');

          if (isHtml) {
            let html = await resp.text();
            html = rewriteHtmlUrls(html, finalUrl);
            html = injectContentScript(html);
            res.setHeader('content-type', 'text/html; charset=utf-8');
            res.end(html);
          } else if (isCss) {
            let css = await resp.text();
            css = css.replace(/url\(['"]?([^'")\s]+)['"]?\)/gi, (_, u) => `url(${proxyUrlNode(u, finalUrl)})`);
            res.end(css);
          } else {
            const buf = Buffer.from(await resp.arrayBuffer());
            res.end(buf);
          }
        } catch (err: unknown) {
          res.statusCode = 502;
          res.setHeader('content-type', 'text/html; charset=utf-8');
          res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2rem;background:#1a1a2e;color:#e2e8f0;">
            <h2 style="color:#f87171">⚠️ Proxy error</h2>
            <p>URL: <code>${targetUrl}</code></p>
            <p>${(err as Error).message}</p>
          </body></html>`);
        }
      });
    },
  };
}

function proxyUrlNode(url: string, base: string): string {
  if (!url || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:')) return url;
  try {
    const abs = new URL(url, base).href;
    if (abs.startsWith('http://') || abs.startsWith('https://')) {
      return `/__proxy__/?url=${encodeURIComponent(abs)}`;
    }
  } catch { /* */ }
  return url;
}

function rewriteHtmlUrls(html: string, baseUrl: string): string {
  const base = new URL(baseUrl);
  const baseTag = `<base href="${base.origin}${base.pathname}" />`;
  const proxy = (u: string) => proxyUrlNode(u, baseUrl);

  return html
    .replace(/<head([^>]*)>/i, `<head$1>${baseTag}`)
    .replace(/\bhref="((?!#|javascript:|mailto:|tel:)[^"]+)"/gi, (_, u) => `href="${proxy(u)}"`)
    .replace(/\bhref='((?!#|javascript:|mailto:|tel:)[^']+)'/gi, (_, u) => `href='${proxy(u)}'`)
    .replace(/\bsrc="([^"]+)"/gi, (_, u) => `src="${proxy(u)}"`)
    .replace(/\bsrc='([^']+)'/gi, (_, u) => `src='${proxy(u)}'`)
    .replace(/\baction="([^"]+)"/gi, (_, u) => `action="${proxy(u)}"`)
    .replace(/\s+integrity="[^"]*"/gi, '')
    .replace(/\s+crossorigin(="[^"]*")?/gi, '');
}

function injectContentScript(html: string): string {
  const script = `<script>
(function(){
'use strict';
if(window.__opticlick_cs_loaded__)return;
window.__opticlick_cs_loaded__=true;
const CANVAS_ID='__opticlick_overlay__';
const BLOCKER_ID='__opticlick_blocker__';
function collectInteractables(){return[...document.querySelectorAll('a,button,input,select,textarea,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[onclick],[tabindex]')].filter(el=>{const s=getComputedStyle(el);return s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0';});}
function getLabel(el){return(el.getAttribute('aria-label')||el.innerText||el.value||el.placeholder||el.title||el.alt||el.tagName.toLowerCase()).slice(0,80).trim();}
function drawOverlay(){destroyOverlay();const dpr=window.devicePixelRatio||1,w=window.innerWidth,h=window.innerHeight,els=collectInteractables(),canvas=document.createElement('canvas');canvas.id=CANVAS_ID;canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);canvas.style.cssText='position:fixed;top:0;left:0;width:'+w+'px;height:'+h+'px;z-index:2147483647;pointer-events:none;';(document.body||document.documentElement).appendChild(canvas);const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);const map=[];let id=1;for(const el of els){const r=el.getBoundingClientRect();if(r.width<4||r.height<4)continue;ctx.strokeStyle='rgba(255,100,0,0.9)';ctx.lineWidth=1.5;ctx.fillStyle='rgba(255,100,0,0.12)';ctx.strokeRect(r.left+.5,r.top+.5,r.width-1,r.height-1);ctx.fillRect(r.left+1,r.top+1,r.width-2,r.height-2);const label=String(id),bw=Math.max(label.length*7+8,20),bh=16;ctx.fillStyle='#ff6400';ctx.fillRect(r.left,Math.max(0,r.top-bh-1),bw,bh);ctx.fillStyle='#fff';ctx.font='bold 10px sans-serif';ctx.textBaseline='middle';ctx.fillText(label,r.left+4,Math.max(bh/2,r.top-bh/2-1));map.push({id,tag:el.tagName.toLowerCase(),text:getLabel(el),rect:{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),left:Math.round(r.left),top:Math.round(r.top),width:Math.round(r.width),height:Math.round(r.height)}});id++;}return map;}
function destroyOverlay(){document.getElementById(CANVAS_ID)?.remove();}
function installBlocker(){if(document.getElementById(BLOCKER_ID))return;const div=document.createElement('div');div.id=BLOCKER_ID;div.style.cssText='position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,0.3);cursor:not-allowed;';const banner=document.createElement('div');banner.style.cssText='position:absolute;top:0;left:0;right:0;padding:10px;background:#1a1a2e;color:#fff;font:bold 13px sans-serif;text-align:center;';banner.textContent='Opticlick Agent Running — Tab Locked';div.appendChild(banner);document.body.appendChild(div);}
function removeBlocker(){document.getElementById(BLOCKER_ID)?.remove();}
window.addEventListener('message',function(event){if(!event.data?.__opticlick__)return;const{id,type}=event.data;const reply=data=>event.source.postMessage({__opticlick_reply__:true,id,response:data},'*');switch(type){case 'DRAW_MARKS':reply({success:true,coordinateMap:drawOverlay(),dpr:window.devicePixelRatio||1});break;case 'DESTROY_MARKS':destroyOverlay();reply({success:true});break;case 'BLOCK_INPUT':installBlocker();reply({success:true});break;case 'UNBLOCK_INPUT':removeBlocker();reply({success:true});break;case 'PING':reply({alive:true});break;case 'GET_ELEMENT_DOM':{const el=document.elementFromPoint(event.data.x,event.data.y);reply({success:true,outerHTML:el?.outerHTML?.slice(0,2000)??''});break;}default:reply({success:false,error:'unknown:'+type});}});
console.log('[Opticlick] sandbox content script loaded on',location.href);
})();
</script>`;
  return html.includes('</body>') ? html.replace(/<\/body>/i, script + '</body>') : html + script;
}

export default defineConfig(() => ({
  plugins: [react(), tailwindcss(), devProxyPlugin()],
  base: process.env.VITE_BASE_PATH ?? '/',
  define: {
    'import.meta.env.VITE_PR_NUMBER': JSON.stringify(process.env.VITE_PR_NUMBER ?? ''),
    'import.meta.env.VITE_BRANCH_NAME': JSON.stringify(process.env.VITE_BRANCH_NAME ?? ''),
    'import.meta.env.VITE_LANGSMITH_TRACING': JSON.stringify(process.env.VITE_LANGSMITH_TRACING ?? ''),
    'import.meta.env.VITE_LANGSMITH_ENDPOINT': JSON.stringify(process.env.VITE_LANGSMITH_ENDPOINT ?? ''),
    'import.meta.env.VITE_LANGSMITH_API_KEY': JSON.stringify(process.env.VITE_LANGSMITH_API_KEY ?? ''),
    'import.meta.env.VITE_LANGSMITH_PROJECT': JSON.stringify(process.env.VITE_LANGSMITH_PROJECT ?? ''),
  },
  resolve: {
    alias: [
      { find: '@/utils/cdp', replacement: path.resolve(__dirname, 'src/chrome-mock/debugger.ts') },
      { find: '@/utils/tab-helpers', replacement: path.resolve(__dirname, 'src/chrome-mock/messaging.ts') },
      { find: '@/', replacement: path.resolve(__dirname, '../src/') + '/' },
    ],
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'html2canvas'],
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  server: {
    port: 5174,
  },
}));
