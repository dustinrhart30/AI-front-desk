# AI Front Desk

A chat widget local businesses embed on their website. It answers questions
about their services after-hours, flags real emergencies for an immediate
phone call, and captures leads straight to the owner's inbox. Originally
built for insurance agencies, the config schema is business-agnostic —
`server/config/koveralink.json` is a working non-insurance example (an IT/AI
consulting firm).

## How it's built

```
insurance-ai-widget/
├── server/              Node.js/Express backend
│   ├── server.js         Chat API (calls Claude), lead capture, config API
│   ├── config/           One JSON file per client agency
│   ├── leads/            Leads land here as .jsonl (auto-created)
│   └── .env.example      Copy to .env and fill in your keys
├── widget/
│   └── widget.js          The single script clients paste into their site
├── demo.html              Mock agency site used for sales demos
└── docs/                  Deployment + client onboarding guides
```

**One backend serves every client.** Each agency just gets its own config
file and a copy-pasteable `<script>` tag — there's no per-client codebase to
maintain.

## Run it locally

```bash
cd server
npm install
cp .env.example .env      # then fill in ANTHROPIC_API_KEY (and SMTP creds later)
node server.js
```

Then open `demo.html` in a browser (with the server running on port 3000)
to see the widget live on the mock insurance agency demo site (the classic
example, kept for sales walk-ins). To see the KoveraLink version instead,
change `demo.html`'s `data-agency` to `koveralink`, or just visit `/demo`
with that agency's own real site once it's embedded there.

## How a chat turn works

1. Widget sends the visitor's message + short history to `POST /api/chat`.
2. Server builds a system prompt from that agency's `config/*.json` (name,
   hours, services, phone, tone) and calls Claude (Haiku — cheap and
   fast, ideal for this).
3. Claude replies with structured JSON: the chat reply, whether this is an
   urgent/emergency message, and whether to show the lead-capture form.
4. If urgent, the widget surfaces the agency's phone number immediately.
5. If the visitor submits the lead form, `POST /api/lead` saves it to disk
   and emails the agent.

## Next steps

See `docs/DEPLOYMENT.md` to put this live on the internet, and
`docs/CLIENT-ONBOARDING.md` for the exact steps to add a new paying client.
