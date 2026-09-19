// Cache policy for the local site server, shared with its test. Map packs are
// content-addressed (sha256-… directories): the same path always carries the
// same bytes, so LAN viewers (tablets on Wi-Fi) reuse ~45 MB of chapter meshes
// across reloads instead of refetching on every visit. Everything that can
// change between staging passes stays no-store.

export function cacheControlFor(pathname) {
  if (pathname.startsWith("/data/maps/packs/")) return "public, max-age=31536000, immutable";
  if (pathname.startsWith("/vendor/")) return "public, max-age=86400";
  return "no-store";
}
