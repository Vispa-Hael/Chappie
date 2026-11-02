# Central Chappie host

## Architecture

The Discord bot, local owner panel, and remote relay run in one host process. Each server has a playback session with its own connection, volume, and microphone ducking. The relay accepts authenticated 48 kHz stereo signed-16-bit PCM over WebSocket, roughly 1.54 Mbit/s upstream per active companion before transport overhead. Queues, packet size, rate, and idle time are bounded.

The companion routes a selected app through VB-CABLE and sends the cable's audio. On stop, network failure, or handoff it releases the source and restores private output. Its credential file is encrypted with Windows safeStorage. Closing the desktop companion stops sharing and restores routing.

## Host prerequisites

- Node 22.12+ (Node 24 recommended), Windows for optional host-local capture.
- A Discord bot invited with View Channel, Connect, Speak and applications.commands. No privileged intents are needed.
- Private `.env` with `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID` (original server migration), `BOT_OWNER_ID`, and existing audio settings.
- Run `npm run register` to install `/pair`, `/unpair`, and playback commands globally.
- An HTTPS/WSS reverse proxy pointed to `http://127.0.0.1:37842`. Do not expose owner panel port37841. A stable domain is recommended; a temporary tunnel is suitable for preview testing.

Start with `npm start` or the existing local launcher. Verify `/health` on the relay through the HTTPS address before giving it to friends. Configure that address under Setup in the companion.

For a temporary test link, run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/remote-test-tunnel.ps1` on the host. This downloads a checksum-pinned official cloudflared executable, starts a hidden tunnel forwarding only the remote relay, verifies its HTTPS health, and prints the address. Run the same command with `-Stop` to close it. The saved `.remote-host.json` and tool binary are ignored by Git. This is optional test hosting, not an installed service or a stable domain. Cloudflare Quick Tunnels have no uptime guarantee and the URL can change after restart: https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/ .

## Pairing and rights

The app obtains a short-lived pairing code and a separate polling secret. The user enters `/pair CODE` in Discord. The bot links that request to the authenticated caller; the desktop proves possession of its polling secret to obtain a device token. Only enter codes displayed in your own app. `/unpair` revokes that account's devices and active shares.

A token alone does not authorize arbitrary voice playback. Each claim checks that its Discord user is currently in a regular voice channel in a server Chappie has joined. A friend's `/start` only summons the bot; it never captures the host owner's PC audio. The companion On switch starts that friend's stream.

The first claimant holds the server slot. Concurrent claims are rejected. A queued request does not interrupt playback; the active sharer explicitly hands over, reserving the slot briefly for the selected user. On disconnect, revocation, voice departure, idle input, or playback failure the lease is released. Other servers continue independently.

The host owner can stop remote sessions through Discord. The local browser panel controls host-originated broadcasts and does not interrupt friends in other servers. Device hashes live in ignored `.remote-devices.json`; back it up privately to preserve pairing across reinstalls. Never publish runtime state.

## Deployment verification

Public readiness requires installed configuration, Discord connection, HTTPS health, actual account pairing, capture from another computer/network, voice playback, Off restoration, contention, and handoff. Automated transport tests alone do not establish external reachability.
