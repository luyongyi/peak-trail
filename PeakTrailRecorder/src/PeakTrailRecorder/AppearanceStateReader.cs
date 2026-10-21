using System;
using System.Collections.Generic;
using Photon.Pun;
using UnityEngine;

namespace PeakTrailRecorder;

/// <summary>Observes real visual instances on Unity's thread, without invoking
/// lifecycle methods, creating materials, or inferring visuals from status bars.</summary>
internal static class AppearanceStateReader
{
    public static void Read(Character character, AppearanceTelemetry result)
    {
        if (character == null || character.photonView?.Owner == null
            || character.photonView.Owner.IsInactive || !PhotonNetwork.InRoom
            || !character.gameObject.activeInHierarchy) return;
        // One missing renderer must not erase a separately proven ghost entity.
        ReadPetrification(character, result);
        ReadBlindness(character, result);
        ReadGhost(character, result);
    }

    private static void ReadGhost(Character character, AppearanceTelemetry result)
    {
        try
        {
            PlayerGhost? ghost = character.Ghost;
            if (ghost == null)
            {
                // Unity's destroyed-object comparison also reaches this branch.
                result.GhostReady = true;
                result.GhostActive = false;
                result.GhostVisible = false;
                return;
            }
            // RPCA_InitGhost assigns both m_owner and owner.Ghost. A cached or
            // not-yet-initialized pointer to somebody else's entity is unknown.
            if (ghost.m_owner != character) return;
            bool active = ghost.gameObject.activeInHierarchy;
            bool? visible = Visibility(ghost.PlayerRenderers);
            float[]? position = null;
            float[]? rotation = null;
            if (active)
            {
                Vector3 p = ghost.transform.position;
                Quaternion q = ghost.transform.rotation;
                if (InRange(p.x, -1_000_000, 1_000_000) && InRange(p.y, -1_000_000, 1_000_000)
                    && InRange(p.z, -1_000_000, 1_000_000)) position = new[] { p.x, p.y, p.z };
                if (InRange(q.x, -1, 1) && InRange(q.y, -1, 1) && InRange(q.z, -1, 1)
                    && InRange(q.w, -1, 1)) rotation = new[] { q.x, q.y, q.z, q.w };
            }
            result.GhostReady = true;
            result.GhostActive = active;
            result.GhostVisible = active ? visible : false;
            result.GhostPosition = position;
            result.GhostRotation = rotation;
            if (!active) return;
            // The game's owner hides their own ghost renderers. This is still a
            // real owned entity, even with local visible=false or unknown body form.
            result.Form = "ghost";
            result.FormReady = true;
            result.FormAuthority = "player-ghost-owner-and-renderers";
            result.FormRendererActive = visible;
            result.FormMeshName = null;
            result.FormMaterialNames = Array.Empty<string>();
            foreach (Renderer renderer in ghost.PlayerRenderers ?? Array.Empty<Renderer>())
            {
                if (renderer == null) continue;
                result.FormMeshName = (renderer is SkinnedMeshRenderer skinned
                    ? skinned.sharedMesh : renderer.GetComponent<MeshFilter>()?.sharedMesh)?.name;
                var names = new List<string>();
                foreach (Material material in renderer.sharedMaterials)
                    if (material != null) names.Add(material.name);
                result.FormMaterialNames = names.ToArray();
                break;
            }
        }
        catch
        {
            result.GhostReady = false;
            result.GhostActive = result.GhostVisible = null;
            result.GhostPosition = result.GhostRotation = null;
            if (result.Form == "ghost")
            {
                result.Form = "unknown";
                result.FormReady = false;
                result.FormRendererActive = null;
                result.FormMeshName = null;
                result.FormMaterialNames = Array.Empty<string>();
            }
        }
    }

    private static void ReadPetrification(Character character, AppearanceTelemetry result)
    {
        try
        {
            Renderer[]? renderers = character.refs?.customization?.refs?.stoneRenderers;
            bool? active = Visibility(renderers, hierarchy: false);
            if (!active.HasValue || character.data == null) return;
            bool triggered = character.data.shouldPetrify;
            float progress = character.data.passOutValue;
            float? amount = null;
            bool amountKnown = true;
            if (active.Value)
            {
                foreach (Renderer renderer in renderers!)
                {
                    if (renderer == null || !LayerEnabled(renderer)) continue;
                    // sharedMaterials returns existing references without Unity's
                    // .material/.materials getters creating fresh material instances.
                    Material[] materials = renderer.sharedMaterials;
                    if (materials.Length == 0) amountKnown = false;
                    foreach (Material material in materials)
                    {
                        if (material == null || !material.HasProperty("_Petrify")) { amountKnown = false; continue; }
                        float observed = material.GetFloat("_Petrify");
                        if (!InRange(observed, -1000, 1000) || amount.HasValue && amount.Value != observed)
                            amountKnown = false;
                        else amount = observed;
                    }
                }
            }
            result.PetrificationReady = true;
            result.PetrificationActive = active;
            result.PetrificationTriggered = triggered;
            result.PetrificationProgress = InRange(progress, 0, 1) ? progress : null;
            result.PetrificationAmount = amountKnown ? amount : null;
        }
        catch
        {
            result.PetrificationReady = false;
            result.PetrificationActive = result.PetrificationTriggered = null;
            result.PetrificationProgress = result.PetrificationAmount = null;
        }
    }

    private static void ReadBlindness(Character character, AppearanceTelemetry result)
    {
        try
        {
            Renderer? renderer = character.refs?.customization?.refs?.blindRenderer;
            if (renderer == null) return;
            // Native OnApplied/OnRemoved toggles this layer itself. A hidden
            // camera parent is not evidence that the affliction was removed.
            bool visible = LayerEnabled(renderer);
            result.BlindnessReady = true;
            result.BlindnessActive = visible;
        }
        catch { result.BlindnessReady = false; result.BlindnessActive = null; }
    }

    private static bool? Visibility(Renderer[]? renderers, bool hierarchy = true)
    {
        if (renderers == null || renderers.Length == 0) return null;
        bool complete = true;
        foreach (Renderer renderer in renderers)
        {
            if (renderer == null) { complete = false; continue; }
            if (hierarchy ? Visible(renderer) : LayerEnabled(renderer)) return true;
        }
        return complete ? false : null;
    }

    private static bool Visible(Renderer renderer) => renderer.enabled && renderer.gameObject.activeInHierarchy;
    private static bool LayerEnabled(Renderer renderer) => renderer.enabled && renderer.gameObject.activeSelf;
    private static bool InRange(float value, float min, float max)
        => !float.IsNaN(value) && !float.IsInfinity(value) && value >= min && value <= max;
}
