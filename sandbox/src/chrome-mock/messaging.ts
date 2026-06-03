/**
 * Replaces chrome.tabs.sendMessage and the content script messaging channel.
 *
 * The service worker injects a content script shim into proxied pages that:
 *   - listens for window.postMessage with { __opticlick__: true }
 *   - responds via window.parent.postMessage
 *
 * This module bridges that postMessage channel with the callback/Promise
 * interface that tab-helpers.ts expects.
 */

import { getIframe } from './tabs';

type PendingReply = { resolve: (v: unknown) => void; reject: (e: Error) => void; timeout: ReturnType<typeof setTimeout> };
const pending = new Map<string, PendingReply>();

// Listen for responses from the proxied page
window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data?.__opticlick_reply__) return;
  const { id, response } = data;
  const p = pending.get(id);
  if (p) {
    clearTimeout(p.timeout);
    pending.delete(id);
    p.resolve(response);
  }
});

export function sendToIframe(message: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const iframe = getIframe();
    if (!iframe?.contentWindow) {
      resolve(undefined);
      return;
    }

    const id = Math.random().toString(36).slice(2);
    const timeout = setTimeout(() => {
      pending.delete(id);
      // Don't reject — PING timeouts are expected if content script not ready
      resolve(undefined);
    }, 3000);

    pending.set(id, { resolve, reject, timeout });
    iframe.contentWindow.postMessage({ __opticlick__: true, id, ...message }, '*');
  });
}

/**
 * Replacement for sendToTab() from tab-helpers.ts.
 * Used by the background loop to send DRAW_MARKS, DESTROY_MARKS, BLOCK_INPUT etc.
 */
export async function sendToTabShim<T = unknown>(
  _tabId: number,
  message: Record<string, unknown>,
): Promise<T> {
  return sendToIframe(message) as Promise<T>;
}

/**
 * Replacement for isTabInjectable().
 * In sandbox mode, the iframe is always injectable (proxy ensures same-origin).
 */
export async function isTabInjectableShim(_tabId: number): Promise<boolean> {
  return true;
}

/**
 * Replacement for waitForInjectableTab().
 */
export async function waitForInjectableTabShim(_tabId: number, _timeoutMs?: number): Promise<void> {
  return;
}

/**
 * Replacement for waitForTabLoad().
 */
export function waitForTabLoadShim(_tabId: number, _timeoutMs?: number, _expectNavigation?: boolean): Promise<void> {
  const iframe = getIframe();
  if (!iframe) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => resolve();
    iframe.addEventListener('load', done, { once: true });
    setTimeout(done, _timeoutMs ?? 15000);
  });
}

/**
 * Replacement for retryTabUpdate().
 */
export async function retryTabUpdateShim(
  tabId: number,
  props: chrome.tabs.UpdateProperties,
): Promise<chrome.tabs.Tab> {
  const { tabsShim } = await import('./tabs');
  return tabsShim.update(tabId, props) as Promise<chrome.tabs.Tab>;
}

/**
 * Replacement for ensureContentScript().
 * The content script is injected by the service worker, so this is a no-op.
 */
export async function ensureContentScriptShim(_tabId: number): Promise<void> {
  // Content script is injected by the SW proxy — just ping to confirm
  try {
    await sendToIframe({ type: 'PING' });
  } catch {
    // Not ready yet — that's okay, SW will inject it
  }
}

// ── Canonical exports matching tab-helpers.ts API ─────────────────────────────
// Vite aliases @/utils/tab-helpers to this file, so the extension's
// import { sendToTab } from '@/utils/tab-helpers' resolves here.

export const sendToTab = sendToTabShim;
export const isTabInjectable = isTabInjectableShim;
export const waitForInjectableTab = waitForInjectableTabShim;
export const waitForTabLoad = waitForTabLoadShim;
export const retryTabUpdate = retryTabUpdateShim;
export const ensureContentScript = ensureContentScriptShim;
