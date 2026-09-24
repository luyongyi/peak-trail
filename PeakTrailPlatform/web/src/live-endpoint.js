export function defaultLiveRelay(location) {
  if (!location?.hostname) return "";
  // Production uses the HTTPS reverse proxy. The local development server and
  // iPad LAN workflow continue to use their separate, loopback/LAN relay port.
  if (location.protocol === "https:") return location.origin;
  return `${location.protocol}//${location.hostname}:8787`;
}
