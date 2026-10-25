# PEAK 3.0.1 live basemaps

The affected recording is `Level_81`, Recorder 0.8.8, native version
`3.0.1--logFile`, Steam build `26155610`. Published maps previously covered
`26134529` (3.0.0), so exact-build selection correctly returned no map. Map
availability must be restored without bypassing trace compatibility checks.

## Source-backed patch-build reuse

`tools/offline-maps/verify_map_build_equivalence.py` authenticates the installed
Steam identity and all native map bundles against the earlier complete-build
evidence. It checks the extracted payloads and dependency closure, scene order,
audited map-selection code, and each existing canonical map and derivative. It
writes a receipt only after the full check succeeds. Changed or unknown sources
fail; the ordinary export pipeline remains the fallback for changed maps.

`tools/prepare-verified-map-build.mjs` consumes a SHA-256-pinned receipt. It creates
new canonical map identities for the new build and version, a complete derivative
plan, and six exact-map sidecars. Source geometry is unchanged. The earlier build
remains in the catalog so historical recordings keep working. A previous
assembly's legacy layout assertion is not carried into the new landmark evidence.

Preparation writes a fresh private output, for example:

```powershell
$receipt = 'C:/path/to/map-build-equivalence.json'
$receiptSha = (Get-FileHash -LiteralPath $receipt -Algorithm SHA256).Hash.ToLowerInvariant()
node PeakTrailPlatform/tools/prepare-verified-map-build.mjs `
  --report $receipt --report-sha256 $receiptSha `
  --assets C:/path/to/verified/assets --output local/checks/new-build-prepared
```

Review and copy the output catalog and six sidecars into `data/maps/`. Provision
the new build's separately re-exported character assets before making it the
active default and updating the daily resolver's build binding.

## Read-only deployment inputs

Keep the receipt, plan and new manifests under
`data/maps/verified-builds/<build>/`. The adjacent `index.json` pins the exact
plan and receipt hashes. `tools/lib/verified-map-input.mjs` verifies both old and
new canonical identities, unchanged layers and dependency hashes before exposing
the old immutable derivatives as build inputs. It reads the administrator-owned
asset store and writes only the normal generated release tree. No privileged
asset installation or writable shared source directory is required.

The generated public site still uses its standard
`data/maps/packs/<new-map-pack-id>/` paths and standard manifests. Browser
selection and compatibility checks continue to require the recording's exact
build, scene, projection and coordinate space. Rebound supply surveys likewise
receive the new build and map identity while their original source coordinates
and checksum-verified marker data are retained.

The server release's 20 GB limit measures logical file size across both 208-map
versions. The existing SHA-256 public asset pool shares identical binary bytes;
physical storage use and deployment headroom must still be checked. GitHub Pages
retains its separate 1 GB limit.

## Validation

Run the source receipt verification, preparation tests, Web checks and tests,
tool tests, `validate-data.mjs` and `stage-site.mjs`. Against the staged result,
verify the affected recording selects its new map and passes compatibility, all
208 new manifests have independent valid canonical identities, original map
entries remain available, and all geometry/survey references resolve.

After publication, check `release.json`, the catalog, the affected map manifest
and its referenced geometry over HTTPS. A failed map load now retains its reason
in the watch status instead of silently reducing the view to trails alone.
