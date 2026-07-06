ScreenFleet BrightSign Package — v31b
=====================================
This folder hosts the canonical ScreenFleet BrightSign player files.
These are fetched by the ScreenFleet CMS at package-download time.

IMPORTANT
---------
This config.json is a BLANK TEMPLATE (empty screenToken/screenId).
- Packages downloaded from the ScreenFleet CMS Asset page get a FRESH
  config.json generated per-asset with the correct token baked in.
- This blank template is only used by the BSN.cloud / autozip.brs bootstrap
  path, where an empty token correctly triggers the QR activation flow.

Do NOT put a real screenToken in this file — it would cause every
BSN.cloud-provisioned player to attach to the wrong asset.

FILES
-----
autorun.brs    BrightSign boot script v31b (do not rename)
autozip.brs    BSN.cloud extraction trigger (do not rename)
index.html     Local player shell (transparent body for HDMI)
player.js      Offline-first playback engine v31b
sw.js          Service worker (skipped on file://, kept for hosted mode)
config.json    BLANK template — real token injected per-asset by the CMS
activate.html  Activation page for first-boot provisioning
README.txt     This file

HOW IT WORKS
------------
- Boots local index.html immediately — splash shows, no network wait
- autorun.brs reads config.json; empty token → activation, real token → play
- config injected into player.js via InjectJavascript (file:// fetch unsupported)
- HDMI Input uses tv:brightsign.biz/hdmi in a <video> element (not roVideoPlayer)
- body/containers transparent so HDMI hardware plane shows through
- Media files downloaded to sd:/media/ via roUrlTransfer.AsyncGetToFile()
- Version check every 60s — new content saves manifest and reloads

API: https://app.screenfleet.io
