// AI Front Desk - backend server
// Handles: chat requests (proxied to Claude), lead capture + email notification,
// and serving per-agency public config to the embedded widget.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '100kb' }));

// --- CORS: lock down to your clients' domains once live ---
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.length ? allowedOrigins : true,
  })
);

// --- Abuse and cost control ------------------------------------------------
// Neither POST endpoint had any limit: no auth, no rate limit, no captcha.
// CORS is not protection - it is a browser convention and curl ignores it
// entirely. Anyone who reads the widget source has the endpoint and a valid
// agency id, and every /api/chat call spends money at Anthropic.
//
// In-memory counters are enough here because this runs as a single instance.
// They reset on restart, which is acceptable for a backstop: the point is to
// stop a script, not to bill accurately.

// Render terminates TLS upstream. Without this every request appears to come
// from the proxy, so the per-IP limiter would throttle all visitors as one
// shared bucket - one abuser would lock out every real customer.
app.set('trust proxy', 1);

const MAX_MESSAGE_CHARS = Number(process.env.MAX_MESSAGE_CHARS || 2000);
const MAX_HISTORY_TURNS = 10;

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.ip || 'unknown';
}

function createLimiter({ windowMs, max, name }) {
  const hits = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, Math.min(windowMs, 10 * 60 * 1000));
  if (sweep.unref) sweep.unref();

  return function check(key) {
    const now = Date.now();
    let rec = hits.get(key);
    if (!rec || rec.resetAt <= now) {
      rec = { count: 0, resetAt: now + windowMs };
      hits.set(key, rec);
    }
    rec.count += 1;
    if (rec.count > max) {
      console.warn(`Rate limit [${name}] key=${key} count=${rec.count} max=${max}`);
      return { ok: false, retryAfter: Math.max(1, Math.ceil((rec.resetAt - now) / 1000)) };
    }
    return { ok: true, retryAfter: 0 };
  };
}

// Per visitor: a real conversation is a handful of turns. 30 in 10 minutes is
// generous for a person and useless for a script.
const chatIpLimiter = createLimiter({
  windowMs: 10 * 60 * 1000,
  max: Number(process.env.CHAT_IP_MAX || 30),
  name: 'chat/ip',
});

// Per agency per day: the hard stop on the Anthropic bill. Set well above real
// traffic - it exists so a distributed script cannot run the balance to zero
// overnight, which has already happened once.
const chatDayLimiter = createLimiter({
  windowMs: 24 * 60 * 60 * 1000,
  max: Number(process.env.CHAT_AGENCY_DAILY_MAX || 750),
  name: 'chat/agency-day',
});

// Leads are rare by nature. More than a few an hour from one address is abuse,
// and the cost of it lands in a paying client's inbox.
const leadIpLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.LEAD_IP_MAX || 5),
  name: 'lead/ip',
});

// --- Serve the embeddable widget files ---
app.use('/widget', express.static(path.join(__dirname, '..', 'widget')));

// --- Serve the sales demo page so it's reachable from any phone/browser
// once this server is deployed, e.g. https://your-app.onrender.com/demo ---
app.get(['/demo', '/demo.html'], (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'demo.html'));
});

// --- Config loading ---
const CONFIG_DIR = path.join(__dirname, 'config');
const configCache = new Map();

function loadAgencyConfig(agencyId) {
  if (!/^[a-z0-9-]+$/i.test(agencyId || '')) return null;
  if (configCache.has(agencyId)) return configCache.get(agencyId);

  const filePath = path.join(CONFIG_DIR, `${agencyId}.json`);
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, 'utf8');
  const config = JSON.parse(raw);
  configCache.set(agencyId, config);
  return config;
}

