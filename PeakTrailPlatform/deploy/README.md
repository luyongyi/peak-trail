# Static deployment receiver

This is a deployment template, not proof that a server has been configured. It does
not open ports, change SSH, install packages, run sudo, or publish live recordings.

An administrator installs Node.js 24 and Git, creates a dedicated `peakdeploy`
account, and establishes this ownership layout (example paths are fixed in the receiver):

```text
/srv/peak-trail/                         root-owned, not writable by peakdeploy
  receiver.mjs                         root-owned, readable, manually updated
  shared/assets/                       root-owned/read-only to peakdeploy
    game-assets/                       verified, explicitly approved public assets
    home-art/
    maps/packs/
    maps/enclosures/                   if the current catalog references them
  state/                               writable by peakdeploy; readable by web server
    releases/                          writable by peakdeploy
    current -> releases/.../PeakTrailPlatform/site-dist
```

For Ubuntu, an administrator can perform this **one-time, reviewed setup** from
their console. These commands are examples, not an automatically executed installer.
`mylu` is the owner's interactive login; do not give the CI account sudo rights or
reuse the owner's key. Install/verify Node 24 separately before continuing; the
distribution's default `apt install nodejs` may be an older major version.

```sh
# Run as root, only if peakdeploy does not already exist.
useradd --system --create-home --home-dir /var/lib/peakdeploy --shell /bin/sh peakdeploy
install -d -o root -g root -m 0755 /srv/peak-trail /srv/peak-trail/shared /srv/peak-trail/shared/assets
install -d -o peakdeploy -g peakdeploy -m 0755 /srv/peak-trail/state /srv/peak-trail/state/releases
install -o root -g root -m 0644 /REVIEWED_CHECKOUT/PeakTrailPlatform/deploy/receiver.mjs /srv/peak-trail/receiver.mjs
install -d -o root -g root -m 0755 /etc/ssh/authorized_keys
```

Create `/etc/ssh/authorized_keys/peakdeploy` as a root-owned `0644` file with the
restricted public-key line below. Review `sshd.peakdeploy.example.conf` against the
existing SSH configuration and install it as a root-owned config snippet. Verify the
Node executable really is `/usr/bin/node`, and check `sshd -t` and the effective
`sshd -T -C user=peakdeploy,host=localhost,addr=127.0.0.1` output **before** reloading
`ssh` (`systemctl reload ssh`). Keep the current console open until a second login
works. Do not replace existing administrator keys or the global sshd configuration.
The account's writable home must not supply the authorized-key policy. Also verify
the existing global SSH environment policy does not admit execution variables such
as `NODE_OPTIONS`, `LD_PRELOAD`, `PATH`, `BASH_ENV` or `ENV`.

Do not copy `local/` wholesale. In particular, recordings, archives, logs, game
installations, private keys, and `.env` files must never enter the public assets.
The existing validation/staging scripts use `PEAK_TRAIL_ASSET_ROOT` to read the
separately provisioned assets; missing or mismatched assets fail before publishing.
The static site does not offer any upload API. Browser log import remains local.

Use a new CI-only Ed25519 key, distinct from the owner's local-login key. Keep the
CI private key in the GitHub production environment secret, never in Git. Pin the
server host key after verifying it out of band; never disable host-key checking.
An administrator must configure `peakdeploy` key-only authentication (no password
or extra unrestricted keys), disable user-controlled SSH environments/rc files,
and put its authorized public key in an administrator-owned AuthorizedKeysFile.
Otherwise the account could replace its own authorization policy. The only line is:

```text
restrict,command="/usr/bin/node /srv/peak-trail/receiver.mjs" ssh-ed25519 <CI_PUBLIC_KEY> peak-trail-actions
```

Check the Node executable path before installing that line. `restrict` disables
PTY, forwarding, agent forwarding and user rc execution. Do not reuse this key for
interactive login. Never place the receiver in a directory writable by the deploy
account. A dedicated service account is still important: executing the trusted
main branch's build scripts is deployment authority, not a sandbox for hostile code.

The SSH command must be exactly `deploy <40-lowercase-hex-commit>`. The receiver
fetches only the fixed public repository's `main`, rejects a commit that is no
longer HEAD, validates/stages in a unique release, checks the public file tree and
manifests, then atomically swaps `state/current`. A failed build leaves the running
site intact. Git and Node receive no client-supplied shell commands or environment.
Do not grant this key to pull-request jobs or untrusted branches.

There is one deployment lock. If a process is killed, an administrator checks for
active deployments before manually removing the empty `.deploy-lock` directory.
Old/failed releases are deliberately retained for investigation/rollback; plan disk
capacity and administrator-reviewed cleanup (each complete release is about 1 GB).
The receiver does not delete releases or shared assets. For rollback, an administrator
can atomically change `current` to a previously verified release while no deploy runs.

`nginx.example.conf` serves only the static `current` directory on loopback 8080.
Review it with the existing web-server configuration and HTTPS reverse proxy; do
not blindly replace existing configuration or expose the live relay on port 8787.
After deployment, verify `/release.json` has the requested commit and load the page,
artwork and a map through the public HTTPS endpoint.

## GitHub Actions configuration

The public code repository is `luyongyi/peak-trail`. The intended site hostname is
`peak.mylus.cn`; inspect the existing Nginx virtual host and certificate before
changing it. Do not replace other sites or disable certificate validation.

Create the `production` GitHub environment, restrict it to `main`, and provision:

| Kind | Name | Value |
| --- | --- | --- |
| Repository variable | `PEAK_SERVER_ENABLED` | `false` until server and assets pass verification; then `true` |
| Repository variable | `PEAK_SERVER_HOST` | Server address or SSH hostname |
| Repository variable | `PEAK_SERVER_PORT` | `22` unless changed |
| Repository variable | `PEAK_SERVER_USER` | `peakdeploy` |
| Environment secret | `PEAK_DEPLOY_KEY` | Dedicated CI private key; never the owner's key |
| Environment secret | `PEAK_KNOWN_HOSTS` | Server host-key line verified independently |
| Repository variable | `PEAK_DAILY_ENABLED` | `true` to enable scheduled daily data updates |
| Repository variable | `PEAK_PAGES_ENABLED` | Keep `false` for this server deployment |

Pushes to `main` and manual runs of `Check PEAK Trail code` first execute code and
synthetic-fixture tests, then call the reusable server deployment. Pull requests
only run tests and never access production credentials. The daily workflow calls
the deployment explicitly after its own tested commit: a `GITHUB_TOKEN` push does
not trigger a second push workflow. Deployment uses an exact commit SHA, no GitHub
token on the server, strict SSH host checking and `IPQoS=none` (needed by the
owner's local connection to this server).

Confirm `/release.json` over HTTPS after the first deployment before calling the
site live. If SSH, the resource restore, Nginx or TLS is not ready, leave server
deployment disabled: passing code tests alone is not a successful site deployment.
