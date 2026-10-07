#!/bin/sh
# Reviewed, interactive administrator operation. This script never publishes code,
# changes Nginx, reads credentials, uploads recordings, or deletes route data.
set -eu

die() { printf '%s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die 'Run from the server owner terminal with sudo; do not send a password to chat.'
[ "$(uname -s)" = Linux ] || die 'This installer is for the existing Linux PEAK server.'
phase=${1:-}
candidate_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
launcher=/srv/peak-trail/live-start.sh
unit=/etc/systemd/system/peak-trail-live.service
private_dir=/var/lib/peak-trail-routes
backup_root=/var/backups/peak-trail-trajectory
deploy_lock=/srv/peak-trail/state/.deploy-lock
node=/opt/peak-trail/node/bin/node
locked=0
changed=0
receipt=

plain_root_dir() {
  [ -d "$1" ] && [ ! -L "$1" ] && [ "$(stat -c %u "$1")" = 0 ] || die "Expected root-owned plain directory: $1"
  [ "$(readlink -f -- "$1")" = "$1" ] || die "Unexpected resolved directory: $1"
}
plain_root_file() {
  [ -f "$1" ] && [ ! -L "$1" ] && [ "$(stat -c %u "$1")" = 0 ] || die "Expected root-owned plain file: $1"
}
atomic_install() {
  source=$1 target=$2 mode=$3
  case "$target" in "$launcher"|"$unit") ;; *) die 'Refusing unrelated installation target' ;; esac
  plain_root_file "$target"
  temporary=$(mktemp "${target}.trajectory.XXXXXX")
  if ! install -o root -g root -m "$mode" -- "$source" "$temporary"; then rm -f -- "$temporary"; return 1; fi
  if ! mv -T -- "$temporary" "$target"; then rm -f -- "$temporary"; return 1; fi
}
health() { curl --fail --silent --show-error --max-time 3 http://127.0.0.1:8787/api/health >/dev/null; }
cleanup() {
  result=$?
  trap - EXIT INT TERM
  if [ "$result" -ne 0 ] && [ "$changed" = 1 ]; then
    set +e
    rollback_failed=0
    atomic_install "$receipt/previous-live-start.sh" "$launcher" 0755 || rollback_failed=1
    atomic_install "$receipt/previous-peak-trail-live.service" "$unit" 0644 || rollback_failed=1
    systemctl daemon-reload || rollback_failed=1
    systemctl restart peak-trail-live.service || rollback_failed=1
    health || rollback_failed=1
    if [ "$rollback_failed" = 0 ]; then printf '%s\n' 'Previous service configuration restored; published source and private route data retained.' >&2
    else printf '%s\n' 'Service configuration rollback needs administrator attention; inspect the backup receipt and this exact service.' >&2; fi
  fi
  if [ "$locked" = 1 ]; then rmdir -- "$deploy_lock" || printf '%s\n' 'Could not release the owned deployment lock; inspect it.' >&2; fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

plain_root_dir /srv/peak-trail
plain_root_dir /etc/systemd/system
plain_root_dir /var/lib
plain_root_dir /var/backups
plain_root_file "$launcher"
plain_root_file "$unit"
[ "$(systemctl show peak-trail-live.service -p User --value)" = peaklive ] || die 'Unexpected service user'
[ "$(systemctl show peak-trail-live.service -p FragmentPath --value)" = "$unit" ] || die 'Unexpected installed unit path'
getent passwd peaklive >/dev/null && getent group peaklive >/dev/null || die 'Expected peaklive service account'

case "$phase" in
  prepare)
    [ "$#" = 1 ] || die 'Usage: sudo sh enable-trajectory-service.sh prepare'
    [ -f "$candidate_dir/trajectory-service.sha256" ] || die 'Missing reviewed candidate checksums'
    (cd -- "$candidate_dir" && sha256sum --check trajectory-service.sha256) || die 'Candidate checksum mismatch'
    [ ! -L "$candidate_dir/live-start.sh" ] && [ ! -L "$candidate_dir/peak-trail-live.service" ] || die 'Candidate symlinks refused'
    sh -n "$candidate_dir/live-start.sh"
    if [ -e "$backup_root" ]; then plain_root_dir "$backup_root"; else install -d -o root -g root -m 0700 -- "$backup_root"; fi
    receipt=$backup_root/$(date -u +%Y%m%dT%H%M%SZ)-$$
    mkdir -m 0700 -- "$receipt"
    install -o root -g root -m 0600 -- "$launcher" "$receipt/previous-live-start.sh"
    install -o root -g root -m 0600 -- "$unit" "$receipt/previous-peak-trail-live.service"
    install -o root -g root -m 0600 -- "$candidate_dir/live-start.sh" "$receipt/candidate-live-start.sh"
    install -o root -g root -m 0600 -- "$candidate_dir/peak-trail-live.service" "$receipt/candidate-peak-trail-live.service"
    (cd -- "$receipt" && sha256sum previous-live-start.sh previous-peak-trail-live.service candidate-live-start.sh candidate-peak-trail-live.service > prepared.sha256)
    if [ -e "$private_dir" ]; then
      [ -d "$private_dir" ] && [ ! -L "$private_dir" ] && [ "$(stat -c %U "$private_dir")" = peaklive ] || die 'Unexpected existing private route directory'
    else install -d -o peaklive -g peaklive -m 0700 -- "$private_dir"; fi
    printf 'Prepared receipt: %s\n' "$receipt"
    printf '%s\n' 'Active unit and launcher were not changed; service was not restarted.'
    printf '%s\n' 'Publish the isolated, tested feature commit through the existing receiver, then run activate with that exact commit.'
    ;;
  activate)
    [ "$#" = 3 ] || die 'Usage: sudo sh enable-trajectory-service.sh activate RECEIPT_DIR EXACT_40_HEX_FEATURE_COMMIT'
    receipt=$2 expected_commit=$3
    case "$receipt" in "$backup_root"/*) ;; *) die 'Receipt must stay under the fixed backup root' ;; esac
    [ "$(readlink -f -- "$receipt")" = "$receipt" ] || die 'Receipt symlink/traversal refused'
    plain_root_dir "$receipt"
    printf '%s' "$expected_commit" | grep -Eq '^[a-f0-9]{40}$' || die 'Expected exact feature commit'
    (cd -- "$receipt" && sha256sum --check prepared.sha256) || die 'Prepared files were modified'
    cmp -s -- "$launcher" "$receipt/previous-live-start.sh" && cmp -s -- "$unit" "$receipt/previous-peak-trail-live.service" || die 'Active configuration changed since prepare; review again'
    [ -d "$private_dir" ] && [ ! -L "$private_dir" ] && [ "$(stat -c %U:%G "$private_dir")" = peaklive:peaklive ] && [ "$(stat -c %a "$private_dir")" = 700 ] || die 'Private directory must be peaklive:peaklive 0700'
    [ -d /srv/peak-trail/state ] && [ ! -L /srv/peak-trail/state ] || die 'Unexpected deployment state directory'
    mkdir -- "$deploy_lock" || die 'A deployment is active; retry after it finishes'
    locked=1
    site=$(readlink -f /srv/peak-trail/state/current)
    case "$site" in /srv/peak-trail/state/releases/*/PeakTrailPlatform/site-dist) ;; *) die 'Unexpected current publication path' ;; esac
    actual_commit=$("$node" --input-type=module -e 'import { readFileSync } from "node:fs"; console.log(JSON.parse(readFileSync(process.argv[1],"utf8")).commit);' "$site/release.json")
    [ "$actual_commit" = "$expected_commit" ] || die 'The exact reviewed feature commit is not currently published'
    platform=${site%/site-dist}
    for filename in trajectory-api.mjs trajectory-contract.mjs trajectory-store.mjs trajectory-worker.mjs peak-daily.mjs; do
      [ -f "$platform/server/$filename" ] && [ ! -L "$platform/server/$filename" ] || die "Published feature module missing: $filename"
    done
    [ -f "$site/index.html" ] && [ ! -L "$site/index.html" ] || die 'Published map browser missing'
    for filename in app.js scene.js community-map-panel.js community-routes.js community-route-model.js community-route-overlay.js route-collection-model.js daily-refresh.js; do
      [ -f "$site/src/$filename" ] && [ ! -L "$site/src/$filename" ] || die "Published map layer module missing: $filename"
    done
    sh -n "$receipt/candidate-live-start.sh"
    systemd-analyze verify "$receipt/candidate-peak-trail-live.service"
    changed=1
    atomic_install "$receipt/candidate-live-start.sh" "$launcher" 0755
    atomic_install "$receipt/candidate-peak-trail-live.service" "$unit" 0644
    systemctl daemon-reload
    systemctl restart peak-trail-live.service
    ready=0
    for attempt in 1 2 3 4 5 6 7 8 9 10; do
      if systemctl is-active --quiet peak-trail-live.service && health && curl --fail --silent --max-time 3 http://127.0.0.1:8787/api/route-groups > "$receipt/route-groups-health.json"; then
        if "$node" --input-type=module -e 'import { readFileSync } from "node:fs"; const value=JSON.parse(readFileSync(process.argv[1],"utf8")); if(!Array.isArray(value.groups)) process.exit(1);' "$receipt/route-groups-health.json"; then ready=1; break; fi
      fi
      sleep 1
    done
    [ "$ready" = 1 ] || die 'New route API did not become healthy; restoring previous service configuration'
    changed=0
    printf 'Trajectory service enabled for %s; no recordings were uploaded or approved. Backup: %s\n' "$expected_commit" "$receipt"
    ;;
  *) die 'Choose prepare or activate; no default mutation is performed' ;;
esac
