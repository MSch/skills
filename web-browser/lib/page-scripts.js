export const PICK_SCRIPT = `(message) => {
  if (!message) throw new Error("pick() requires a message parameter");
  return new Promise((resolve) => {
    const selections = [];
    const selectedElements = new Set();

    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;z-index:2147483647;pointer-events:none";

    const highlight = document.createElement("div");
    highlight.style.cssText = "position:absolute;border:2px solid #3b82f6;background:rgba(59,130,246,0.1);transition:all 0.1s";
    overlay.appendChild(highlight);

    const banner = document.createElement("div");
    banner.style.cssText = "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1f2937;color:white;padding:12px 24px;border-radius:8px;font:14px sans-serif;box-shadow:0 4px 12px rgba(0,0,0,0.3);pointer-events:auto;z-index:2147483647";

    const updateBanner = () => {
      banner.textContent = message + " (" + selections.length + " selected, Cmd/Ctrl+click to add, Enter to finish, ESC to cancel)";
    };
    updateBanner();

    document.body.append(banner, overlay);

    const cleanup = () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      banner.remove();
      selectedElements.forEach((el) => { el.style.outline = ""; });
    };

    const onMove = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || overlay.contains(el) || banner.contains(el)) return;
      const r = el.getBoundingClientRect();
      highlight.style.cssText = "position:absolute;border:2px solid #3b82f6;background:rgba(59,130,246,0.1);top:" + r.top + "px;left:" + r.left + "px;width:" + r.width + "px;height:" + r.height + "px";
    };

    const buildElementInfo = (el) => {
      const parents = [];
      let current = el.parentElement;
      while (current && current !== document.body) {
        const parentInfo = current.tagName.toLowerCase();
        const id = current.id ? "#" + current.id : "";
        const cls = current.className ? "." + current.className.trim().split(/\\s+/).join(".") : "";
        parents.push(parentInfo + id + cls);
        current = current.parentElement;
      }
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        class: el.className || null,
        text: (el.textContent || "").trim().slice(0, 200) || null,
        html: el.outerHTML.slice(0, 500),
        parents: parents.join(" > "),
      };
    };

    const onClick = (e) => {
      if (banner.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || overlay.contains(el) || banner.contains(el)) return;

      if (e.metaKey || e.ctrlKey) {
        if (!selectedElements.has(el)) {
          selectedElements.add(el);
          el.style.outline = "3px solid #10b981";
          selections.push(buildElementInfo(el));
          updateBanner();
        }
      } else {
        cleanup();
        const info = buildElementInfo(el);
        resolve(selections.length > 0 ? selections : info);
      }
    };

    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cleanup();
        resolve(null);
      } else if (e.key === "Enter" && selections.length > 0) {
        e.preventDefault();
        cleanup();
        resolve(selections);
      }
    };

    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
  });
}`;

