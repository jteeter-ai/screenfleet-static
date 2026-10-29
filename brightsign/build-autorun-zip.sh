#!/bin/sh
# Rebuild the generic Partner Gallery / App URL package for a new player release.
#   ./build-autorun-zip.sh 1.0.5
# Before running: create brightsign/<version>/ containing the release's autorun.brs, server.js,
# player.js, index.html and sf-agent.js (from base44/functions/_genbuild in the ScreenFleet app,
# after build-player.mjs), plus a config.json copied from the previous version with
# "packageVersion" bumped. autozip.brs is BrightSign's sample, copied verbatim.
# NO zip password: since OS 7.0.60 the BrightSign OS unpacks a root autorun.zip itself and cannot
# open a password-protected one (Truck 121e, OS 9.1.96, Oct 29 2026: the encrypted zip was downloaded
# by the Partner App setup and never unpacked -> 3 red flashes; the same files unencrypted booted to
# the activation screen). autozip.brs (still included for older firmware) unpacks an unencrypted zip fine.
set -e
V="$1"; [ -n "$V" ] || { echo "usage: $0 <version>"; exit 1; }
cd "$(dirname "$0")/$V"
cp ../v32/autozip.brs ./autozip.brs
rm -f autorun.zip
zip -q -X autorun.zip autozip.brs autorun.brs server.js player.js index.html sf-agent.js config.json
unzip -q -t autorun.zip
cp autorun.zip ../autorun.zip
echo "brightsign/autorun.zip now = $V"
