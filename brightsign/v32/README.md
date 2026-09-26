# ScreenFleet BrightSign package v32

One `autorun.zip` for every BrightSign player. Nothing in it is tied to an asset. On first boot a new player shows an activation code and QR code (like BSN.cloud). After it's claimed in ScreenFleet, it reboots into play mode.

**Install URL** (BrightAuthor:connected → Player Settings → Publishing Mode → **App URL**, and the URL for the Partner Gallery):

    https://files.screenfleet.io/brightsign/v32/autorun.zip

This folder is separate from the v31b files in `brightsign/`. The CMS package generator still uses those, so merging this changes nothing for players already in the field.

## Offline behaviour (same idea as BSN.cloud)

- Every file any schedule can play is downloaded to the player's card (`media/`), including images and videos inside canvas creatives.
- New content switches over only after **all** of its files are on the card. A half-finished download never replaces what's playing.
- The full schedule (every scheduled playlist with its days, times and priority) is saved in `sf-manifest.json`. The player decides locally, in the asset's time zone, which playlist is on. Schedules therefore keep working after a reboot with no internet.
- Files no longer used by any schedule are deleted, so the card doesn't fill up.
- Internet is only needed to check for changes (every 60 s) and to send the heartbeat (every 60 s).

## HDMI in

This follows BrightSign's own sample (Sergio Rodriguez, ticket #486879, tested on OS 9.1.132 Series 4/5):
- `<video>` with `tv:brightsign.biz/hdmi`, **autoplay + muted**, unmuted 100 ms after `canplay`
- `roVideoMode` + message port → `roHdmiInputChanged` → `reloadHdmiIn()` in the page

## Files

| File | What it does |
|---|---|
| autozip.brs | BrightSign's standard unpacker (unchanged sample from BrightSign) |
| autorun.brs | Boot, activation, downloads, schedule manifest, heartbeat, HDMI events |
| index.html / player.js | Renders zones, runs schedules, HDMI |
| activate.html | Activation code + QR |
| sw.js | Only used in hosted/URL mode |

There's no `config.json` in the zip. A player without one shows the activation code. A player that already has one keeps it when the package is reinstalled.

Set `"debug": true` in a player's `config.json` to turn on the web inspector (port 2999).

## Build

    bash brightsign/v32/build.sh
