#!/bin/sh
# Final owner operation AFTER the exact reviewed Web release is published.
# A single interactive sudo authenticates this wrapper and both existing phases.
set -eu

die() { printf '%s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die 'Run from the server owner terminal with sudo; never send a password to chat.'
[ "$(uname -s)" = Linux ] || die 'This wrapper is for the existing Linux PEAK server.'
[ "$#" = 1 ] || die 'Usage: sudo sh enable-trajectory-service-once.sh EXACT_40_HEX_PUBLISHED_WEB_COMMIT'
expected_commit=$1
printf '%s' "$expected_commit" | grep -Eq '^[a-f0-9]{40}$' || die 'Expected the exact 40-character published Web commit'
candidate_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
installer=$candidate_dir/enable-trajectory-service.sh
node=/opt/peak-trail/node/bin/node
[ -f "$installer" ] && [ ! -L "$installer" ] || die 'Missing reviewed two-phase installer'
[ -f "$candidate_dir/trajectory-service.sha256" ] && [ ! -L "$candidate_dir/trajectory-service.sha256" ] || die 'Missing reviewed service checksums'
(cd -- "$candidate_dir" && sha256sum --check trajectory-service.sha256) || die 'Candidate checksum mismatch'

# Verify publication BEFORE prepare creates any backup or private state folder.
# The original activate phase independently checks this again under deploy lock.
site=$(readlink -f /srv/peak-trail/state/current)
case "$site" in /srv/peak-trail/state/releases/*/PeakTrailPlatform/site-dist) ;; *) die 'Unexpected current publication path' ;; esac
[ -f "$site/release.json" ] && [ ! -L "$site/release.json" ] || die 'Missing published release receipt'
actual_commit=$("$node" --input-type=module -e 'import { readFileSync } from "node:fs"; console.log(JSON.parse(readFileSync(process.argv[1],"utf8")).commit);' "$site/release.json")
[ "$actual_commit" = "$expected_commit" ] || die 'The exact reviewed Web commit is not published; no service changes were made'
platform=${site%/site-dist}
for filename in trajectory-api.mjs trajectory-contract.mjs trajectory-store.mjs trajectory-worker.mjs peak-daily.mjs; do
  [ -f "$platform/server/$filename" ] && [ ! -L "$platform/server/$filename" ] || die "Published feature module missing: $filename"
done

prepared=$(sh "$installer" prepare)
printf '%s\n' "$prepared"
receipt=$(printf '%s\n' "$prepared" | sed -n 's/^Prepared receipt: \(\/var\/backups\/peak-trail-trajectory\/[A-Za-z0-9_-]*\)$/\1/p')
[ -n "$receipt" ] && [ "$(printf '%s\n' "$receipt" | wc -l)" = 1 ] || die 'Could not identify the prepare receipt; inspect the printed backup path'
sh "$installer" activate "$receipt" "$expected_commit"
