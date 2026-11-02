# Local host and desktop audio relay setup

## One-switch interface

The music-app dropdown remains available while sharing. Choosing a different app first stops/restores the previous app, then routes the new app and rejoins your current voice channel. This briefly interrupts music. Device refresh reports completion, and background polling preserves unchanged dropdown options. The private-output picker is changed while Chappie is off.

Double-click **Start Chappie Panel.cmd** in this folder. It opens the local control panel at http://127.0.0.1:37841 and starts the bot in the background if necessary. Join one Discord voice channel, then click the big switch. **On** routes the selected music app to VB-CABLE, joins your channel, and starts broadcasting. **Off** stops/disconnects Chappie in all servers and routes that app back to your normal Windows output (or the private device chosen under Setup). No slash command or Windows audio settings are needed for this workflow. Chrome is selected automatically when available; use Setup once for a different app or headphones. Start playing audio and refresh if your app is missing. Closing the web page does not turn sharing off. The program stays available for the next switch-on.

The Windows system output and Discord output are left alone. The private destination defaults to your normal Windows output; if you previously manually pinned the music app to a different device, choose that device under Setup. If Windows does not move an existing stream immediately, pause and resume it. The panel only controls the selected app: other apps manually routed to the virtual cable can also be heard while the bot broadcasts. Separate browser tabs share an app audio route. Use a dedicated music browser if needed.

The panel joins the configured owner's current voice channel. If the owner is connected to more than one server, leave the extra voice connections first. Panel Off stops all broadcasts; slash commands still support independent per-server sessions. Failed starts attempt to restore private routing; a pending recovery record allows Off to retry after a crash. If an app has closed, reopen it to restore its route. If your default Windows output is itself a cable, choose real headphones under Setup.

This control panel runs only on your PC. Controls are bound to loopback with a per-run request key; the Discord bot token is never sent to the browser. Logs from background startup are in `.logs`. Routing uses the bundled freeware NirSoft SoundVolumeCommandLine utility; see THIRD_PARTY.md. The original terminal launcher remains available for development. Avoid launching two bot instances.

Both ducking fades use smooth S-shaped easing curves, softening the start and end while retaining the 0.5-second fade down and 2-second rise.

Broadcast music already playing in a Windows app or browser into a Discord server voice channel. This is a local audio relay: you choose and control music in your player. It does not fetch song links or manage playlists. Your PC and this bot must remain running.

The relay captures 48 kHz stereo PCM and explicitly encodes at 128 kbps Opus. The quality regression test verifies 60 Hz bass and independent stereo channels through encoding and decoding. This checks the local codec path, not Discord client playback or Bluetooth quality.

Music automatically fades down over **0.5 seconds** to **50% of your configured volume** while a human microphone is transmitting in the bot's voice channel. If any one person speaks continuously for **five seconds**, it smoothly dips further to **25%** over another 0.5 seconds. Duration is tracked per person, with a 250 ms activity grace period; separate short speakers do not accumulate toward the threshold. After speech stops and the activity tail expires, it rises smoothly back to normal over **two seconds**. Short utterances fade back up from the current level without completing an unnecessary drop. Overlapping speakers keep it dimmed; new speech smoothly reverses the rise. `/volume` still sets the normal level independently per server. The bot joins undeafened to detect incoming microphone activity; it only reads source flags and RTP headers, and does not decode, store, or transcribe incoming speech. Screen-share/video soundshare sources, mixed or unclassified sources, and other bots do not trigger ducking. Audio played through someone's microphone is still microphone activity; Discord cannot identify it as a separate video stream. Local behavior and source classification are tested; confirm live mic and screen-share behavior in your server.

## 1. Install and route a virtual audio cable

Install **VB-CABLE** from the official site: https://vb-audio.com/Cable/ . The driver installer requires administrator access and may require a restart. No driver is installed by this project.

The two endpoint names are easy to mix up:

| Purpose | Windows endpoint |
| --- | --- |
| Music app plays audio INTO the cable | **CABLE Input** (playback/output) |
| Bot captures audio FROM the cable | **CABLE Output** (recording/input) |

1. Start your browser or music app playing something.
2. In Windows 11, open **Settings → System → Sound → Volume mixer**. Under your music app, choose **CABLE Input** as the output device. On Windows 10 use **App volume and device preferences**. You may need to restart the app after changing its output.
3. Keep Discord's output on your headphones or speakers. Keep your ordinary microphone selected in Discord. Do not route Discord into the cable, which would feed your friends' voices back to them.
4. Once broadcasting, you hear the bot through Discord like your friends do. For an optional local preview before starting the bot: run `mmsys.cpl`, open **Recording → CABLE Output → Properties → Listen**, enable **Listen to this device**, and select your headphones as the playback device. Apply. Disable this monitoring while listening through the bot to avoid hearing music twice.

Use headphones to prevent speaker audio reaching your physical microphone. Routing a browser sends audio from all tabs in that browser; use a separate browser for music if needed. Windows can also expose **Stereo Mix**, but that often captures Discord and system sounds too, so a dedicated cable is recommended.

## 2. Create your Discord bot