// Public config fields the widget is allowed to read on load
app.get('/api/agency-config', (req, res) => {
  const config = loadAgencyConfig(req.query.agencyId);
  if (!config) return res.status(404).json({ error: 'Unknown agency' });

  res.json({
    businessName: config.businessName,
    greeting: config.greeting,
    phone: config.phone,
    primaryColor: config.primaryColor,
    accentColor: config.accentColor,
    // Shown in the widget footer, permanently visible above the input, so it
    // is on screen at the moment a visitor types their number rather than
    // buried in a policy nobody opens.
    consentNote: config.consentNote || '',
  });
});

// --- Chat endpoint ---

// The tail that makes the response machine-readable. NOT agency-configurable:
// the parser below depends on it, so it is always appended by the server, never
// supplied by a config file.
const OUTPUT_CONTRACT_BASIC =
  `Respond ONLY with a single JSON object and nothing else. Do not write any greeting, explanation, or conversational text before or after it. Do not use markdown fences. Your entire response must be exactly this shape and nothing more:
{"reply": "your chat message to the visitor", "urgent": true or false, "showLeadForm": true or false}`;

// Used only by agencies with a prompt override. Adds the lead object, which is
// how an agency captures contact details in conversation instead of by
// rendering a form. Agencies without an override never see this and behave
// exactly as before.
const OUTPUT_CONTRACT_WITH_LEAD =
  `Respond ONLY with a single JSON object and nothing else. Do not write any greeting, explanation, or conversational text before or after it. Do not use markdown fences. Your entire response must be exactly this shape and nothing more:
{"reply": "your chat message to the visitor", "urgent": true or false, "showLeadForm": false, "lead": {"name": null, "phone": null, "email": null, "reason": null}}

Carry every lead value you have already learned forward into every later response - the fields are re-read each turn, so dropping one loses it. Leave a field null until the visitor actually gives it. Never put a Social Security number, date of birth, policy number, driver's license number, or payment detail into any field, even if the visitor typed one.

Before you send the reply, look at the lead object you just filled in and check it against the last sentence of your reply:

- lead.name is null, and this is NOT urgent -> your reply MUST end by asking for their name. Not "what's your situation", not "are you looking for a quote", not "what can I help you with". Their name.
- lead.phone is null, and this IS urgent -> your reply MUST end by asking for their number.
- lead.name is filled but lead.phone is null -> your reply MUST end by asking for their number, using their name.
- both filled -> ask whatever is genuinely useful.

This check is not optional and it is not a stylistic preference. A conversation that ends without a name and a number produced nothing, no matter how helpful it was.`;

// --- Per-agency prompt override -------------------------------------------
// A config may set "systemPromptFile" (a filename next to the configs). That
// file replaces the default prompt body for that agency only. This is what
// keeps one backend serving every client: a client who needs different rules
// is still a new file, not a new codebase - and crucially, not an edit to the
// shared template that every other agency is running on.

const PROMPT_DIR = CONFIG_DIR;
const promptCache = new Map();

function loadPromptFile(filename) {
  if (!/^[a-z0-9._-]+$/i.test(filename || '')) return null;
  if (promptCache.has(filename)) return promptCache.get(filename);

  const filePath = path.join(PROMPT_DIR, filename);
  if (!fs.existsSync(filePath)) {
    console.warn(`Prompt file ${filename} not found - falling back to the default prompt.`);
    return null;
  }
  const text = fs.readFileSync(filePath, 'utf8');
  promptCache.set(filename, text);
  return text;
}

// Current date and time in the agency's own timezone, so the assistant can
// tell whether it is open right now and name the next opening. Without this
// the model has hours as a string and no idea what time it is.
function currentTimeFor(config) {
  const timeZone = config.timezone || 'America/New_York';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    }).format(new Date());
  } catch (e) {
    console.warn(`Invalid timezone "${timeZone}" - falling back to UTC.`);
    return new Date().toUTCString();
  }
}

