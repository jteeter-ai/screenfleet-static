ScreenFleet BrightSign Player — v32 (Node-native)
=================================================
This folder hosts the canonical ScreenFleet BrightSign player package,
served over HTTPS at https://files.screenfleet.io/brightsign/ .

It is the Partner Gallery / "App URL" package: a single, GENERIC
autorun.zip with NO per-asset values baked in. A player that boots this
package shows an activation code and is claimed to a screen in the
ScreenFleet CMS.

CANONICAL URLs
--------------
  https://files.screenfleet.io/brightsign/autorun.zip   <- App URL / Partner Gallery
  https://files.screenfleet.io/brightsign/v32/           <- pinned v32 (rollback-safe)
  https://files.screenfleet.io/brightsign/v31b/          <- previous version (archived)

The root autorun.zip always points at the CURRENT shipping version.
Versioned folders keep each release immutable for rollback.

WHAT IS IN autorun.zip
----------------------
A password-protected ("test") zip, built the BrightSign way (roBrightPackage
/ "Make Autorun Zip"), containing SIX files at the archive root:

  autozip.brs    BrightSign's canonical package unpacker (their sample, verbatim).
                 On boot it unpacks autorun.zip to the drive root, creates the
                 feed_cache / feedPool / brightsign-dumps working folders,
                 deletes itself + the zip, and reboots into autorun.brs.
  autorun.brs    ScreenFleet v32 launcher. Reads config.json, launches the
                 Node server (server.js) via roNodeJs, points a roHtmlWidget
                 at http://localhost:13131/, and wires roVideoMode HDMI-input
                 hotplug events to sfReloadHdmi(). OS 9.x safe — no banned APIs.
  server.js      Node 18 static server + provisioning. Serves /storage/sd on
                 port 13131 (/api/config, /api/manifest, /api/activation,
                 /api/refresh, /media/<file>). Owns device_id, activation,
                 heartbeat, and safe content/config OTA.
  player.js      Offline-first renderer. On-device schedule evaluation
                 (BrightAuthor parity), HDMI muted-autoplay + unmute-on-canplay,
                 local media cache with CDN fallback.
  index.html     Transparent shell that loads player.js from localhost.
  config.json    GENERIC activation-mode config (empty screenId/screenToken,
                 activationMode:true). First boot -> activation code.

HOW A PLAYER GETS THIS PACKAGE
------------------------------
In player setup: Player Settings -> Publishing Mode -> "App URL", enter
  https://files.screenfleet.io/brightsign/autorun.zip
The player downloads the zip, autozip.brs unpacks it, reboots, and shows an
activation code. Claim the code against the asset in ScreenFleet.

After Partner Gallery listing, "ScreenFleet" can be picked from the partner
app list instead of typing the URL.

IMPORTANT
---------
Do NOT bake a real screenToken/screenId into config.json here. This is the
GENERIC activation package. Per-screen binding happens at activation time and
is written to the SD card's config.json on the device, never in this repo.

API: https://app.screenfleet.io
Package built: v32 Node-native. autozip.brs = BrightSign sample (sha256
bcf19398c8e90d91923bcd08f32119c9c1bf0ff7f1c8dc83a63517d9304af331).
