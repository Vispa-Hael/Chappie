# Shareable Chappie implementation

## Required end state

- A Windows companion installer with the On/Off interface, selected-app audio routing, capture, and private-output restoration. No Discord bot credentials in the installer.
- One central Chappie host receives authenticated real-time audio from companions and sends it to the correct Discord voice channel.
- Pairing proves the caller's Discord identity using a short-lived code entered as `/pair CODE` in Discord. This avoids distributing OAuth client secrets or bot tokens.
- One broadcaster per server, isolated server sessions, turn requests, explicit handoff, and disconnect cleanup.
- A clean GitHub repository and GitHub Release containing the installer and checksums.
- Host runs on this PC initially. Friends require a reachable HTTPS/WSS endpoint; loopback-only transport is insufficient.

## Implementation and proof

Current verified progress (2026-11-01): companion and central relay implemented; 37 local tests pass, including actual HTTP/WebSocket PCM transport, competing claims, handoff, startup cancellation, audio restoration, and automatic turn/context updates. Windows NSIS installer built and initially installed as1.1.0 on this PC; visible startup inspected. Source and installer audits exclude private config/known host credentials. Clean repository pushed to Vispa-Hael/Chappie. GitHub Windows workflow run41365146125 passed; preview v1.1.1 published with installer and matching SHA-256 asset digest. Current main6c5cca0 includes automatic context refresh. Installer upgrade to1.1.1 was started through exec session14164; revalidate that process/result rather than restarting blindly if resumed. Host deployed locally with /pair registered and relay /health responding. Last check: companion has no saved pairing config and host has no device records. Goal remains active: user must finish real Discord pairing and choose/authorize external hosting; friend-to-host-to-Discord playback and Off/handoff still require real-device/network verification. Async questions for temporary tunnel vs existing domain and live local pairing are pending. Do not mark complete from automated tests alone. This continuation made concrete source/release progress; it is not a blocked/no-progress turn.

- `src/remote/`: central pairing/token/lease/stream service; integration tests exercise actual HTTP/WebSocket behavior.
- `companion/`: isolated desktop renderer, privileged audio/transport in main process, OS-protected device credentials, explicit allowlist for packaging.
- Existing host playback retains stereo music encoding and microphone-only ducking.
- Installer must be built, inspected for forbidden files and credentials, installed/tested on Windows, and published before the goal is complete.
- External setup still to verify: new Chappie GitHub repo, authenticated release publishing, public HTTPS endpoint, and second-machine live audio test.

## Dependency and scope notes

Latest verification: v1.1.2 rebuilt, credential audit passed, installer installed/reopened; installed app.asar reports version1.1.2 and contains scrollIntoView pairing fix. Commit b33de14 and tagv1.1.2 pushed; CI/public release may still be running and should be checked before claiming publication. Public verifier scripts/verify-public-host.mjs passed HTTPS health200/protocol1, context401, and WSS unauthenticated handshake rejection against https://pads-handling-essence-handmade.trycloudflare.com. Source includes the temporary link as new-install default; owner's existing app retains its localhost host. Pending user step is Get pairing code then /pair CODE in Discord. Pairing must be approved by the real user; no source/device token has been invented or shared. The previous blocked audit is superseded by the user's hosting authorization and this verified progress; any renewed blocked audit starts fresh.

Latest user input authorized a temporary HTTPS tunnel and reported Connect Discord did nothing. UI inspection proved a real pairing code had been generated but was below the viewport; no approved device exists yet. Correct installed profile directory is `%APPDATA%\Chappie Companion`, not the npm package name `chappie-companion`; it has localhost configured and Paired=false. Current source v1.1.2 adds code scroll/focus and clearer Get pairing code labels;38 tests pass. cloudflared first attempt terminated after local negative DNS caching; launcher now validates via DNS-over-HTTPS fallback without changing Windows DNS. New live public address https://pads-handling-essence-handmade.trycloudflare.com verified /health200 protocol1 and unauthenticated /v1/context401. .remote-host.json records the actual live process. New-install defaults now prefill that temporary test host. v1.1.2 installer/release must still be rebuilt/published/installed after defaults edit. Real Discord pairing and friend audio still need user action; do not mark full goal complete.

### Completion/blocking audit after the third goal turn

The same external setup conditions remain unresolved across three consecutive goal turns. Current authoritative check: companion configuration absent, no saved encrypted device token, no host pairing store, no public-host record; local relay health responds with protocol1. Worktree is clean. Installer v1.1.1 is published with checksum and is installed locally; 37 tests passed for the current implementation. Source, installer, identity pairing protocol, per-server leases, and handoff are implemented. Real Discord identity pairing, external HTTPS/WSS reachability, and another person's computer-to-Discord playback/restoration/handoff remain unproven. No running build/job remains that would resolve these conditions automatically. User responses to the pairing and hosting questions are required; do not impersonate their Discord account or treat elapsed time as approval for the requested tunnel choice. The goal is blocked on those inputs, not complete. Resume on user input, retaining the entire original objective.

Upgrade verification: exec session14164 completed successfully. Installed app.asar package version and automatic context-update code were checked after installation; use current verification output as evidence. Public HTTPS tunnel remains unstarted pending the user's hosting response.

Windows audio capture initially uses the existing VB-CABLE route and FFmpeg. The companion will detect a missing cable and guide installation from its official source; the cable driver is not silently redistributed or installed. SoundVolumeCommandLine's full original freeware distribution accompanies the companion, with its license. Future per-process loopback could remove the driver requirement, but is not substituted for verifying this release.

Do not include `.env`, `.remote-devices.json`, `.routing-state.json`, logs, pairing tokens, or host runtime state in source publication or installers.
