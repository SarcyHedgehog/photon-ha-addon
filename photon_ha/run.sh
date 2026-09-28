#!/usr/bin/with-contenv bashio

set -e
cd /app
export PHOTON_HA_CONFIG=/data/bridge.config.json
exec node /app/addon-entry.mjs
