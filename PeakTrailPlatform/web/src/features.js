// Keep the live implementation available for a later product decision.
// A hidden live feature also makes no relay requests or background polling.
export const FEATURES = Object.freeze({ liveVisible: false });

export function shouldPollLive({ visible = FEATURES.liveVisible, pageOpen = false } = {}) {
  return visible === true && pageOpen === true;
}