export const COOKIE_DISMISS_SCRIPT = `(acceptCookies) => {
  const clicked = [];

  const isVisible = (el) => {
    if (!el) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && 
           style.visibility !== 'hidden' && 
           style.opacity !== '0' &&
           (el.offsetParent !== null || style.position === 'fixed' || style.position === 'sticky');
  };

  const tryClick = (selector, description) => {
    const el = typeof selector === 'string' ? document.querySelector(selector) : selector;
    if (isVisible(el)) {
      el.click();
      clicked.push(description || selector);
      return true;
    }
    return false;
  };

  const findButtonByText = (patterns, container = document) => {
    const buttons = Array.from(container.querySelectorAll('button, [role="button"], a.button, input[type="submit"], input[type="button"]'));
    // Sort patterns by length descending to match more specific patterns first
    const sortedPatterns = [...patterns].sort((a, b) => b.length - a.length);
    
    // Check patterns in order of specificity (longest first)
    for (const pattern of sortedPatterns) {
      for (const btn of buttons) {
        const text = (btn.textContent || btn.value || '').trim().toLowerCase();
        if (text.length > 100) continue; // Skip buttons with very long text
        if (!isVisible(btn)) continue; // Skip hidden buttons
        if (typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text)) {
          return btn;
        }
      }
    }
    return null;
  };
  
  const acceptPatterns = [
    'accept all', 'accept cookies', 'allow all', 'allow cookies',
    'i agree', 'i accept', 'yes, i agree', 'agree and continue',
    'alle akzeptieren', 'akzeptieren', 'alle zulassen', 'zustimmen',
    'annehmen', 'einverstanden',
    'accepter tout', 'tout accepter', "j'accepte", 'accepter et continuer', 'accepter',
    'accetta tutti', 'accetta', 'accetto',
    'aceptar todo', 'aceptar', 'acepto',
    'aceitar tudo', 'aceitar',
    'continue', 'agree',
  ];

  const rejectPatterns = [
    'reject all', 'decline all', 'deny all', 'refuse all',
    'i do not agree', 'i disagree', 'no thanks',
    'alle ablehnen', 'ablehnen', 'nicht zustimmen',
    'refuser tout', 'tout refuser', 'refuser',
    'rifiuta tutti', 'rifiuta',
    'rechazar todo', 'rechazar',
    'rejeitar tudo', 'rejeitar',
    'only necessary', 'necessary only', 'nur notwendige',
    'essential only', 'nur essentielle',
  ];

  const patterns = acceptCookies ? acceptPatterns : rejectPatterns;

  // OneTrust
  if (document.querySelector('#onetrust-banner-sdk')) {
    const selector = acceptCookies ? '#onetrust-accept-btn-handler' : '#onetrust-reject-all-handler';
    if (tryClick(selector, 'OneTrust')) return clicked;
  }

  // Google
  if (document.querySelector('[data-consent-dialog]') || document.querySelector('form[action*="consent.google"]') || document.querySelector('#CXQnmb')) {
    const selector = acceptCookies ? '#L2AGLb' : '#W0wltc';
    if (tryClick(selector, 'Google Consent')) return clicked;
  }

  // YouTube (Google-owned, custom consent element)
  if (document.querySelector('ytd-consent-bump-v2-lightbox')) {
    const btn = Array.from(document.querySelectorAll('ytd-consent-bump-v2-lightbox button'))
      .find(b => acceptCookies 
        ? b.textContent.includes('Accept all') || b.ariaLabel?.includes('Accept')
        : b.textContent.includes('Reject all') || b.ariaLabel?.includes('Reject'));
    if (btn) {
      btn.click();
      clicked.push('YouTube');
      return clicked;
    }
  }

  // Cookiebot
  if (document.querySelector('#CybotCookiebotDialog')) {
    const selector = acceptCookies
      ? '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll, #CybotCookiebotDialogBodyButtonAccept'
      : '#CybotCookiebotDialogBodyButtonDecline, #CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll';
    if (tryClick(selector, 'Cookiebot')) return clicked;
  }

  // Didomi
  if (document.querySelector('#didomi-host') || window.Didomi) {
    const selector = acceptCookies ? '#didomi-notice-agree-button' : '#didomi-notice-disagree-button, [data-testid="disagree-button"]';
    if (tryClick(selector, 'Didomi')) return clicked;
  }

  // Quantcast
  if (document.querySelector('.qc-cmp2-container')) {
    const selector = acceptCookies
      ? '.qc-cmp2-summary-buttons button[mode="primary"], .qc-cmp2-button[data-testid="accept-all"]'
      : '.qc-cmp2-summary-buttons button[mode="secondary"], .qc-cmp2-button[data-testid="reject-all"]';
    if (tryClick(selector, 'Quantcast')) return clicked;
  }

  // Usercentrics (shadow DOM)
  const ucRoot = document.querySelector('#usercentrics-root');
  if (ucRoot && ucRoot.shadowRoot) {
    const shadow = ucRoot.shadowRoot;
    const btn = acceptCookies
      ? shadow.querySelector('[data-testid="uc-accept-all-button"]')
      : shadow.querySelector('[data-testid="uc-deny-all-button"]');
    if (btn) { btn.click(); clicked.push('Usercentrics'); return clicked; }
  }

  // TrustArc
  if (document.querySelector('#truste-consent-track') || document.querySelector('.trustarc-banner')) {
    const selector = acceptCookies ? '#truste-consent-button, .trustarc-agree-btn' : '.trustarc-decline-btn';
    if (tryClick(selector, 'TrustArc')) return clicked;
  }

  // Klaro
  if (document.querySelector('.klaro')) {
    const selector = acceptCookies ? '.klaro .cm-btn-accept-all, .klaro .cm-btn-success' : '.klaro .cm-btn-decline';
    if (tryClick(selector, 'Klaro')) return clicked;
  }

  // BBC
  if (document.querySelector('#bbccookies, .bbccookies-banner')) {
    if (acceptCookies && tryClick('#bbccookies-continue-button', 'BBC')) return clicked;
  }

  // Amazon
  if (document.querySelector('#sp-cc') || document.querySelector('#sp-cc-accept')) {
    const selector = acceptCookies ? '#sp-cc-accept' : '#sp-cc-rejectall-link, #sp-cc-decline';
    if (tryClick(selector, 'Amazon')) return clicked;
  }

  // CookieYes
  if (document.querySelector('#cookie-law-info-bar') || document.querySelector('.cky-consent-container')) {
    const selector = acceptCookies ? '#cookie_action_close_header, .cky-btn-accept' : '.cky-btn-reject';
    if (tryClick(selector, 'CookieYes')) return clicked;
  }

  // Generic containers
  const consentContainers = [
    '[class*="cookie-banner"]', '[class*="cookie-consent"]', '[class*="cookie-notice"]',
    '[class*="cookieBanner"]', '[class*="cookieConsent"]', '[class*="cookieNotice"]',
    '[id*="cookie-banner"]', '[id*="cookie-consent"]', '[id*="cookie-notice"]',
    '[class*="consent-banner"]', '[class*="consent-modal"]', '[class*="consent-dialog"]',
    '[class*="gdpr"]', '[id*="gdpr"]', '[class*="privacy-banner"]', '[class*="privacy-notice"]',
    '[role="dialog"][aria-label*="cookie" i]', '[role="dialog"][aria-label*="consent" i]',
  ];

  for (const containerSel of consentContainers) {
    const containers = document.querySelectorAll(containerSel);
    for (const container of containers) {
      if (!isVisible(container)) continue;
      // Skip html/body elements that might match
      if (container.tagName === 'HTML' || container.tagName === 'BODY') continue;
      const btn = findButtonByText(patterns, container);
      if (btn) { btn.click(); clicked.push('Generic (' + containerSel + ')'); return clicked; }
    }
  }

  // Last resort: find button near cookie-related text content
  // Look for visible containers that mention "cookie" and have accept/reject buttons
  // Include custom elements (Reddit uses rpl-modal-card, etc.)
  const allContainers = document.querySelectorAll('div, section, aside, [class*="modal"], [class*="dialog"], [role="dialog"]');
  for (const container of allContainers) {
    if (!isVisible(container)) continue;
    const text = container.textContent?.toLowerCase() || '';
    // Must mention cookies and be reasonably sized (not the whole page)
    if (text.includes('cookie') && text.length > 100 && text.length < 3000) {
      const btn = findButtonByText(patterns, container);
      if (btn && isVisible(btn)) {
        btn.click();
        clicked.push('Generic (text-based)');
        return clicked;
      }
    }
  }

  // Final fallback: look for any visible button with exact accept/reject text
  // that appears alongside cookie-related content on the page
  if (document.body.textContent?.toLowerCase().includes('cookie')) {
    const exactPatterns = acceptCookies 
      ? ['accept all', 'accept cookies', 'allow all', 'i agree', 'alle akzeptieren']
      : ['reject all', 'decline all', 'reject optional', 'alle ablehnen'];
    const singleWordPatterns = acceptCookies ? ['accept', 'agree'] : ['reject', 'decline'];
    const buttons = document.querySelectorAll('button, [role="button"]');
    for (const btn of buttons) {
      if (!isVisible(btn)) continue;
      const text = (btn.textContent || '').trim().toLowerCase();
      if (exactPatterns.some(p => text.includes(p))) {
        btn.click();
        clicked.push('Generic (exact match)');
        return clicked;
      }
    }
    // Try single-word matches as last resort
    for (const btn of buttons) {
      if (!isVisible(btn)) continue;
      const text = (btn.textContent || '').trim().toLowerCase();
      if (singleWordPatterns.some(p => text === p)) {
        btn.click();
        clicked.push('Generic (single word)');
        return clicked;
      }
    }
  }

  return clicked;
}`;

