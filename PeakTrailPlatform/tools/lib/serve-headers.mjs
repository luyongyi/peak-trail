// Cache policy for the local site server, shared with its test. Map-pack
// geometry is content-addressed, so LAN viewers reuse large chapter meshes
// across reloads instead of refetching on every visit. Everything that can
// change between staging passes stays no-store.

export function cacheControlFor(pathname) {
  // The canonical ID does not include additive verified source sidecars.
  if (pathname.endsWith("/map-pack.json")) return "no-store";
  if (/^\/data\/maps\/enclosures\/[a-f0-9]{64}\.glb\.gz$/.test(pathname)) return "public, max-age=31536000, immutable";
  if (pathname.startsWith("/data/maps/packs/")) return "public, max-age=31536000, immutable";
  if (pathname.startsWith("/vendor/")) return "public, max-age=86400";
  return "no-store";
}
