import React, { useState, useRef, useCallback, useEffect } from 'react';
import { setIframeRef, setCurrentUrl, proxyUrl } from './chrome-mock/tabs';

interface MockBrowserProps {
  initialUrl?: string;
}

export function MockBrowser({ initialUrl = 'https://example.com' }: MockBrowserProps) {
  const [addressInput, setAddressInput] = useState(initialUrl);
  const [currentUrl, setCurrentUrlState] = useState(initialUrl);
  const [isLoading, setIsLoading] = useState(false);
  const [isSecure, setIsSecure] = useState(true);
  const [swReady, setSwReady] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Register iframe ref with tabs shim
  useEffect(() => {
    if (iframeRef.current) {
      setIframeRef(iframeRef.current);
    }
  }, []);

  // Check service worker readiness
  useEffect(() => {
    const checkSW = async () => {
      if (!('serviceWorker' in navigator)) {
        setSwReady(false);
        return;
      }
      const reg = await navigator.serviceWorker.getRegistration('./');
      if (reg?.active) {
        setSwReady(true);
        // Auto-navigate to initial URL once SW is ready
        navigate(initialUrl);
      } else {
        // Wait for SW to become active
        navigator.serviceWorker.ready.then(() => {
          setSwReady(true);
          navigate(initialUrl);
        });
      }
    };
    checkSW();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const navigate = useCallback((url: string) => {
    let target = url.trim();
    if (!target) return;

    // Auto-add protocol
    if (!target.startsWith('http://') && !target.startsWith('https://')) {
      // Check if it looks like a URL or a search query
      if (target.includes('.') && !target.includes(' ')) {
        target = 'https://' + target;
      } else {
        target = 'https://www.google.com/search?q=' + encodeURIComponent(target);
      }
    }

    setCurrentUrlState(target);
    setCurrentUrl(target);
    setAddressInput(target);
    setIsLoading(true);
    setIsSecure(target.startsWith('https://'));

    if (iframeRef.current) {
      iframeRef.current.src = proxyUrl(target);
    }
  }, []);

  const handleAddressKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      navigate(addressInput);
    }
  };

  const handleIframeLoad = () => {
    setIsLoading(false);
    // Try to read actual URL from iframe (may fail cross-origin before proxy is active)
    try {
      const iframeUrl = iframeRef.current?.contentWindow?.location?.href;
      if (iframeUrl && !iframeUrl.includes('/__proxy__/')) {
        setAddressInput(iframeUrl);
        setCurrentUrlState(iframeUrl);
        setCurrentUrl(iframeUrl);
      }
    } catch { /* cross-origin, ignore */ }
  };

  const handleRefresh = () => {
    if (iframeRef.current) {
      setIsLoading(true);
      iframeRef.current.src = iframeRef.current.src;
    }
  };

  return (
    <div className="sandbox-browser-pane">
      {/* Toolbar */}
      <div className="browser-toolbar">
        <button
          className="browser-nav-btn"
          title="Back"
          onClick={() => iframeRef.current?.contentWindow?.history.back()}
        >
          ←
        </button>
        <button
          className="browser-nav-btn"
          title="Forward"
          onClick={() => iframeRef.current?.contentWindow?.history.forward()}
        >
          →
        </button>
        <button
          className="browser-nav-btn"
          title={isLoading ? 'Stop' : 'Refresh'}
          onClick={handleRefresh}
        >
          {isLoading ? '✕' : '↺'}
        </button>

        {/* Address bar */}
        <div className="browser-address-bar">
          <span
            className={`browser-address-lock${isSecure ? '' : ' insecure'}`}
            title={isSecure ? 'Secure' : 'Not secure'}
          >
            {isSecure ? '🔒' : '🔓'}
          </span>
          <input
            className="browser-address-input"
            type="text"
            value={addressInput}
            onChange={e => setAddressInput(e.target.value)}
            onKeyDown={handleAddressKeyDown}
            onFocus={e => e.target.select()}
            placeholder="Enter URL or search..."
            spellCheck={false}
          />
          <button
            className="browser-address-go"
            onClick={() => navigate(addressInput)}
            title="Navigate"
          >
            ›
          </button>
        </div>

        {/* SW status indicator */}
        {!swReady && (
          <span
            title="Service worker not ready. Proxy may not work."
            style={{ fontSize: 16, cursor: 'help' }}
          >
            ⚠️
          </span>
        )}
      </div>

      {/* Loading bar */}
      <div className={`browser-loading-bar${isLoading ? ' loading' : ''}`} />

      {/* Viewport */}
      <div className="browser-viewport">
        {!swReady && (
          <div className="browser-placeholder">
            <div className="browser-placeholder-icon">⏳</div>
            <div className="browser-placeholder-text">
              Initializing proxy service worker…<br />
              <span style={{ fontSize: 12, opacity: 0.6 }}>
                This may take a moment on first load.
              </span>
            </div>
            <button
              className="browser-address-go"
              style={{
                background: 'rgba(99,102,241,0.2)',
                border: '1px solid rgba(99,102,241,0.4)',
                color: '#a5b4fc',
                padding: '6px 14px',
                borderRadius: 6,
                cursor: 'pointer',
                fontSize: 12,
                width: 'auto',
                height: 'auto',
              }}
              onClick={() => window.location.reload()}
            >
              Reload page
            </button>
          </div>
        )}
        <iframe
          ref={iframeRef}
          className="browser-iframe"
          title="Mock Browser"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
          onLoad={handleIframeLoad}
          style={{ display: swReady ? 'block' : 'none' }}
        />
      </div>
    </div>
  );
}