// {{key}} is replaced by that key from the config, so a prompt file never
// hardcodes a phone number or a set of hours that the config also defines.
function fillPlaceholders(template, config) {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key) => {
    if (key === 'now') return currentTimeFor(config);
    const value = config[key];
    if (Array.isArray(value)) return value.join(', ');
    if (value === undefined || value === null) return whole;
    return String(value);
  });
}

function buildSystemPrompt(config) {
  if (config.systemPromptFile) {
    const template = loadPromptFile(config.systemPromptFile);
    if (template) {
      return `${fillPlaceholders(template, config).trim()}\n\n${OUTPUT_CONTRACT_WITH_LEAD}`;
    }
  }
  return buildDefaultSystemPrompt(config);
}

function buildDefaultSystemPrompt(config) {
  return `You are the front-desk chat assistant embedded on the website of ${config.businessName}, ${config.industry} based in ${config.address}.

Business facts (only use these, never invent services, prices, or commitments):
- Services offered: ${config.services.join(', ')}
- Hours: ${config.hours}
- Phone: ${config.phone}
- Address: ${config.address}
- Tone: ${config.tone}

Your job, in order of priority:
1. If the visitor describes anything matching this business's definition of urgent — ${config.urgentDescription} — respond with urgency, tell them to call ${config.phone} right now, and set "urgent" to true.
2. Answer general questions about services, hours, and location using only the facts above. If you don't know something specific (exact pricing, contract terms, project scope), say a team member will follow up rather than guessing.
3. If the visitor seems interested in talking further, warmly ask if you can get their name and best phone number so someone can reach out, AND set "showLeadForm" to true in that same response. Don't wait for a separate "yes" first - the form itself is how they respond, so asking and showing the form happen together in one turn.

Never give specific pricing, contractual commitments, or professional/legal/technical advice beyond the facts above. Never make up facts not listed above.

${OUTPUT_CONTRACT_BASIC}`;
}

// Only these four fields, only strings, length-capped. The model is told never
// to put an SSN or a policy number in here, but "told never to" is not a
// guarantee - so redactSensitive runs over it too before it goes anywhere.
function sanitizeLead(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const out = {};
  let any = false;
  for (const key of ['name', 'phone', 'email', 'reason']) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) {
      out[key] = redactSensitive(value.trim()).slice(0, 300);
      any = true;
    }
  }
  return any ? out : undefined;
}

