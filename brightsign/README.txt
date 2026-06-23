ScreenFleet BrightSign Package — v31b
=====================================
Asset:       Spark 714 P3.9
Screen:      Spark 714 PC
Screen ID:   6a29ba9faf330cca377be31e
Token:       8d26b92c-a0f9-46d6-925c-968a87f5efe1
Resolution:  2560x512
Serial:      Not recorded
Generated:   Tue, 23 Jun 2026 11:50:40 GMT

SETUP
-----
1. Format SD card as FAT32 (16GB+ recommended)
2. Copy ALL files from this zip to the ROOT of the SD card (not into a folder)
3. Insert SD card into BrightSign XT player and power on

FILES
-----
autorun.brs    BrightSign boot script v31b (do not rename)
autozip.brs    BSN.cloud extraction trigger (do not rename)
index.html     Local player shell (transparent body for HDMI)
player.js      Offline-first playback engine v31b
sw.js          Service worker (skipped on file://, kept for hosted mode)
config.json    Screen configuration (token + screenId pre-filled)
activate.html  Activation page for first-boot provisioning
README.txt     This file

HOW IT WORKS
------------
- Boots local index.html immediately — no network wait, splash shows
- player.js reads sf-manifest.json from SD card for offline-first playback
- HDMI Input uses tv:brightsign.biz/hdmi in a <video> element (not roVideoPlayer)
- body/containers are transparent so HDMI hardware plane shows through
- sfReloadHdmi() called on load-complete AND roHdmiInputChanged for timing safety
- Media files downloaded to sd:/media/ via roUrlTransfer.AsyncGetToFile()
- Version check every 60s — new content saves manifest and reloads

API: https://app.screenfleet.io
