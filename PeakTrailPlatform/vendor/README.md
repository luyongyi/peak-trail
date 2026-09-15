# Vendored browser runtime

Three.js 0.180.0 is copied unchanged from the npm `three@0.180.0` package.
Only `three.module.js`, its `three.core.js` dependency, OrbitControls, the three
LineSegments2 modules for screen-width trail strokes, the
GLTFLoader/BufferGeometryUtils modules for original instanced game geometry,
the bundled meshopt decoder for lossless geometry buffer compression, and the
upstream MIT license are included. The static site's import map resolves to
these files on the same origin; replay does not depend on an external CDN.

Source package: https://www.npmjs.com/package/three/v/0.180.0
