# Chappie Companion preview

Windows desktop companion for sharing your selected music app through the centrally hosted Chappie Discord bot.

- Pair your Discord account with a short code using `/pair CODE`.
- The pairing code automatically scrolls into view, and the button explains that it must be entered in Discord.
- One On/Off switch routes music, joins your current voice channel, and restores private output when stopped.
- One active sharer per server, with request-turn and approved handoff.
- Turn requests and voice-channel availability refresh automatically.
- Song requests let friends add titles or HTTPS links; only the active sharer can accept, open, play, or decline them.
- Companion updates are checked manually, downloaded from the official GitHub release, rehashed, and installed only after a Windows confirmation.
- Recovery now restores the chosen app’s private output even when that app is closed, and clears obsolete recovery warnings after a successful refresh.
- Stereo audio, microphone-only smooth volume ducking, and recovery when the network disconnects.
- The installer contains no Discord bot token. Paired device credentials are protected with Windows encryption.

Requirements: Windows 10/11 x64, an installed VB-CABLE driver from https://vb-audio.com/Cable/ , a reachable Chappie host address, and Chappie invited to your Discord server. The current temporary test host is prefilled for new installs. Its address may change when the host restarts; the host owner can supply the new address for Setup. Only the companion app needs installing on friends' PCs; Node.js and developer tools are not required. The host PC must remain running. This preview installer is not code-signed.

Do not share your pairing code or local device credential file. Use `/unpair` to revoke your devices. Directly sharing a browser includes other audio tabs in that browser. Bluetooth call-quality limitations remain part of Discord/phone playback.
