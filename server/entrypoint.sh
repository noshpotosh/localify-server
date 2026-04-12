#!/bin/sh
set -e
mkdir -p "${MEDIA_DIR:-/data/media}"
node src/migrate.js
exec node src/server.js
