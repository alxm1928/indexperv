# Pervent Client — licensing setup

This package contains the rebranded Electron client plus a separate license API and Discord bot.

## 1. Install dependencies

Open PowerShell in this folder:

```powershell
npm install
```

## 2. Configure the license API

Create your own long random admin secret. Then set:

```powershell
$env:PERVENT_ADMIN_SECRET="YOUR_LONG_RANDOM_SECRET"
$env:PERVENT_PORT="38473"
npm run license-server
```

The API stores its database in `license-data/database.json`.

> Environment variable names are case-sensitive in some shells. The actual names used by the app are `PERVENT_ADMIN_SECRET`, `PERVENT_PORT`, `PERVENT_HOST`, and `PERVENT_LICENSE_URL`.

## 3. Configure the client API URL

Edit:

`electron/license-config.json`

Set `apiBase` to the URL reachable by your customers. For a local-only test, leave it as:

`http://127.0.0.1:38473`

For real customers, host the API behind HTTPS and put that HTTPS URL here.

## 4. Configure the Discord bot

Set these environment variables before starting the bot:

```powershell
$env:DISCORD_BOT_TOKEN="YOUR_BOT_TOKEN"
$env:DISCORD_CLIENT_ID="YOUR_APPLICATION_ID"
$env:DISCORD_GUILD_ID="YOUR_SERVER_ID"
$env:PERVENT_ADMIN_SECRET="THE_SAME_SECRET_AS_THE_API"
$env:PERVENT_LICENSE_URL="YOUR_PUBLIC_API_URL"
```

Then run:

```powershell
npm run discord-bot
```

The bot registers:

- `/key create`
- `/key revoke`
- `/key ban`
- `/hwid pending`
- `/hwid approve`
- `/hwid reject`
- `/licenses`

## 5. Build the Windows installer

```powershell
npm run build
```

The Windows installer is created under `dist/`.

## HWID flow

1. A customer activates a valid key.
2. The API binds the license to the first device hash.
3. The client periodically validates its session.
4. The customer can submit an HWID reset request with a reason.
5. You review the request in Discord.
6. Approving the request clears the stored HWID, allowing the next activation to register the new device.
7. Revoking or banning the license causes subsequent validation to fail.

The client never contains the Discord bot token. Only the separate bot process has administrative credentials.

Discord invite used by the UI:

`https://discord.gg/perventversion2`