app.post('/api/chat', async (req, res) => {
  try {
    const { agencyId, message, history } = req.body || {};
    const config = loadAgencyConfig(agencyId);
    if (!config) return res.status(404).json({ error: 'Unknown agency' });
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Missing message' });
    }

    // Both limits return a `reply` as well as the 429, because the widget
    // renders data.reply on any JSON response - so the visitor sees a sentence
    // rather than an empty bubble.
    const ipCheck = chatIpLimiter(`${agencyId}:${clientIp(req)}`);
    if (!ipCheck.ok) {
      res.set('Retry-After', String(ipCheck.retryAfter));
      return res.status(429).json({
        reply: `That's a lot of messages in a short time. Give it a minute and try again — or call us at ${config.phone} and we'll pick up where you left off.`,
        urgent: false, showLeadForm: false,
      });
    }

    const dayCheck = chatDayLimiter(`day:${agencyId}`);
    if (!dayCheck.ok) {
      res.set('Retry-After', String(dayCheck.retryAfter));
      return res.status(429).json({
        reply: `The assistant is unavailable right now. Please call us at ${config.phone} — someone can help you directly.`,
        urgent: false, showLeadForm: false,
      });
    }

    // A 100kb body is still a very large prompt to pay for. Real questions are
    // short; anything longer is either a paste accident or someone probing.
    const trimmedMessage = message.slice(0, MAX_MESSAGE_CHARS);

    const priorTurns = (Array.isArray(history) ? history : [])
      .slice(-MAX_HISTORY_TURNS)
      .filter((t) => t && typeof t.content === 'string')
      .map((t) => ({ ...t, content: t.content.slice(0, MAX_MESSAGE_CHARS) }));
    const messages = [
      ...priorTurns.map((turn) => ({
        role: turn.role === 'assistant' ? 'assistant' : 'user',
        content: turn.content,
      })),
      { role: 'user', content: trimmedMessage },
    ];

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        // 300 was sized for {reply, urgent, showLeadForm}. Agencies capturing
        // conversationally also return a lead object, and if the response is
        // cut mid-JSON the parse fails and the visitor gets the fallback text
        // instead of the actual reply. This is a ceiling, not a target - short
        // replies still cost what they cost.
        max_tokens: 600,
        system: buildSystemPrompt(config),
        messages,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', response.status, errText);
      noteChatResult(false, `${response.status} ${errText}`);
      return res.status(502).json({ error: 'Chat service unavailable' });
    }
    noteChatResult(true);

    const data = await response.json();
    const textBlock = (data.content || []).find((b) => b.type === 'text');
    const raw = (textBlock && textBlock.text) || '';

    let parsed;
    try {
      const cleaned = raw.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      // Model sometimes adds conversational text before/after the JSON object
      // despite instructions. Try to pull just the JSON object out of the
      // raw text before giving up - this avoids showing the visitor a
      // duplicated reply-plus-raw-JSON mess.
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start !== -1 && end > start) {
        try {
          parsed = JSON.parse(raw.slice(start, end + 1));
        } catch (e2) {
          parsed = null;
        }
      }
      if (!parsed) {
        // Last resort: use whatever text came before any JSON-looking
        // content (usually the model's intended reply), or the whole raw
        // text if no JSON was found at all.
        const fallbackText = start !== -1 ? raw.slice(0, start).trim() : raw.trim();
        parsed = { reply: fallbackText || "Sorry, could you rephrase that?", urgent: false, showLeadForm: false };
      }
    }

    // firstMessage is only stored on the opening turn, so the report shows
    // what people came in asking rather than every line they typed. Redacted
    // with the same filter as transcripts.
    recordEvent(agencyId, {
      type: 'chat',
      sessionId: typeof req.body.sessionId === 'string' ? req.body.sessionId.slice(0, 64) : null,
      ref: sanitizeRef(req.body.ref),
      firstMessage: priorTurns.length === 0 ? redactSensitive(trimmedMessage).slice(0, 200) : undefined,
    });

    res.json({
      reply: parsed.reply || "Sorry, could you rephrase that?",
      urgent: Boolean(parsed.urgent),
      showLeadForm: Boolean(parsed.showLeadForm),
      // Present only for agencies capturing conversationally. Agencies on the
      // default prompt never emit it, so this stays undefined and the widget
      // keeps using the form exactly as before.
      lead: sanitizeLead(parsed.lead),
    });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// --- Lead capture endpoint ---
// The local copy is a convenience, NOT a safety net. Render's filesystem is
// ephemeral unless a disk is mounted, so anything written here is erased on
// every deploy and restart. Point LEADS_DIR at a mounted disk to make it
// durable; until then, the email IS the record, which is why a failed send is
// now reported honestly instead of being swallowed.
const LEADS_DIR = process.env.LEADS_DIR || path.join(__dirname, 'leads');
try {
  if (!fs.existsSync(LEADS_DIR)) fs.mkdirSync(LEADS_DIR, { recursive: true });
} catch (err) {
  console.warn(`Cannot create ${LEADS_DIR} (${err.message}) - leads will not be written to disk.`);
}

// A second copy to an address you control, independent of the client's mailbox
// and its mail filtering. Costs nothing and means a lead is never one spam
// rule away from disappearing.
const ARCHIVE_EMAIL = process.env.ARCHIVE_EMAIL || '';

