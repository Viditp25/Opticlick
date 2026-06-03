/**
 * chrome.runtime shim
 *
 * - sendMessage → EventEmitter bus
 * - onMessage → subscribe to bus
 * - Special: START_AGENT → dynamically imports and calls runAgentLoop()
 * - lastError → always null in sandbox
 */

type Listener = (msg: Record<string, unknown>, sender: unknown, sendResponse: (r: unknown) => void) => boolean | void;

const listeners: Listener[] = [];

export function dispatchRuntimeMessage(msg: Record<string, unknown>): void {
  listeners.forEach(l => {
    try { l(msg, {}, () => {}); } catch { /* */ }
  });
}

let _agentRunning = false;

export const runtimeShim = {
  sendMessage(
    msg: Record<string, unknown>,
    callback?: (response: unknown) => void,
  ): Promise<unknown> {
    // Handle START_AGENT — run the real agent loop in-page
    if (msg.type === 'START_AGENT') {
      if (_agentRunning) {
        callback?.({ started: false, reason: 'already_running' });
        return Promise.resolve({ started: false });
      }
      _agentRunning = true;

      import('../agent-runner').then(({ runSandboxAgent }) => {
        runSandboxAgent(msg).finally(() => { _agentRunning = false; });
      });

      callback?.({ started: true });
      return Promise.resolve({ started: true });
    }

    if (msg.type === 'STOP_AGENT') {
      import('../agent-runner').then(({ stopSandboxAgent }) => stopSandboxAgent());
      dispatchRuntimeMessage({ type: 'AGENT_STATE_CHANGE' });
      callback?.({ stopped: true });
      return Promise.resolve({ stopped: true });
    }

    // Broadcast to all listeners (sidepanel observes AGENT_LOG, AGENT_STATE_CHANGE, etc.)
    dispatchRuntimeMessage(msg);
    callback?.(undefined);
    return Promise.resolve(undefined);
  },

  onMessage: {
    addListener(cb: Listener) { listeners.push(cb); },
    removeListener(cb: Listener) {
      const i = listeners.indexOf(cb);
      if (i !== -1) listeners.splice(i, 1);
    },
    hasListener: () => false,
  },

  lastError: null,

  id: 'sandbox-extension-id',

  getManifest() {
    return {
      name: 'Opticlick Engine (Sandbox)',
      version: '0.0.0-sandbox',
      manifest_version: 3,
    };
  },

  getURL(path: string): string {
    return '/' + path.replace(/^\//, '');
  },
};
