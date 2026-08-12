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
  });
});

// --- Chat endpoint ---
function buildSystemPrompt(config) {
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

Respond ONLY with a single JSON object and nothing else. Do not write any greeting, explanation, or conversational text before or after it. Do not use markdown fences. Your entire response must be exactly this shape and nothing more:
{"reply": "your chat message to the visitor", "urgent": true or false, "showLeadForm": true or false}`;
}

app.post('/api/chat', async (req, res) => {
  try {
    const { agencyId, message, history } = req.body || {};
    const config = loadAgencyConfig(agencyId);
    if (!config) return res.status(404).json({ error: 'Unknown agency' });
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Missing message' });
    }

    const priorTurns = Array.isArray(history) ? history.slice(-10) : [];
    const messages = [
      ...priorTurns.map((turn) => ({
        role: turn.role === 'assistant' ? 'assistant' : 'user',
        content: turn.content,
      })),
      { role: 'user', content: message },
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
        max_tokens: 300,
        system: buildSystemPrompt(config),
        messages,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', response.status, errText);
      return res.status(502).json({ error: 'Chat service unavailable' });
    }

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

    res.json({
      reply: parsed.reply || "Sorry, could you rephrase that?",
      urgent: Boolean(parsed.urgent),
      showLeadForm: Boolean(parsed.showLeadForm),
    });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// --- Lead capture endpoint ---
const LEADS_DIR = path.join(__dirname, 'leads');
if (!fs.existsSync(LEADS_DIR)) fs.mkdirSync(LEADS_DIR);

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
      subject,
      text: `New lead from the ${config.businessName} website chat assistant.\n\nName: ${lead.name}\nPhone: ${lead.phone}\nEmail: ${lead.email}\nNotes: ${lead.notes}\nUrgent: ${lead.urgent ? 'YES' : 'No'}\nTime: ${lead.timestamp}`,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Resend API error: ${response.status} ${errText}`);
  }
}

app.post('/api/lead', async (req, res) => {
  try {
    const { agencyId, name, phone, email, notes, urgent } = req.body || {};
    const config = loadAgencyConfig(agencyId);
    if (!config) return res.status(404).json({ error: 'Unknown agency' });
    if (!name || !phone) {
      return res.status(400).json({ error: 'Name and phone are required' });
    }

    const lead = {
      timestamp: new Date().toISOString(),
      name,
      phone,
      email: email || '',
      notes: notes || '',
      urgent: Boolean(urgent),
    };

    // Always save locally first, so nothing is lost even if email fails
    const leadFile = path.join(LEADS_DIR, `${agencyId}.jsonl`);
    fs.appendFileSync(leadFile, JSON.stringify(lead) + '\n');

    if (RESEND_API_KEY && EMAIL_FROM && config.notifyEmail) {
      await sendLeadEmail(config, lead);
      console.log(`Lead email sent to ${config.notifyEmail} for ${agencyId}`);
    } else {
      console.log(`Lead email SKIPPED for ${agencyId} - email configured: ${Boolean(RESEND_API_KEY && EMAIL_FROM)}, notifyEmail set: ${Boolean(config.notifyEmail)}`);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Lead capture error:', err);
    // Lead was already saved to disk above even if email failed, so don't fail the request
    res.json({ ok: true, emailWarning: true });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AI Front Desk server running on port ${PORT}`));
