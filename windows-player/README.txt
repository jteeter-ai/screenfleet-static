ScreenFleet Player for Windows - update feed.

Installed players (1.1.0 and newer) read latest.yml here every 3 hours, download the
new installer in the background, and install it silently when the screen is idle or
between 2 and 5 AM (truck PC local time), then relaunch and resume playback.

To release a new version: bump "version" in package.json, run
  npx electron-builder --win nsis --x64 --publish never
and copy latest.yml, the Setup .exe and its .blockmap from dist/ into this folder.
Keep older .exe files only if a player might still need them; latest.yml decides.
