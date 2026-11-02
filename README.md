# Chappie

Chappie shares music already playing on **your Windows PC** into the Discord voice channel you are in. It is a personal local relay: friends join the Discord channel to listen, but they do not install software, pair devices, or operate your PC.

## Use it

1. Double-click `Start Chappie Panel.cmd`.
2. Join one regular Discord voice channel from your PC, phone, or iPad.
3. Open the local panel at http://127.0.0.1:37841, choose the music browser/app and your private headphones, then switch Chappie on.
4. Turn it off in the panel to return the selected app to your private output.

The panel and bot remain on your PC only. No domain, public tunnel, companion application, pairing code, or outside host is used.

## Discord controls

Only the configured owner can control Chappie:

- `/join`, `/start`, `/stop`, `/leave`, `/status`, `/volume`
- `/playpause`, `/skip`, `/rewind` send media controls to Windows, so they can be used from Discord on an iPad or phone.

`/rewind` means the active player’s previous-track/restart action; it is not a universal timed seek.

## Setup and development

Follow [Local setup](docs/LOCAL_SETUP.md). Keep `.env` private; it contains the Discord bot token. Run `npm run register` after changing slash commands, then `npm start`.