// Email is sent via Resend's HTTP API, not SMTP. Render's free tier (and many
// other hosts) blocks outbound SMTP ports entirely, which is invisible until
// you actually try to send - the HTTP API travels over normal HTTPS instead,
// so it isn't affected. Reuses the same SMTP_PASS/SMTP_FROM_EMAIL/SMTP_FROM_NAME
// env vars that were already set up for SMTP - SMTP_PASS is your Resend API
// key either way, so no Render changes are needed to pick this up.
const RESEND_API_KEY = process.env.SMTP_PASS;
const EMAIL_FROM = process.env.SMTP_FROM_EMAIL;
const EMAIL_FROM_NAME = process.env.SMTP_FROM_NAME || 'AI Front Desk';

if (RESEND_API_KEY && EMAIL_FROM) {
  console.log(`Email sending configured via Resend API, from ${EMAIL_FROM}`);
} else {
  console.log('Email sending NOT configured - missing SMTP_PASS (Resend API key) or SMTP_FROM_EMAIL. Leads will save to disk only, no email will be sent.');
}

// --- Transcript handling ---------------------------------------------------
// The agent needs the whole conversation, not just the four form fields -
// what the visitor actually asked is usually more useful than their name.

const MAX_TRANSCRIPT_TURNS = 60;
const MAX_TURN_CHARS = 2000;

// The assistant is instructed never to collect an SSN or card number, but it
// can't stop a visitor from typing one anyway - and the transcript would then
// carry it into a plaintext email. Two narrow patterns only: SSN-with-dashes
// and 13-19 digit card runs. A 10-digit phone number can't match either.
// Delete this and its two call sites if you'd rather have verbatim copy.
function redactSensitive(text) {
  return String(text)
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[redacted]')
    .replace(/\b\d(?:[ -]?\d){12,18}\b/g, '[redacted]');
}

// Campaign tag from a ?a=<slug> demo link. The widget already filters this,
// but the widget runs on someone else's machine, so the filter that counts is
// this one: anything that reaches an event file can be rendered in a report,
// and a request can be made with curl. Returns undefined rather than an empty
// string so JSON.stringify drops the key for untagged traffic.
function sanitizeRef(value) {
  if (typeof value !== 'string') return undefined;
  const clean = value.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
  return clean || undefined;
}

function normalizeTranscript(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t) => t && typeof t.content === 'string' && t.content.trim())
    .slice(-MAX_TRANSCRIPT_TURNS)
    .map((t) => ({
      role: t.role === 'assistant' ? 'assistant' : 'visitor',
      content: redactSensitive(t.content).slice(0, MAX_TURN_CHARS),
    }));
}

function renderTranscript(turns) {
  if (!turns.length) return '(no transcript captured)';
  return turns
    .map((t) => `${t.role === 'assistant' ? 'Assistant' : 'Visitor'}: ${t.content}`)
    .join('\n\n');
}

