ScreenFleet BrightSign Player 1.0.8 — generic activation package
================================================================
Pinned copy of the package served at https://files.screenfleet.io/brightsign/autorun.zip
(Partner Gallery / App URL). Files are byte-identical to ScreenFleet player release 1.0.8
(base44/functions/_genbuild in the ScreenFleet app; SHA-256 below matches playerUpdate).

  autozip.brs   BrightSign's sample unpacker, verbatim (sha256 bcf19398…af331)
  autorun.brs   launcher 1.0.0 (rollback safety net; never updated remotely)
  server.js     1.0.8  b1e17117f1d3e4ecb4f232b3a7e051c11a3990ac56ad07e62c5c4546cb0bc943
  player.js     1.0.8  32cc9c547e523322477ad1a8345968c5ed7e026d4059f475d0d3cd6a77ac4747
  index.html           b99c7526b67849b0db2757a77773d756c951911351af4ddaa5215faf3dc2b9e9
  sf-agent.js   1.0.8  af48ec9e403742667834f56581ed90413273f44516d6801f54e7405194ecd161
  config.json   GENERIC: empty screenId/screenToken, activationMode true, remote updates on

Changes since 1.0.4: NovaStar VX600 + VX1000 layer on/off, move/resize and input switching
written exactly like V-Can (no more 64x64 resets), VX1000 auto/manual brightness, read-only
controller diagnostics, more robust remote updates.

What a player does with it
--------------------------
1. Downloads and unpacks the zip, reboots.
2. Shows the ScreenFleet setup screen: QR code + 6-character code.
3. Customer scans the QR (opens app.screenfleet.io/activate?code=…), signs in or signs up,
   names the screen. The player picks up its screen within ~5 s and starts playing.
4. Codes stay valid while the screen is showing them; a lapsed code is replaced automatically.
5. Once claimed, the player checks for remote updates every 6 h (playerUpdate), so it stays
   current without anyone touching the card.

New release: see ../build-autorun-zip.sh
