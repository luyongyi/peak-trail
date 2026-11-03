// Camera intent is independent of the live playhead. Following time must not
// take the camera back after somebody chooses a player, overview or free view.
export function createLiveCameraController() {
  let connection = null, run = null, mode = "pending", target = null;
  let observedRevision = null, suspension = null, generation = 0;
  let savedPose = null, restoreTarget = false, rotate = false;

  const revision = viewer => viewer?.cameraSelectionRevision ?? 0;
  const internalRevision = viewer => viewer?.followChangeRevision === revision(viewer)
    && ["automatic", "unavailable", "data"].includes(viewer?.followChangeReason);
  const rememberPose = viewer => viewer?.camera && viewer?.controls ? {
    position: viewer.camera.position.toArray(), quaternion: viewer.camera.quaternion.toArray(),
    up: viewer.camera.up.toArray(), target: viewer.controls.target.toArray(),
    near: viewer.camera.near, far: viewer.camera.far,
    mode: viewer.freeCamera?.mode || "orbit", preset: viewer.surveyPreset,
  } : null;
  const observe = (viewer, { duringReset = false } = {}) => {
    if (!viewer || suspension !== null && !duringReset || observedRevision === revision(viewer)) return;
    observedRevision = revision(viewer);
    if (internalRevision(viewer)) {
      if (mode === "locked" && viewer.followTargetId != null) target = viewer.followTargetId;
      return;
    }
    mode = viewer.followTargetId != null ? "locked" : "manual";
    target = viewer.followTargetId ?? null;
    rotate = Boolean(viewer.followAutoRotate);
    if (mode === "manual") savedPose = rememberPose(viewer);
  };
  const reset = viewer => {
    mode = "pending"; target = null; savedPose = null; rotate = false; restoreTarget = false;
    observedRevision = revision(viewer); suspension = null; generation++;
  };
  const select = (viewer, id) => {
    viewer.followAutoRotate = mode === "locked" && rotate;
    viewer.setFollowTarget(id, { reason: "automatic" });
    if (id !== null) target = id;
    observedRevision = revision(viewer);
  };

  const api = {
    // Waiting snapshots have no run identity yet. They must not erase the
    // camera choice of the run that is reconnecting behind them.
    begin(key, viewer, { runId = null } = {}) {
      if (key !== connection || runId !== null && run !== null && runId !== run) {
        reset(viewer); connection = key; run = null;
      }
      if (runId !== null) run = runId;
    },
    suspend(viewer) {
      const alreadySuspended = suspension !== null;
      observe(viewer, { duringReset: true });
      if (mode === "manual" && (!alreadySuspended || !internalRevision(viewer))) savedPose = rememberPose(viewer);
      if (mode === "locked" && viewer?.followTargetId != null) target = viewer.followTargetId;
      suspension = ++generation;
      return suspension;
    },
    // Called immediately before an application data rebuild. It remembers a
    // gesture made while map lookup/render queuing awaited, before that rebuild
    // can replace the scene's last reason with its own data revision.
    checkpoint(viewer, { runId = null } = {}) {
      if (suspension !== null && (runId === null || run === null || runId === run)) {
        observe(viewer, { duringReset: true });
        if (mode === "manual" && viewer && !internalRevision(viewer)) savedPose = rememberPose(viewer);
      }
    },
    resume(token, viewer) {
      if (token !== suspension) return false;
      if (!viewer) {
        suspension = null; observedRevision = null;
        return true;
      }
      // Data loading can reset its own overview, but a gesture made while it
      // loads still owns the camera. Scene data changes carry an exact revision;
      // a later, untagged revision is a manual choice, even with a stale reason.
      observe(viewer, { duringReset: true });
      if (mode === "manual" && !internalRevision(viewer)) savedPose = rememberPose(viewer);
      suspension = null;
      if (mode === "manual" && savedPose) {
        viewer.setFollowTarget(null, { reason: "data" });
        viewer.freeCamera?.setMode(savedPose.mode, { focus: false });
        viewer.camera.up.fromArray(savedPose.up);
        viewer.camera.position.fromArray(savedPose.position);
        viewer.camera.quaternion.fromArray(savedPose.quaternion);
        viewer.camera.near = savedPose.near; viewer.camera.far = savedPose.far;
        viewer.camera.updateProjectionMatrix();
        viewer.controls.target.fromArray(savedPose.target);
        viewer.surveyPreset = savedPose.preset;
        if (savedPose.mode === "orbit") {
          const damping = viewer.controls.enableDamping;
          viewer.controls.enableDamping = false; viewer.controls.update();
          viewer.controls.enableDamping = damping;
        }
      }
      restoreTarget = mode === "locked" && target !== null;
      observedRevision = revision(viewer);
      return true;
    },
    sync(viewer, { active = false, ready = false, status = "waiting" } = {}) {
      if (!active || !ready || !viewer || suspension !== null) return;
      observe(viewer);
      if (mode === "pending") {
        if (status === "ended") { mode = "manual"; savedPose = rememberPose(viewer); return; }
        if (status !== "live") return;
        mode = "auto";
      }
      if (mode === "locked") {
        if (restoreTarget && viewer.canFollowPlayer(target)) {
          select(viewer, target); restoreTarget = false;
        }
        return;
      }
      if (mode !== "auto" || status !== "live") return;
      if (viewer.followTargetId != null && viewer.canFollowPlayer(viewer.followTargetId)) {
        target = viewer.followTargetId;
        return;
      }
      const next = target !== null && viewer.canFollowPlayer(target) ? target
        : [...viewer.playerObjects.keys()].find(id => viewer.canFollowPlayer(id)) ?? null;
      if (next !== null || viewer.followTargetId != null) select(viewer, next);
    },
  };
  return api;
}