async function sendLeadEmail(config, lead) {
  const subject = lead.urgent
    ? `⚠️ URGENT lead from your website: ${lead.name}`
    : `New website lead: ${lead.name}`;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: `${EMAIL_FROM_NAME} <${EMAIL_FROM}>`,
      to: config.notifyEmail,
      ...(ARCHIVE_EMAIL ? { bcc: ARCHIVE_EMAIL } : {}),
      subject,
      text: [
        `New lead from the ${config.businessName} website chat assistant.`,
        ``,
        `Name: ${lead.name}`,
        `Phone: ${lead.phone}`,
        `Email: ${lead.email || '(not given)'}`,
        `Reason for contact: ${lead.notes || '(not given)'}`,
        `Urgent: ${lead.urgent ? 'YES' : 'No'}`,
        `Time: ${lead.timestamp}`,
        ...(lead.ref ? [`Came from: ${lead.ref}`] : []),
        ...(lead.consentNote
          ? [
              ``,
              `Notice shown to this visitor${lead.consentShown ? '' : ' (widget did not confirm display)'}:`,
              `  "${lead.consentNote}"`,
            ]
          : []),
        ``,
        `--- Full transcript ---`,
        ``,
        renderTranscript(lead.transcript || []),
      ].join('\n'),
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Resend API error: ${response.status} ${errText}`);
  }

  // A 200 here means Resend ACCEPTED the message, not that anyone received it.
  // Delivery happens afterwards and can still bounce - a mailbox that does not
  // exist, an unverified sending domain, a receiving server that rejects it.
  // Return the id so the log line can point at the Resend dashboard entry,
  // which is the only place the real delivery status lives.
  const body = await response.json().catch(() => ({}));
  return body.id || null;
}

app.post('/api/lead', async (req, res) => {
  try {
    const { agencyId, name, phone, email, notes, urgent, transcript } = req.body || {};
    const config = loadAgencyConfig(agencyId);
    if (!config) return res.status(404).json({ error: 'Unknown agency' });
    if (!name || !phone) {
      return res.status(400).json({ error: 'Name and phone are required' });
    }

    // Unthrottled, this endpoint mails a paying client's inbox on demand.
    const leadCheck = leadIpLimiter(clientIp(req));
    if (!leadCheck.ok) {
      res.set('Retry-After', String(leadCheck.retryAfter));
      return res.status(429).json({ ok: false, error: 'Too many submissions' });
    }

    const lead = {
      timestamp: new Date().toISOString(),
      name,
      phone,
      email: email || '',
      notes: redactSensitive(notes || ''),
      urgent: Boolean(urgent),
      transcript: normalizeTranscript(transcript),
      // The evidentiary half. The text comes from the agency's config rather
      // than from the request, so a client cannot be handed a record of a
      // notice the server never served. consentShown is the widget confirming
      // it actually rendered - it is a client-side claim, so it is reported as
      // one rather than presented as proof.
      consentNote: config.consentNote || '',
      consentShown: req.body.consentShown === true,
      // Which outreach brought them, when the demo link was tagged. Only ever
      // set on the sales demo - a real agency's visitors arrive untagged and
      // this stays undefined, so nothing changes in their notification.
      ref: sanitizeRef(req.body.ref),
    };

    // Best-effort local copy. See the LEADS_DIR note above: on an unmounted
    // Render filesystem this does not survive a restart, so it is not a reason
    // to treat a failed email as harmless.
    let savedToDisk = false;
    try {
      fs.appendFileSync(path.join(LEADS_DIR, `${agencyId}.jsonl`), JSON.stringify(lead) + '\n');
      savedToDisk = true;
    } catch (err) {
      console.error(`Could not write lead to disk for ${agencyId}: ${err.message}`);
    }

    let emailed = false;
    if (RESEND_API_KEY && EMAIL_FROM && config.notifyEmail) {
      // One retry. Most Resend failures are transient; a second attempt costs
      // a second and turns a lost lead into a delivered one.
      for (let attempt = 1; attempt <= 2 && !emailed; attempt++) {
        try {
          const messageId = await sendLeadEmail(config, lead);
          emailed = true;
          console.log(
            `Lead email ACCEPTED BY RESEND for ${agencyId} -> ${config.notifyEmail} ` +
            `(id: ${messageId || 'unknown'}, attempt ${attempt}). This is NOT proof of ` +
            `delivery - check the Resend dashboard for this id to see whether it was ` +
            `delivered or bounced.`
          );
        } catch (err) {
          console.error(`Lead email attempt ${attempt} failed for ${agencyId}: ${err.message}`);
          if (attempt === 1) await new Promise((r) => setTimeout(r, 1000));
        }
      }
    } else {
      console.log(`Lead email SKIPPED for ${agencyId} - email configured: ${Boolean(RESEND_API_KEY && EMAIL_FROM)}, notifyEmail set: ${Boolean(config.notifyEmail)}`);
    }

    if (!emailed) {
      // Do not tell the visitor someone will call them back when nothing left
      // the building. The widget uses this to hand them the phone number
      // instead, which turns a silently lost lead into a phone call.
      console.error(
        `LEAD NOT DELIVERED for ${agencyId}: ${lead.name} / ${lead.phone} ` +
        `(saved to disk: ${savedToDisk}). Recover it from the log line above.`
      );
      return res.json({ ok: false, emailFailed: true, phone: config.phone || '' });
    }

    recordEvent(agencyId, {
      type: 'lead',
      sessionId: typeof req.body.sessionId === 'string' ? req.body.sessionId.slice(0, 64) : null,
      ref: sanitizeRef(req.body.ref),
      urgent: Boolean(urgent),
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('Lead capture error:', err);
    res.json({ ok: false, emailFailed: true });
  }
});

// --- Usage reporting -------------------------------------------------------
// At $200/mo the first renewal question is "what did this actually do for me",
// and until now the only answer was forwarded emails.
//
// Same durability caveat as leads: this is an append-only file, and Render
// wipes the filesystem on deploy unless a disk is mounted. Point STATS_DIR at
// one to keep history across deploys. Losing stats is an annoyance rather than
// a lost customer, which is why it is acceptable here and was not for leads.

const STATS_DIR = process.env.STATS_DIR || LEADS_DIR;

function recordEvent(agencyId, event) {
  if (!/^[a-z0-9-]+$/i.test(agencyId || '')) return;
  try {
    fs.appendFileSync(
      path.join(STATS_DIR, `${agencyId}.events.jsonl`),
      JSON.stringify({ t: new Date().toISOString(), ...event }) + '\n'
    );
  } catch (err) {
    // Reporting must never break the thing being reported on.
    console.warn(`Could not record ${event.type} event for ${agencyId}: ${err.message}`);
  }
}

function readEvents(agencyId, sinceMs) {
  const file = path.join(STATS_DIR, `${agencyId}.events.jsonl`);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (Date.parse(ev.t) >= sinceMs) out.push(ev);
    } catch (e) { /* skip a torn line rather than fail the whole report */ }
  }
  return out;
}

function summarise(events) {
  const sessions = new Set();
  const leadSessions = new Set();
  const urgentSessions = new Set();
  const byDay = {};
  const questions = [];
  let messages = 0;

  // Outreach attribution. Empty for every real agency - only a tagged demo
  // link produces a ref - so the report renders this section or not depending
  // on whether there is anything in it.
  const byRef = {};
  const refSessions = new Set();
  const refLeadSessions = new Set();
  function noteRef(ref, day) {
    if (!byRef[ref]) byRef[ref] = { conversations: 0, leads: 0, first: day, last: day };
    if (day < byRef[ref].first) byRef[ref].first = day;
    if (day > byRef[ref].last) byRef[ref].last = day;
    return byRef[ref];
  }

  // A lead is counted once per conversation, the same way a conversation is
  // counted once per session. Counting raw events instead would let one visitor
  // submitting twice inflate a number a paying client reads as new business.
  // Events without a sessionId (older records) fall back to their timestamp.
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const day = String(ev.t).slice(0, 10);
    byDay[day] = byDay[day] || { conversations: 0, leads: 0 };
    const key = ev.sessionId || `${ev.t}#${i}`;

    if (ev.type === 'chat') {
      messages += 1;
      if (!sessions.has(key)) {
        sessions.add(key);
        byDay[day].conversations += 1;
      }
      if (ev.ref && !refSessions.has(ev.ref + '|' + key)) {
        refSessions.add(ev.ref + '|' + key);
        noteRef(ev.ref, day).conversations += 1;
      }
      if (ev.firstMessage) questions.push({ t: ev.t, text: ev.firstMessage, ref: ev.ref });
    } else if (ev.type === 'lead') {
      if (!leadSessions.has(key)) {
        leadSessions.add(key);
        byDay[day].leads += 1;
      }
      if (ev.ref && !refLeadSessions.has(ev.ref + '|' + key)) {
        refLeadSessions.add(ev.ref + '|' + key);
        noteRef(ev.ref, day).leads += 1;
      }
      if (ev.urgent) urgentSessions.add(key);
    }
  }

  const conversations = sessions.size;
  const leads = leadSessions.size;
  const urgentLeads = urgentSessions.size;
  return {
    conversations,
    messages,
    leads,
    urgentLeads,
    // What proportion of conversations produced someone the agency can call.
    // The number an agency owner actually cares about.
    leadRate: conversations ? Math.round((leads / conversations) * 100) : 0,
    byDay,
    byRef,
    recentQuestions: questions.slice(-40).reverse(),
  };
}

