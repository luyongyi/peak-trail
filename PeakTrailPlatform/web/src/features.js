// Archived features stay reversible, with their UI and IO disabled together.
// The public site only exposes maps and routes shared by the memories Mod.
export const FEATURES = Object.freeze({ liveVisible: false, legacyReplayVisible: false });

export function shouldPollLive({ visible = FEATURES.liveVisible, pageOpen = false } = {}) {
  return visible === true && pageOpen === true;
}
