(function () {
  'use strict';

  var scriptTag = document.currentScript;
  if (!scriptTag) {
    // currentScript is null when this file is loaded as a module or re-run
    // from a callback. Without the tag there is no data-agency to read, so
    // there is nothing sensible to do but say so.
    console.error('[AI Front Desk] widget.js must be loaded with a plain <script src=...> tag.');
    return;
  }

  var agencyId = scriptTag.getAttribute('data-agency');
  var explicitApi = (scriptTag.getAttribute('data-api') || '').replace(/\/$/, '');

  // If data-api isn't set, assume the widget is hosted on the same server as
  // the API (true for the sales demo page) by deriving it from this script's
  // own src. Real client sites should always set data-api explicitly, since
  // the widget lives on THEIR domain but the API lives on yours.
  var apiBase = explicitApi;
  if (!apiBase) {
    try {
      var scriptUrl = new URL(scriptTag.src, window.location.href);
      apiBase = scriptUrl.origin;
    } catch (e) {}
  }

  if (!agencyId || !apiBase) {
    console.error('[AI Front Desk] widget.js requires data-agency (and data-api on external sites).');
    return;
  }

  // One widget per page, and the first tag in the document wins.
  //
  // koveralink.com injects a site-wide assistant into every page through
  // Netlify snippet injection, immediately before </body> - which includes
  // the demo page, where a second tag for the demo agency is already in the
  // markup. Two widgets then mount in the same fixed corner, and because the
  // injected one arrives last it lands on top: a prospect clicking the bubble
  // on koveralink.com/demo reached the wrong assistant entirely.
  //
  // First-wins is the right rule rather than a coincidence that happens to
  // fix that page. A tag written into a page is deliberate; anything arriving
  // later is a site-wide default that should yield to it. It also means a
  // client who pastes the embed twice gets one working widget instead of two
  // overlapping ones, which is the far more likely way this recurs.
  if (window.__aifdAgency) {
    console.warn(
      '[AI Front Desk] "' + window.__aifdAgency + '" is already on this page; ' +
      'ignoring the later tag for "' + agencyId + '".'
    );
    return;
  }
  window.__aifdAgency = agencyId;

  var STORAGE_KEY = 'aifd_history_' + agencyId;
  var REF_KEY = 'aifd_ref_' + agencyId;

  // A demo link sent to a specific prospect carries ?a=<slug>. It identifies
  // the OUTREACH, not the reader - it says which email a visit came from and
  // nothing about who opened it, which is the whole reason it is a slug we
  // picked rather than anything derived from the visitor.
  //
  // Held for the tab, so someone who lands on /demo?a=kelton and then clicks
  // through to another page is still credited to the email that brought them.
  // Whitelisted and length-capped because this string ends up rendered in a
  // report: appending ?a=<script> must not be able to put it there.
  function readRef() {
    var match = /[?&]a=([^&#]*)/.exec(window.location.search || '');
    var clean = '';
    if (match) {
      try {
        clean = decodeURIComponent(match[1]).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
      } catch (e) {
        clean = '';
      }
    }
    try {
      if (clean) {
        window.sessionStorage.setItem(REF_KEY, clean);
        return clean;
      }
      return window.sessionStorage.getItem(REF_KEY) || '';
    } catch (e) {
      // Private browsing, or storage switched off. The tag still works on the
      // page it arrived on, which is where nearly every one of these visits
      // begins and ends.
      return clean;
    }
  }

  // One id per page load, so the backend can count conversations rather than
  // messages. Not stored anywhere and not tied to a person - it exists only to
  // group a visitor's turns together for the agency's usage report.
  function newSessionId() {
    try {
      if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    } catch (e) {}
    return 'S' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  var state = {
    sessionId: newSessionId(),
    ref: readRef(),
    consentShown: false,
    open: false,
    sending: false,
    history: [], // {role, content}
    showLeadForm: false,
    config: null,
    leadSubmitted: false,
    // Sticky once set. If the visitor opens with "I just got rear-ended" and
    // only hands over their number three turns later, the lead is still
    // urgent - so this latches true and never clears for the session.
    urgent: false,
  };

  // ---------- Styles ----------
  var style = document.createElement('style');
  style.textContent = [
    '.aifd-root{position:fixed;bottom:20px;right:20px;z-index:999999;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}',
    '.aifd-launcher{display:flex;align-items:center;gap:10px;background:var(--aifd-primary,#1B3A4B);color:var(--aifd-on-primary,#fff);border:none;border-radius:999px;padding:14px 20px 14px 16px;box-shadow:0 6px 20px rgba(0,0,0,.22);cursor:pointer;font-size:14px;font-weight:600;transition:transform .15s ease, box-shadow .15s ease;}',
    '.aifd-launcher:hover{transform:translateY(-2px);box-shadow:0 10px 24px rgba(0,0,0,.28);}',
    '.aifd-launcher:focus-visible{outline:3px solid var(--aifd-accent,#C89B3C);outline-offset:2px;}',
    '.aifd-launcher svg{flex-shrink:0;}',
    '.aifd-panel{position:fixed;bottom:20px;right:20px;width:340px;max-width:calc(100vw - 32px);height:480px;max-height:calc(100vh - 100px);background:#fff;border-radius:16px;box-shadow:0 16px 48px rgba(0,0,0,.28);display:flex;flex-direction:column;overflow:hidden;}',
    '.aifd-header{background:var(--aifd-primary,#1B3A4B);color:var(--aifd-on-primary,#fff);padding:16px 18px;display:flex;align-items:center;justify-content:space-between;}',
    '.aifd-header-title{font-size:15px;font-weight:700;line-height:1.2;}',
    '.aifd-header-sub{font-size:12px;opacity:.8;margin-top:2px;}',
    '.aifd-close{background:none;border:none;color:var(--aifd-on-primary,#fff);opacity:.85;cursor:pointer;font-size:20px;line-height:1;padding:4px;}',
    '.aifd-close:hover{opacity:1;}',
    '.aifd-messages{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;background:#F7F5F1;}',
    '.aifd-msg{max-width:82%;padding:10px 13px;border-radius:14px;font-size:13.5px;line-height:1.45;white-space:pre-wrap;}',
    '.aifd-msg.bot{background:#fff;color:#2B2B2B;align-self:flex-start;border-bottom-left-radius:4px;box-shadow:0 1px 2px rgba(0,0,0,.06);}',
    '.aifd-msg.user{background:var(--aifd-primary,#1B3A4B);color:var(--aifd-on-primary,#fff);align-self:flex-end;border-bottom-right-radius:4px;}',
    '.aifd-msg.urgent{background:#FBEAE4;border:1.5px solid #B5482A;color:#7a2f18;font-weight:600;}',
    '.aifd-typing{align-self:flex-start;font-size:12px;color:#6B6B6B;padding:0 4px;}',
    '.aifd-inputrow{display:flex;gap:8px;padding:10px;border-top:1px solid #eee;background:#fff;}',
    '.aifd-input{flex:1;border:1px solid #ddd;border-radius:10px;padding:10px 12px;font-size:13.5px;resize:none;font-family:inherit;}',
    '.aifd-input:focus{outline:none;border-color:var(--aifd-primary,#1B3A4B);}',
    '.aifd-send{background:var(--aifd-accent,#C89B3C);border:none;color:var(--aifd-on-accent,#fff);border-radius:10px;padding:0 16px;font-weight:700;cursor:pointer;font-size:13px;}',
    '.aifd-send:disabled{opacity:.5;cursor:default;}',
    '.aifd-leadform{background:#fff;border:1px solid #e5e0d5;border-radius:12px;padding:12px;align-self:stretch;display:flex;flex-direction:column;gap:8px;}',
    '.aifd-leadform label{font-size:11.5px;color:#555;font-weight:600;}',
    '.aifd-leadform input{border:1px solid #ddd;border-radius:8px;padding:8px 10px;font-size:13px;font-family:inherit;}',
    '.aifd-leadform button{background:var(--aifd-primary,#1B3A4B);color:var(--aifd-on-primary,#fff);border:none;border-radius:8px;padding:9px;font-weight:700;cursor:pointer;font-size:13px;margin-top:2px;}',
    '.aifd-footer{text-align:center;font-size:11px;color:#6B6B6B;padding:5px 0 8px;}',
    '.aifd-close:focus-visible,.aifd-send:focus-visible,.aifd-leadform button:focus-visible{outline:3px solid #1266C7;outline-offset:2px;}',
    '.aifd-input:focus-visible,.aifd-leadform input:focus-visible{outline:2px solid #1266C7;outline-offset:1px;}',
    '@media (prefers-reduced-motion: reduce){.aifd-launcher{transition:none;}}',
  ].join('\n');
  document.head.appendChild(style);

  // ---------- DOM scaffold ----------
  var root = document.createElement('div');
  root.className = 'aifd-root';

  var launcher = document.createElement('button');
  launcher.className = 'aifd-launcher';
  launcher.setAttribute('aria-label', 'Open chat assistant');
  launcher.setAttribute('aria-expanded', 'false');
  launcher.innerHTML =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M12 2L4 5v6c0 5.2 3.4 9.4 8 11 4.6-1.6 8-5.8 8-11V5l-8-3z" fill="currentColor"/>' +
    '</svg><span class="aifd-launcher-label">Ask us anything</span>';

  var panel = document.createElement('div');
  panel.className = 'aifd-panel';
  panel.style.display = 'none';
  // Announced as a dialog rather than an anonymous div, and labelled by the
  // agency name in the header so a screen reader says whose chat this is.
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'aifd-title');
  panel.innerHTML =
    '<div class="aifd-header">' +
    '<div><div class="aifd-header-title" id="aifd-title" data-role="title">Chat with us</div>' +
    '<div class="aifd-header-sub">Usually replies in seconds</div></div>' +
    '<button class="aifd-close" aria-label="Close chat">\u00D7</button>' +
    '</div>' +
    '<div class="aifd-messages" data-role="messages" role="log" aria-live="polite" aria-atomic="false"></div>' +
    '<div class="aifd-inputrow">' +
    '<textarea class="aifd-input" rows="1" placeholder="Type a message..." data-role="input"></textarea>' +
    '<button class="aifd-send" data-role="send">Send</button>' +
    '</div>' +
    '<div class="aifd-footer" data-role="footer">AI assistant &middot; for general info</div>';

  root.appendChild(launcher);
  root.appendChild(panel);
  document.body.appendChild(root);

  var messagesEl = panel.querySelector('[data-role="messages"]');
  var inputEl = panel.querySelector('[data-role="input"]');
  var sendBtn = panel.querySelector('[data-role="send"]');
  var titleEl = panel.querySelector('[data-role="title"]');
  var closeBtn = panel.querySelector('.aifd-close');
  var footerEl = panel.querySelector('[data-role="footer"]');

  // ---------- Contrast ----------
  // Agency brand colours are arbitrary. A light accent with white button text
  // is unreadable, and we cannot know in advance what a client will pick - so
  // derive the text colour from the background instead of assuming white.
  function relativeLuminance(hex) {
    var h = String(hex || '').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length !== 6) return null;
    var parts = [0, 2, 4].map(function (i) {
      var v = parseInt(h.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    if (parts.some(isNaN)) return null;
    return 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2];
  }

  function readableTextOn(hex) {
    var L = relativeLuminance(hex);
    if (L === null) return '#fff';
    var onWhite = 1.05 / (L + 0.05);
    var onBlack = (L + 0.05) / 0.05;
    return onBlack >= onWhite ? '#111111' : '#FFFFFF';
  }

  // ---------- Rendering helpers ----------
  function addMessage(role, text, urgent) {
    var el = document.createElement('div');
    el.className = 'aifd-msg ' + (role === 'user' ? 'user' : 'bot') + (urgent ? ' urgent' : '');
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function showTyping() {
    var el = document.createElement('div');
    el.className = 'aifd-typing';
    el.setAttribute('data-role', 'typing-indicator');
    el.setAttribute('aria-hidden', 'true');
    el.textContent = 'Typing...';
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function hideTyping() {
    var el = messagesEl.querySelector('[data-role="typing-indicator"]');
    if (el) el.remove();
  }

  function renderLeadForm() {
    var wrap = document.createElement('div');
    wrap.className = 'aifd-leadform';
    wrap.setAttribute('data-role', 'lead-form');
    // for/id pairs, so a screen reader reads the label when the field takes
    // focus. Unassociated <label> elements are announced as loose text.
    var uid = 'aifd-lf-' + Math.floor(Date.now() % 1e6);
    wrap.innerHTML =
      '<label for="' + uid + '-name">Name</label>' +
      '<input id="' + uid + '-name" type="text" autocomplete="name" data-field="name" />' +
      '<label for="' + uid + '-phone">Best phone number</label>' +
      '<input id="' + uid + '-phone" type="tel" autocomplete="tel" data-field="phone" />' +
      '<label for="' + uid + '-email">Email (optional)</label>' +
      '<input id="' + uid + '-email" type="email" autocomplete="email" data-field="email" />' +
      '<button type="button">Request a callback</button>';
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    wrap.querySelector('button').addEventListener('click', function () {
      var name = wrap.querySelector('[data-field="name"]').value.trim();
      var phone = wrap.querySelector('[data-field="phone"]').value.trim();
      var email = wrap.querySelector('[data-field="email"]').value.trim();
      if (!name || !phone) return;
      submitLead(name, phone, email);
      wrap.remove();
    });
  }

  // The visitor's opening line is, in practice, why they came - "I just got
  // rear-ended", "do you write commercial auto". Better to derive the reason
  // from what they already said than to add another box to the form.
  function reasonForContact() {
    for (var i = 0; i < state.history.length; i++) {
      if (state.history[i].role === 'user') return state.history[i].content;
    }
    return '';
  }

  // Tells the visitor to call, rather than letting them walk away believing
  // someone has their number when nothing left the building.
  function leadFailureMessage() {
    var tel = (state.config && state.config.phone) || '';
    return tel
      ? "I couldn't get that through to the office just now — please call us at " + tel + " so this doesn't get lost."
      : "I couldn't get that through to the office just now — please give us a call so this doesn't get lost.";
  }

  // onDone(ok) always fires unless a lead was already sent for this session.
  // Returns false if it declined to send because one already went.
  function postLead(name, phone, email, reason, onDone) {
    if (state.leadSubmitted) return false;
    state.leadSubmitted = true;

    fetch(apiBase + '/api/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agencyId: agencyId,
        sessionId: state.sessionId,
        ref: state.ref || undefined,
        consentShown: state.consentShown,
        name: name,
        phone: phone,
        email: email || '',
        urgent: state.urgent,
        notes: reason || reasonForContact(),
        // Capped to match the server's own limit, so a long conversation
        // cannot push the body over the size limit and lose the whole lead.
        transcript: state.history.slice(-60),
      }),
    })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (data) {
        if (data && data.ok) return onDone(true);
        // Let them try again - the server retried the email already, so this
        // is a real failure rather than a blip.
        state.leadSubmitted = false;
        onDone(false);
      })
      .catch(function () {
        state.leadSubmitted = false;
        onDone(false);
      });

    return true;
  }

  // Form path: the agency is on the default prompt and the model asked for a
  // form. The confirmation now waits for the server, so we never promise a
  // callback for a lead that did not actually get through.
  function submitLead(name, phone, email) {
    postLead(name, phone, email, null, function (ok) {
      addMessage('bot', ok
        ? "Thanks, " + name + "! Someone will call you at " + phone + " soon."
        : leadFailureMessage());
    });
  }

  // Conversational path: the agency has a prompt override and the model is
  // collecting details in the conversation itself. It sends back everything it
  // has each turn; we send the lead the moment a name and a number are both
  // there. No confirmation line - the assistant's own reply already said it,
  // and a canned line on top reads like a robot talking over itself.
  function maybeSubmitConversationalLead(lead) {
    if (!lead || state.leadSubmitted) return;
    if (!lead.name || !lead.phone) return;
    postLead(lead.name, lead.phone, lead.email, lead.reason, function (ok) {
      // Silent on success - the assistant's own reply already said someone
      // will call. Only speak up when that promise would have been false.
      if (!ok) addMessage('bot', leadFailureMessage());
    });
  }

  // ---------- Networking ----------
  function loadConfig() {
    fetch(apiBase + '/api/agency-config?agencyId=' + encodeURIComponent(agencyId))
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        state.config = cfg;
        titleEl.textContent = cfg.businessName || 'Chat with us';
        // Permanently visible above the input, so it is on screen when a
        // visitor types their number - not shown once and scrolled away.
        if (cfg.consentNote) {
          footerEl.textContent = cfg.consentNote;
          state.consentShown = true;
        }
        if (cfg.primaryColor) {
          root.style.setProperty('--aifd-primary', cfg.primaryColor);
          root.style.setProperty('--aifd-on-primary', readableTextOn(cfg.primaryColor));
        }
        if (cfg.accentColor) {
          root.style.setProperty('--aifd-accent', cfg.accentColor);
          root.style.setProperty('--aifd-on-accent', readableTextOn(cfg.accentColor));
        }
        addMessage('bot', cfg.greeting || 'Hi! How can I help?');
      })
      .catch(function () {
        addMessage('bot', "Hi! How can I help today?");
      });
  }

  function sendMessage(text) {
    if (!text || state.sending) return;
    state.sending = true;
    sendBtn.disabled = true;
    addMessage('user', text);
    state.history.push({ role: 'user', content: text });
    showTyping();

    fetch(apiBase + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agencyId: agencyId,
        message: text,
        history: state.history,
        sessionId: state.sessionId,
        // Omitted entirely when there is no tag, so an ordinary visitor's
        // request looks exactly as it did before.
        ref: state.ref || undefined,
      }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        hideTyping();
        addMessage('bot', data.reply, data.urgent);
        state.history.push({ role: 'assistant', content: data.reply });
        if (data.urgent) state.urgent = true;
        if (data.urgent && state.config && state.config.phone) {
          addMessage('bot', 'Please call us right now at ' + state.config.phone + '.');
        }
        if (data.showLeadForm) renderLeadForm();
        maybeSubmitConversationalLead(data.lead);
      })
      .catch(function () {
        hideTyping();
        addMessage('bot', "Sorry, something went wrong. Please try again in a moment.");
      })
      .finally(function () {
        state.sending = false;
        sendBtn.disabled = false;
      });
  }

  // ---------- Events ----------
  function focusables() {
    return Array.prototype.filter.call(
      panel.querySelectorAll('button, textarea, input, [href]'),
      function (el) { return !el.disabled && el.offsetParent !== null; }
    );
  }

  function openPanel() {
    state.open = true;
    panel.style.display = 'flex';
    launcher.style.display = 'none';
    launcher.setAttribute('aria-expanded', 'true');
    if (!state.config) loadConfig();
    inputEl.focus();
  }

  function closePanel() {
    state.open = false;
    panel.style.display = 'none';
    launcher.style.display = 'flex';
    launcher.setAttribute('aria-expanded', 'false');
    // Send focus back where it came from. Without this a keyboard user is
    // dropped at the top of the page and has to tab all the way back.
    launcher.focus();
  }

  launcher.addEventListener('click', openPanel);
  closeBtn.addEventListener('click', closePanel);

  // Escape closes, which is expected of anything announced as a dialog.
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && state.open) {
      e.stopPropagation();
      closePanel();
    }
  });

  // Keep Tab inside the panel while it is open. aria-modal tells a screen
  // reader the rest of the page is inert; without a trap, the keyboard
  // disagrees and focus wanders off behind the dialog.
  panel.addEventListener('keydown', function (e) {
    if (e.key !== 'Tab' || !state.open) return;
    var items = focusables();
    if (!items.length) return;
    var first = items[0];
    var last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    }
  });

  sendBtn.addEventListener('click', function () {
    var text = inputEl.value.trim();
    inputEl.value = '';
    sendMessage(text);
  });

  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendBtn.click();
    }
  });
})();