// Token-gated, and opt-in: an agency without reportToken in its config has no
// reporting endpoint at all, so this cannot leak a config that never asked for
// it. The token goes in the query string, which means it can appear in server
// logs and referrer headers - fine for usage counts, not for anything else.
app.get('/api/stats', (req, res) => {
  const { agencyId, token } = req.query;
  const config = loadAgencyConfig(agencyId);
  if (!config || !config.reportToken) return res.status(404).json({ error: 'Not found' });
  if (token !== config.reportToken) return res.status(403).json({ error: 'Forbidden' });

  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
  const since = Date.now() - days * 24 * 60 * 60 * 1000;

  res.json({
    agency: config.businessName,
    days,
    generatedAt: new Date().toISOString(),
    ...summarise(readEvents(agencyId, since)),
  });
});

app.get('/report', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'report', 'report.html'));
});

// --- Health ----------------------------------------------------------------
// The old /health returned {"status":"ok"} unconditionally. It said ok for the
// entire period the Anthropic balance was empty and every single chat was
// failing, which is worse than having no health check at all - it actively
// reassured while the product was down.
//
// The signal now comes from real traffic: every /api/chat call records whether
// Anthropic actually answered. If nothing has exercised the chat path recently,
// /health does one minimal probe itself, at most once every PROBE_MIN_GAP_MS,
// so an external monitor polling every few minutes costs almost nothing.

