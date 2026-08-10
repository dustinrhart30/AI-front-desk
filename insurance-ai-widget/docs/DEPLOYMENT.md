# Deployment Guide

Goal: get the backend running at a permanent URL (e.g.
`https://ai-front-desk.onrender.com`) so any client's website can load
`widget.js` from it and talk to `/api/chat`.

## 1. Get an Anthropic API key

- Go to https://console.anthropic.com and create an account (separate from
  your personal Claude.ai login — this is billed per API call).
- Add a small amount of credit ($5-10 covers testing and your first several
  clients at Haiku pricing).
- Create an API key, copy it — you'll paste it into your host's environment
  variables, never into code you commit.

## 2. Push the code to GitHub

```bash
cd insurance-ai-widget
git init
git add .
git commit -m "AI Front Desk v1"
```
Create a new empty repo on GitHub and push to it. Make sure `.env` is
NOT committed (it's already in `.gitignore`) — only `.env.example` should be.

## 3. Deploy on Render (free tier to start)

1. Go to https://render.com, sign up, connect your GitHub repo.
2. Create a **New Web Service**, point it at the repo.
3. Settings:
   - Root directory: `server`
   - Build command: `npm install`
   - Start command: `node server.js`
4. Under **Environment**, add:
   - `ANTHROPIC_API_KEY` = your key from step 1
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM_NAME`
     (see the Gmail App Password note in `.env.example`)
   - `ALLOWED_ORIGINS` = leave blank until you're ready to lock it down,
     then set to a comma-separated list of your clients' website domains
5. Deploy. Render gives you a URL like `https://ai-front-desk.onrender.com`.

Render's free tier sleeps after inactivity, which means the first message
after a quiet period is slow (~30s cold start). That's fine while you're
testing with 1-3 clients. Once you have a few paying clients, upgrade to
Render's ~$7/mo starter tier so the widget responds instantly — that cost
is already covered by a single client's monthly fee.

## 4. Point the widget at your live URL

In every client's embed snippet, `data-api` should be your Render URL, e.g.:

```html
<script
  src="https://ai-front-desk.onrender.com/widget/widget.js"
  data-agency="laurel-highlands"
  data-api="https://ai-front-desk.onrender.com">
</script>
```

## 5. Your phone-ready sales demo

Once deployed, visit `https://your-app-name.onrender.com/demo` from your
phone's browser — no laptop, no local server, nothing to run. This is the
same mock agency page as `demo.html`, served directly by your backend, so
it always uses the live widget and live chat. Bookmark that URL on your
phone before your first walk-in.

## 6. Give the client the snippet

Most small agency websites are WordPress or Squarespace. Both let you paste
a script tag into a "Custom Code" / "Header/Footer scripts" section (usually
under Settings → Advanced, or a plugin like "Insert Headers and Footers" on
WordPress). This is a 5-minute job you can do for them during onboarding —
don't make them do it themselves.

## Ongoing costs to expect (your margin)

- Anthropic API (Haiku): a few cents per 100 conversations — trivial at
  small-agency volume.
- Render hosting: $0-7/mo total, shared across ALL your clients (not per
  client) since one backend serves everyone.
- Your monthly fee per client ($150-300) is almost entirely margin once
  you have more than one or two clients on the same backend.