export const IFRAME_DISMISS_SCRIPT = `(acceptCookies) => {
  const clicked = [];

  const isVisible = (el) => {
    if (!el) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && 
           style.visibility !== 'hidden' && 
           style.opacity !== '0' &&
           (el.offsetParent !== null || style.position === 'fixed' || style.position === 'sticky');
  };

  const rejectIndicators = ['do not', "don't", 'nicht', 'no ', 'refuse', 'reject', 'decline', 'deny', 'disagree', 'ablehnen', 'refuser', 'rifiuta', 'rechazar', 'manage', 'settings', 'options', 'customize'];
  const acceptIndicators = ['accept', 'agree', 'allow', 'yes', 'ok', 'got it', 'continue', 'akzeptieren', 'zustimmen', 'accepter', 'accetta', 'aceptar'];

  const isRejectButton = (text) => rejectIndicators.some(p => text.includes(p));
  const isAcceptButton = (text) => acceptIndicators.some(p => text.includes(p)) && !isRejectButton(text);

  const buttons = document.querySelectorAll('button, [role="button"]');
  for (const btn of buttons) {
    const text = (btn.textContent || '').trim().toLowerCase();
    if (!isVisible(btn)) continue;
    const shouldClick = acceptCookies ? isAcceptButton(text) : isRejectButton(text);
    if (shouldClick) { btn.click(); clicked.push('iframe: ' + text.slice(0, 30)); return clicked; }
  }

  const spBtn = acceptCookies
    ? document.querySelector('[title="Accept All"], [title="Accept"], [aria-label*="Accept"]')
    : document.querySelector('[title="Reject All"], [title="Reject"], [aria-label*="Reject"]');
  if (spBtn) { spBtn.click(); clicked.push('Sourcepoint iframe'); return clicked; }

  return clicked;
}`;

export function collectFrames(frameTree, frames = []) {
  frames.push({ id: frameTree.frame.id, url: frameTree.frame.url });
  if (frameTree.childFrames) {
    for (const child of frameTree.childFrames) {
      collectFrames(child, frames);
    }
  }
  return frames;
}