const chatHealth = { ok: null, at: null, error: null };
const PROBE_MIN_GAP_MS = 30 * 60 * 1000;
const STALE_MS = 30 * 60 * 1000;
let lastProbeAt = 0;

function noteChatResult(ok, error) {
  chatHealth.ok = ok;
  chatHealth.at = new Date().toISOString();
  chatHealth.error = ok ? null : String(error || '').slice(0, 200);
}

async function probeChat() {
  lastProbeAt = Date.now();
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    if (!r.ok) {
      const body = await r.text();
      noteChatResult(false, `${r.status} ${body}`);
    } else {
      noteChatResult(true);
    }
  } catch (err) {
    noteChatResult(false, err.message);
  }
}

app.get('/health', async (req, res) => {
  const checks = {
    configsLoadable: false,
    anthropicKeySet: Boolean(process.env.ANTHROPIC_API_KEY),
    emailConfigured: Boolean(RESEND_API_KEY && EMAIL_FROM),
  };

  try {
    checks.configsLoadable = fs.readdirSync(CONFIG_DIR).some((f) => f.endsWith('.json'));
  } catch (err) { /* stays false */ }

  const stale = !chatHealth.at || Date.now() - Date.parse(chatHealth.at) > STALE_MS;
  if (stale && checks.anthropicKeySet && Date.now() - lastProbeAt > PROBE_MIN_GAP_MS) {
    await probeChat();
  }

  // Email being unconfigured is a warning, not an outage - leads still save and
  // the failure is now reported to the visitor. A dead chat path is an outage.
  const healthy = checks.configsLoadable && checks.anthropicKeySet && chatHealth.ok !== false;

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    checks,
    chat: {
      ok: chatHealth.ok,
      lastCheckedAt: chatHealth.at,
      error: chatHealth.error,
    },
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AI Front Desk server running on port ${PORT}`));
