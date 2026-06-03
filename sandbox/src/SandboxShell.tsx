import React, { Suspense } from 'react';
import { MockBrowser } from './MockBrowser';
import { LangSmithPanel } from './LangSmithPanel';

// Lazily import the real sidepanel App — it triggers chrome.* calls on mount,
// so chrome-mock must be fully installed before this import resolves.
const SidepanelApp = React.lazy(() => import('@/entrypoints/sidepanel/App'));

const PR_NUMBER = import.meta.env.VITE_PR_NUMBER;
const BRANCH_NAME = import.meta.env.VITE_BRANCH_NAME;

function SidebarLoadingFallback() {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      background: '#fff',
      gap: 12,
      color: '#94a3b8',
      fontSize: 13,
    }}>
      <div style={{
        width: 28,
        height: 28,
        border: '2px solid rgba(99,102,241,0.3)',
        borderTopColor: '#6366f1',
        borderRadius: '50%',
        animation: 'spin 0.8s linear infinite',
      }} />
      Loading sidepanel…
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

export function SandboxShell() {
  return (
    <div className="sandbox-shell">
      {/* ── Banner ─────────────────────────────────────────────────────────── */}
      <div className="sandbox-banner">
        <div className="sandbox-logo">
          <div className="sandbox-logo-icon">🧪</div>
          <span className="sandbox-logo-text">Opticlick Sandbox</span>
        </div>

        {PR_NUMBER && (
          <>
            <span className="sandbox-divider">|</span>
            <div className="sandbox-pr-badge">
              <span className="sandbox-pr-badge-dot" />
              PR #{PR_NUMBER}
            </div>
          </>
        )}

        {BRANCH_NAME && (
          <div
            className="sandbox-branch-badge"
            title={BRANCH_NAME}
          >
            ⎇ {BRANCH_NAME}
          </div>
        )}

        <div className="sandbox-spacer" />

        <a
          className="sandbox-info-btn"
          href="https://github.com/sudip-mondal-2002/Opticlick"
          target="_blank"
          rel="noopener noreferrer"
        >
          GitHub ↗
        </a>
      </div>

      {/* ── Main Split ─────────────────────────────────────────────────────── */}
      <div className="sandbox-content">
        {/* Left: Real sidepanel */}
        <div className="sandbox-sidebar">
          <Suspense fallback={<SidebarLoadingFallback />}>
            <SidepanelApp />
          </Suspense>
        </div>

        {/* Right: Mock browser + LangSmith */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <MockBrowser initialUrl="https://example.com" />
          <LangSmithPanel />
        </div>
      </div>
    </div>
  );
}
