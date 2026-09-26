#!/usr/bin/env bash
# Builds brightsign/v32/autorun.zip — the one package every player gets.
# Run from anywhere:  bash brightsign/v32/build.sh
set -euo pipefail
cd "$(dirname "$0")"
rm -f autorun.zip
# No config.json on purpose: a player without one shows the activation code,
# and a player that already has one keeps it when the package is reinstalled.
zip -X -q autorun.zip autozip.brs autorun.brs index.html player.js activate.html sw.js
unzip -l autorun.zip
