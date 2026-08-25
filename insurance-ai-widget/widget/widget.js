(function () {
  'use strict';

  var scriptTag = document.currentScript;
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

  var STORAGE_KEY = 'aifd_history_' + agencyId;
  var state = {
    open: false,
    sending: false,
    history: [], // {role, content}
    showLeadForm: false,
    config: null,
    // Sticky once set. If the visitor opens with "I just got rear-ended" and
    // only hands over their number three turns later, the lead is still
    // urgent - so this latches true and never clears for the session.
    urgent: false,
  };

  // ---------- Styles ----------
  var style = document.createElement('style');
  style.textContent = [
    '.aifd-root{position:fixed;bottom:20px;right:20px;z-index:999999;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}',
    '.aifd-launcher{display:flex;align-items:center;gap:10px;background:var(--aifd-primary,#1B3A4B);color:#fff;border:none;border-radius:999px;padding:14px 20px 14px 16px;box-shadow:0 6px 20px rgba(0,0,0,.22);cursor:pointer;font-size:14px;font-weight:600;transition:transform .15s ease, box-shadow .15s ease;}',
    '.aifd-launcher:hover{transform:translateY(-2px);box-shadow:0 10px 24px rgba(0,0,0,.28);}',
    '.aifd-launcher:focus-visible{outline:3px solid var(--aifd-accent,#C89B3C);outline-offset:2px;}',
    '.aifd-launcher svg{flex-shrink:0;}',
    '.aifd-panel{position:fixed;bottom:20px;right:20px;width:340px;max-width:calc(100vw - 32px);height:480px;max-height:calc(100vh - 100px);background:#fff;border-radius:16px;box-shadow:0 16px 48px rgba(0,0,0,.28);display:flex;flex-direction:column;overflow:hidden;}',
    '.aifd-header{background:var(--aifd-primary,#1B3A4B);color:#fff;padding:16px 18px;display:flex;align-items:center;justify-content:space-between;}',
    '.aifd-header-title{font-size:15px;font-weight:700;line-height:1.2;}',
    '.aifd-header-sub{font-size:12px;opacity:.8;margin-top:2px;}',
    '.aifd-close{background:none;border:none;color:#fff;opacity:.85;cursor:pointer;font-size:20px;line-height:1;padding:4px;}',
    '.aifd-close:hover{opacity:1;}',
    '.aifd-messages{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;background:#F7F5F1;}',
    '.aifd-msg{max-width:82%;padding:10px 13px;border-radius:14px;font-size:13.5px;line-height:1.45;white-space:pre-wrap;}',
    '.aifd-msg.bot{background:#fff;color:#2B2B2B;align-self:flex-start;border-bottom-left-radius:4px;box-shadow:0 1px 2px rgba(0,0,0,.06);}',
    '.aifd-msg.user{background:var(--aifd-primary,#1B3A4B);color:#fff;align-self:flex-end;border-bottom-right-radius:4px;}',
    '.aifd-msg.urgent{background:#FBEAE4;border:1.5px solid #B5482A;color:#7a2f18;font-weight:600;}',
    '.aifd-typing{align-self:flex-start;font-size:12px;color:#8a8a8a;padding:0 4px;}',
    '.aifd-inputrow{display:flex;gap:8px;padding:10px;border-top:1px solid #eee;background:#fff;}',
    '.aifd-input{flex:1;border:1px solid #ddd;border-radius:10px;padding:10px 12px;font-size:13.5px;resize:none;font-family:inherit;}',
    '.aifd-input:focus{outline:none;border-color:var(--aifd-primary,#1B3A4B);}',
    '.aifd-send{background:var(--aifd-accent,#C89B3C);border:none;color:#fff;border-radius:10px;padding:0 16px;font-weight:700;cursor:pointer;font-size:13px;}',
    '.aifd-send:disabled{opacity:.5;cursor:default;}',
    '.aifd-leadform{background:#fff;border:1px solid #e5e0d5;border-radius:12px;padding:12px;align-self:stretch;display:flex;flex-direction:column;gap:8px;}',
    '.aifd-leadform label{font-size:11.5px;color:#555;font-weight:600;}',
    '.aifd-leadform input{border:1px solid #ddd;border-radius:8px;padding:8px 10px;font-size:13px;font-family:inherit;}',
    '.aifd-leadform button{background:var(--aifd-primary,#1B3A4B);color:#fff;border:none;border-radius:8px;padding:9px;font-weight:700;cursor:pointer;font-size:13px;margin-top:2px;}',
    '.aifd-footer{text-align:center;font-size:10.5px;color:#aaa;padding:5px 0 8px;}',
    '@media (prefers-reduced-motion: reduce){.aifd-launcher{transition:none;}}',
  ].join('\n');
  document.head.appendChild(style);

  // ---------- DOM scaffold ----------
  var root = document.createElement('div');
  root.className = 'aifd-root';

  var launcher = document.createElement('button');
  launcher.className = 'aifd-launcher';
  launcher.setAttribute('aria-label', 'Open chat assistant');
  launcher.innerHTML =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M12 2L4 5v6c0 5.2 3.4 9.4 8 11 4.6-1.6 8-5.8 8-11V5l-8-3z" fill="currentColor"/>' +
    '</svg><span class="aifd-launcher-label">Ask us anything</span>';

  var panel = document.createElement('div');
  panel.className = 'aifd-panel';
  panel.style.display = 'none';
  panel.innerHTML =
    '<div class="aifd-header">' +
    '<div><div class="aifd-header-title" data-role="title">Chat with us</div>' +
    '<div class="aifd-header-sub">Usually replies in seconds</div></div>' +
    '<button class="aifd-close" aria-label="Close chat">\u00D7</button>' +
    '</div>' +
    '<div class="aifd-messages" data-role="messages"></div>' +
    '<div class="aifd-inputrow">' +
    '<textarea class="aifd-input" rows="1" placeholder="Type a message..." data-role="input"></textarea>' +
    '<button class="aifd-send" data-role="send">Send</button>' +
    '</div>' +
    '<div class="aifd-footer">AI assistant &middot; for general info</div>';

  root.appendChild(launcher);
  root.appendChild(panel);
  document.body.appendChild(root);

  var messagesEl = panel.querySelector('[data-role="messages"]');
  var inputEl = panel.querySelector('[data-role="input"]');
  var sendBtn = panel.querySelector('[data-role="send"]');
  var titleEl = panel.querySelector('[data-role="title"]');
  var closeBtn = panel.querySelector('.aifd-close');

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
    wrap.innerHTML =
      '<label>Name</label><input type="text" data-field="name" />' +
      '<label>Best phone number</label><input type="tel" data-field="phone" />' +
      '<label>Email (optional)</label><input type="email" data-field="email" />' +
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

  function submitLead(name, phone, email) {
    fetch(apiBase + '/api/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agencyId: agencyId,
        name: name,
        phone: phone,
        email: email || '',
        urgent: state.urgent,
        notes: reasonForContact(),
        // Capped to match the server's own limit. The server rejects bodies
        // over 100kb and submitLead swallows errors, so an unbounded history
        // would mean a long conversation silently loses the whole lead.
        transcript: state.history.slice(-60),
      }),
    }).catch(function () {});
    addMessage('bot', "Thanks, " + name + "! Someone will call you at " + phone + " soon.");
  }

  // ---------- Networking ----------
  function loadConfig() {
    fetch(apiBase + '/api/agency-config?agencyId=' + encodeURIComponent(agencyId))
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        state.config = cfg;
        titleEl.textContent = cfg.businessName || 'Chat with us';
        if (cfg.primaryColor) root.style.setProperty('--aifd-primary', cfg.primaryColor);
        if (cfg.accentColor) root.style.setProperty('--aifd-accent', cfg.accentColor);
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
      body: JSON.stringify({ agencyId: agencyId, message: text, history: state.history }),
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
  launcher.addEventListener('click', function () {
    state.open = true;
    panel.style.display = 'flex';
    launcher.style.display = 'none';
    if (!state.config) loadConfig();
    inputEl.focus();
  });

  closeBtn.addEventListener('click', function () {
    state.open = false;
    panel.style.display = 'none';
    launcher.style.display = 'flex';
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
