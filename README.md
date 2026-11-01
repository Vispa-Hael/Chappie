# Chappie

Share music already playing on your Windows PC with friends in a Discord voice channel.

**Chappie Companion** is the desktop app for people who want to share their audio. The **Chappie host** runs the Discord bot centrally. Friends never need the bot token or developer tools.

## Download and connect

1. Download the Windows installer from [GitHub Releases](https://github.com/Vispa-Hael/Chappie/releases).
2. Install [VB-CABLE](https://vb-audio.com/Cable/) once if the app reports the driver is missing. This driver comes from its original author and is not bundled.
3. Open Chappie Companion and enter the HTTPS host address supplied by your Chappie host owner.
4. Click Pair. In a server where Chappie is installed, use `/pair CODE` with the code shown in your own app.
5. Join voice, select your music browser/app under Setup, and switch On. Off disconnects your session and returns the selected app to normal headphones/speakers.

Only one person shares at a time in each server. Other paired users can request a turn; the active sharer can hand over. Different servers have independent sessions. The host PC and app must stay running. If connected to multiple servers, select the intended server in Setup.

The initial preview supports Windows 10/11 x64 with VB-CABLE. A host address is required; the installer alone is not a public relay service. A temporary tunnel address may change when its host restarts. Bluetooth call-mode limitations can still affect how Discord sounds on phones and car systems.

## Host Chappie

Read [Host setup](docs/REMOTE_HOST.md) for HTTPS, pairing, and access rules. The local-only control panel is preserved; see [Local setup](docs/LOCAL_SETUP.md).

Your private `.env` belongs only on the host. Copy `.env.example`, fill in the Discord bot token/application/server/owner IDs, install dependencies, register slash commands, and run:

```powershell
npm ci
npm run register
npm start
```

The owner panel listens on `127.0.0.1:37841`. The companion relay listens on `127.0.0.1:37842`; publish **only the relay port** through an HTTPS/WSS reverse proxy. The owner panel must remain local. Companions reject insecure public host URLs.

## Development

```powershell
npm ci
npm ci --prefix companion
npm run typecheck
npm test
npm run companion:dist
node scripts/audit-release.mjs
```

The NSIS installer is written to `companion/dist`. Packaging uses an explicit allowlist and excludes host configuration, `.env`, logs, device tokens, and runtime state. GitHub Actions tests/builds on Windows; tag `v1.1.0` or run the workflow manually to publish the preview installer and checksum.

Pairing requires proof from both the desktop request and an authenticated Discord interaction. Device tokens are random and hash-only on the host; desktop storage uses Windows-protected encryption. `/unpair` revokes your devices. Audio is streamed in memory, not saved or transcribed. See [third-party notices](THIRD_PARTY.md).
