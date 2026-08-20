# Twitch Animation Test

This project serves the chest animation and listens for `!chest` in one Twitch channel. Each command runs the animation in place. Commands received while an animation is active are queued internally; the page is never reloaded.

## Setup

Install Node.js, then run:

```powershell
npm install
Copy-Item .env.example .env
```

Edit `.env` with the Twitch channel and your Twitch application Client ID:

Register the application in the Twitch developer console and configure its device authorization support. The server uses Twitch Device Code Flow at startup, prints an authorization URL and code, and polls until you approve access in Twitch. The requested chat scope is `chat:read`.

After authorization, the access and refresh tokens are saved in `twitch-token.json`. That file is Git-ignored and stays on the server. A later startup refreshes the token automatically; if Twitch authorization expires, the server prints a new authorization prompt. Never commit `.env` or `twitch-token.json`.

Start the server:

```powershell
npm start
```

Open <http://localhost:3000> in a browser. Twitch tokens stay in the Node server and are never sent to the page.
