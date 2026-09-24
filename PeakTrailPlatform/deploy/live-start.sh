#!/bin/sh
set -eu
site_root=$(realpath /srv/peak-trail/state/current)
case "$site_root" in
    /srv/peak-trail/state/releases/*/PeakTrailPlatform/site-dist) ;;
    *) echo 'Unexpected PEAK Trail release path' >&2; exit 1 ;;
esac
exec /opt/peak-trail/node/bin/node "${site_root%/site-dist}/server/live-server.mjs" --host 127.0.0.1 --port 8787
