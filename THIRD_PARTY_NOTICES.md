# Third-party notices

- The BepInEx template's original CC0 text is retained in
  `third_party/licenses/BepInExTemplate-CC0.txt` as provenance for template-derived
  project scaffolding. It is not a new licensing declaration for all PEAK Trail code.
- Vendored Three.js files retain their upstream MIT license at
  `PeakTrailPlatform/vendor/three/0.180.0/LICENSE`; see the adjacent vendor README.
- NuGet, npm and Python dependencies retain their upstream licenses. Installed
  dependency caches and virtual environments are not tracked.
- Extracted PEAK models, textures and icons are local-only, ignored files.
  A small material-parameter snapshot is tracked at
  `PeakTrailPlatform/tools/offline-maps/source-effect-materials.25306743.json`
  for shader-adapter regression tests. Neither these assets nor that snapshot
  are covered by the template or Three.js licenses.