1. Open https://discord.com/developers/applications and create a **new application** dedicated to this relay.
2. Under **Bot**, create/reset the bot token. Store it only in your local `.env` file. Treat it like a password. Leave privileged intents disabled; this bot does not need them.
3. Under **General Information**, copy the **Application ID** as `DISCORD_CLIENT_ID`.
4. In Discord **User Settings → Advanced**, enable **Developer Mode**. Right-click your server to copy its ID as `DISCORD_GUILD_ID`; right-click your own profile to copy your user ID as `BOT_OWNER_ID`.
5. In the Developer Portal's OAuth2 URL Generator, select **bot** and **applications.commands**. Choose **View Channels**, **Connect**, and **Speak** permissions. Open the generated invitation URL and add it to your server. Administrator permission is unnecessary. Server/channel overrides must also permit the bot to connect and speak.

This supports regular server voice channels across multiple servers, not group DMs or Stage channels. Only the configured owner can control the bot, and voice controls require being in the bot's channel. The bot never starts capture automatically on startup or /join.

## 3. Configure locally

Use Node.js **22.12 or newer**. Node 24 is installed on the development machine. From PowerShell:

```powershell
Set-Location 'F:\Discord Bot'
npm install
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
npm run devices
notepad .env
```

Fill in the four Discord values. Set `AUDIO_DEVICE` to the **exact recording device name** printed by `npm run devices` (typically `CABLE Output (VB-Audio Virtual Cable)`). Keep quotes around the name. Do not use CABLE Input here. FFmpeg is bundled through npm; no global installation is needed. `FFMPEG_PATH` can override it with an absolute path to a Windows FFmpeg build supporting DirectShow.

```powershell
npm run doctor
npm run check-audio
npm run register
npm start
```

Play music during `check-audio`. It reads five seconds into memory and prints signal levels; it neither saves nor transmits the samples. `doctor` lists dependency versions, validates configuration presence, checks your recording device, and tests synthetic PCM-to-Opus encoding. It does not authenticate with Discord. `register` installs commands immediately in every server where your bot is currently invited. Run it again only when commands change.

## 4. Use it

Join a regular voice channel, then run:

| Command | Result |
| --- | --- |
| `/join` | Joins your channel without capturing audio |
| `/start` | Joins if needed, then starts broadcasting the configured input |
| `/volume percent:50` | Sets bot volume between 0 and 100 |
| `/stop` | Stops capture while staying in voice |
| `/leave` | Stops capture and disconnects |
| `/status` | Shows connection, broadcast, volume, and last failure |
| `/playpause` | Toggle play or pause in the active Windows music player |
| `/skip` | Move the active Windows music player to its next track |
| `/rewind` | Restart or move to the previous track in the active player |

Play/pause/skip tracks in your music app. To move the bot, use `/leave` in its current channel, join another channel, and use `/start`. Commands respond privately. Volume changes last until restart; edit `DEFAULT_VOLUME` for a persistent default.

The bot disconnects after 60 seconds without human members (configurable). On a dropped connection, external move, kick, or server mute it stops capture. It does not automatically restart broadcasting: unmute/rejoin and run `/start` again. Closing the terminal or pressing Ctrl+C stops it. You can also double-click `Start Bot.cmd` after configuration. The console must stay open.

## Adding another server

Send this invite to that server's owner or someone with Manage Server permission:

https://discord.com/oauth2/authorize?client_id=1566511250710597814&permissions=3146752&scope=bot%20applications.commands

They select their server and authorize Chappie. Join a regular voice channel there and use `/start`. Only your configured owner account controls the relay. Each server has its own connection, volume, stop control, and empty-channel timer. All active servers hear the same selected computer audio source; different music per server requires separate audio sources, which this version does not provide. Starting in the second server does not stop the first: use `/stop` or `/leave` in the first server when switching audiences. The bot and your PC must remain running. Each active server uses a separate capture/encoder, so additional servers use more CPU and network bandwidth.

## Troubleshooting

- **No cable device listed:** install the cable driver, restart if requested, and confirm CABLE Output is enabled in Windows recording devices. Device names may differ by language or driver version.
- **Input nearly silent:** confirm the player is playing and routed to CABLE Input; confirm the configured recording source is CABLE Output. Check Windows app/device volumes.
- **Friends hear themselves:** Discord output is reaching your cable. Route Discord to headphones and avoid Stereo Mix.
- **You cannot hear music:** check the bot's per-user volume and mute setting in your Discord client, your Discord output device, `/volume`, and the signal level from `npm run check-audio`. Your normal Discord client can hear the bot as a separate voice participant.
- **Bot responds but does not join:** verify View Channel, Connect, Speak, user limits, and network access. This does not support Stage channels.
- **Commands missing:** verify guild/application IDs, invitation scopes, and `npm run register`. Restart Discord if its command list is stale.
- **Device in use:** disable exclusive-mode access in the device's Advanced properties or close apps holding the recording device exclusively.
- **Lag or crackles:** check CPU usage and network conditions; avoid running multiple bot instances. Monitoring and Discord add latency, so this is not a synchronized listening service.

## Development and verification

```powershell
npm run typecheck
npm test
npm run doctor
```

Tests exercise capture arguments, FFmpeg process shutdown, Opus encoding, and configuration validation. Real-device capture and end-to-end Discord playback require your audio routing and Discord credentials. No login credentials or tokens are included in this project. `.env` is ignored by Git.

## References

- Discord voice library (including DAVE support): https://github.com/discordjs/discord.js/tree/main/packages/voice
- FFmpeg DirectShow input: https://ffmpeg.org/ffmpeg-devices.html#dshow
- Official VB-CABLE manual: https://vb-audio.com/Cable/VBCABLE_ReferenceManual.pdf
