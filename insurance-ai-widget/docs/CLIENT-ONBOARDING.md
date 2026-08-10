# Onboarding a New Client

Repeat this for every business you sign — insurance agency, law firm, or
any other local business. Takes about 20-30 minutes end to end.

## 1. Create their config file

Copy `server/config/demo-agency.json` (or `koveralink.json` for a
non-insurance example) to `server/config/{their-id}.json` (use a short
lowercase-hyphen id, e.g. `smith-insurance`). Fill in:

- `agencyId` — must match the filename
- `businessName`, `greeting`, `tagline`
- `industry` — a short phrase describing what kind of business this is
  (e.g. "an independent insurance agency in Greensburg, PA" or "a family
  law practice serving Westmoreland County") — this frames the assistant's
  system prompt, so be specific
- `phone`, `address`, `hours`
- `services` — ask them which offerings to highlight; this replaces the
  old insurance-only `coverageLines` field
- `notifyEmail` — where leads should land
- `primaryColor`, `accentColor` — grab two hex codes from their existing
  site/logo so the widget matches their brand instead of looking bolted-on
- `urgentDescription` — a plain-English sentence describing what counts as
  urgent for THIS business (an accident for an insurance agency, a security
  breach for an IT company, a break-in for a locksmith, etc.) — this is
  what the model actually watches for, so make it concrete

## 2. Deploy the config

Commit the new config file and push — your host (Render) will redeploy
automatically. No code changes needed.

## 3. Build their embed snippet

```html
<script
  src="https://ai-front-desk.onrender.com/widget/widget.js"
  data-agency="smith-insurance"
  data-api="https://ai-front-desk.onrender.com">
</script>
```

## 4. Install it on their site

How you install it depends on how their site is built:

- **WordPress/Squarespace** — ask for temporary admin access, or a
  screen-share to walk them through it. Paste the snippet into the site's
  footer/custom-code section, save.
- **Git-based site (Netlify/Vercel/etc., like koveralink.com itself)** —
  add the script tag directly into the site's HTML source (just before
  `</body>` in the relevant template/page), commit, and push. The host's
  git integration redeploys automatically.

Load the site afterward to confirm the chat bubble appears bottom-right.

## 5. Test it live

- Ask a normal question about their services — confirm the reply sounds
  right and uses only real facts about their business.
- Trigger the urgent path using whatever you set in `urgentDescription` —
  confirm it shows their phone number prominently.
- Go through the lead form — confirm the email lands in their inbox within
  a minute or two.

## 6. Lock down CORS (once, per host, not per client)

Add their live domain to the `ALLOWED_ORIGINS` environment variable on
Render (comma-separated with any other clients already live) so only real
client websites can call your API.

## 7. Send the "you're live" note

Short email: what it does, where leads will show up, and that you'll check
in after the first week to review real conversations and tune the config
(services, tone, anything it got wrong). This check-in is also a natural
moment to mention referrals to other local businesses.
