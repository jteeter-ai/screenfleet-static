#!/bin/sh
# Rebuild the generic Partner Gallery / App URL package for a new player release.
#   ./build-autorun-zip.sh 1.0.5
# Before running: create brightsign/<version>/ containing the release's autorun.brs, server.js,
# player.js, index.html and sf-agent.js (from base44/functions/_genbuild in the ScreenFleet app,
# after build-player.mjs), plus a config.json copied from the previous version with
# "packageVersion" bumped. autozip.brs is BrightSign's sample, copied verbatim.
# The zip password "test" is the one BrightSign's autozip.brs expects.
set -e
V="$1"; [ -n "$V" ] || { echo "usage: $0 <version>"; exit 1; }
cd "$(dirname "$0")/$V"
cp ../v32/autozip.brs ./autozip.brs
rm -f autorun.zip
zip -q -X -P test autorun.zip autozip.brs autorun.brs server.js player.js index.html sf-agent.js config.json
unzip -q -P test -t autorun.zip
cp autorun.zip ../autorun.zip
echo "brightsign/autorun.zip now = $V"
