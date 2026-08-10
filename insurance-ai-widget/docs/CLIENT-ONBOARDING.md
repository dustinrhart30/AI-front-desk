# Onboarding a New Client

Repeat this for every agency you sign. Takes about 20-30 minutes end to end.

## 1. Create their config file

Copy `server/config/demo-agency.json` to `server/config/{their-id}.json`
(use a short lowercase-hyphen id, e.g. `smith-insurance`). Fill in:

- `agencyId` — must match the filename
- `agencyName`, `greeting`, `tagline`
- `phone`, `address`, `hours`
- `coverageLines` — ask them which lines to highlight
- `notifyEmail` — where leads should land (often the owner's inbox, or a
  shared inbox you set up for this)
- `primaryColor`, `accentColor` — grab two hex codes from their existing
  site/logo so the widget matches their brand instead of looking bolted-on
- `urgentKeywords` — the defaults cover most cases; ask if they want
  anything industry-specific added

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

Ask for temporary admin access to their website (WordPress/Squarespace),
or a screen-share to walk them through pasting it themselves. Paste the
snippet in the site's footer/custom-code section, save, and load the site
to confirm the chat bubble appears bottom-right.

## 5. Test it live

- Ask a normal coverage question — confirm the reply sounds right and uses
  only real facts about their agency.
- Trigger the urgent path ("I was just in an accident") — confirm it shows
  their phone number prominently.
- Go through the lead form — confirm the email lands in their inbox within
  a minute or two.

## 6. Lock down CORS (once, per host, not per client)

Add their live domain to the `ALLOWED_ORIGINS` environment variable on
Render (comma-separated with any other clients already live) so only real
client websites can call your API.

## 7. Send the "you're live" note

Short email: what it does, where leads will show up, and that you'll check
in after the first week to review real conversations and tune the config
(coverage details, tone, anything it got wrong). This check-in is also a
natural moment to mention referrals to other local businesses.
