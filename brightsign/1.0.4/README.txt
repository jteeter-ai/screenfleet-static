ScreenFleet BrightSign Player 1.0.4 — generic activation package
================================================================
Pinned copy of the package served at https://files.screenfleet.io/brightsign/autorun.zip
(Partner Gallery / App URL). Files are byte-identical to ScreenFleet player release 1.0.4
(base44/functions/_genbuild in the ScreenFleet app; SHA-256 below matches playerUpdate).

  autozip.brs   BrightSign's sample unpacker, verbatim (sha256 bcf19398…af331)
  autorun.brs   launcher 1.0.0 (rollback safety net; never updated remotely)
  server.js     1.0.4  c99213b2162f2dea6aee032ffdc6bc96d5e3ddca30d41bc15bcf2882ee5583df
  player.js     1.0.4  9d166e14507b7ebfd23fbcd9dc213c9d6dd607ebffbf68bb7de121e525ab953c
  index.html           b99c7526b67849b0db2757a77773d756c951911351af4ddaa5215faf3dc2b9e9
  sf-agent.js   1.0.4  d058dea5d67933b26a75cd7f00337418394a1b4495a71bc9430f85da3a47a079
  config.json   GENERIC: empty screenId/screenToken, activationMode true, remote updates on

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
