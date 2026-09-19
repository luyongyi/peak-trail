using System;
using System.Collections.Generic;
using UnityEngine;

namespace PeakTrailRecorder;

/// <summary>Read-only observation of actual form state and shared visual assets.</summary>
internal static class AppearanceFormReader
{
    public static AppearanceTelemetry Read(Character character, long observedForMs)
    {
        var result = new AppearanceTelemetry();
        try
        {
            if (character?.photonView?.Owner == null) return result;
            result.FormAuthority = character.photonView.IsMine
                ? "local-character-data-and-renderers" : "replicated-character-data-and-renderers";
            CharacterCustomization? customization = character.refs?.customization;
            CustomizationRefs? visuals = customization?.refs;
            Renderer? transformed = visuals?.skeletonRenderer;
            Mesh? transformedMesh = SharedMesh(transformed);
            bool? skeleton = character.data == null ? null : character.data.isSkeleton;
            result.Form = AppearanceFormEvidence.Resolve(observedForMs, skeleton,
                ObjectActive(transformed), transformedMesh != null && visuals?.mushroomManMesh != null
                    && transformedMesh == visuals.mushroomManMesh,
                ObjectActive(visuals?.chickenRenderer), customization == null ? null : customization.isCannibalizable);
            result.FormReady = result.Form != "unknown";
            Renderer? renderer = result.Form switch
            {
                "skeleton" or "mushroom" => transformed,
                "chicken" => visuals?.chickenRenderer,
                "normal" => visuals?.mainRenderer,
                _ => null,
            };
            if (renderer != null)
            {
                result.FormRendererActive = renderer.enabled && renderer.gameObject.activeInHierarchy;
                result.FormMeshName = SharedMesh(renderer)?.name;
                // sharedMaterials only: reading .material(s) would instantiate
                // material copies and mutate the live game just to record it.
                var names = new List<string>();
                foreach (Material material in renderer.sharedMaterials)
                {
                    if (material != null) names.Add(material.name);
                }
                result.FormMaterialNames = names.ToArray();
            }
        }
        catch
        {
            // Object lifetime may change during spawn/revive. Explicit unknown
            // is a new timeline state, never a reason to retain the old skull.
            result.Form = "unknown";
            result.FormReady = false;
            result.FormRendererActive = null;
            result.FormMeshName = null;
            result.FormMaterialNames = Array.Empty<string>();
        }
        return result;
    }

    private static bool? ObjectActive(Renderer? renderer) => renderer == null ? null : renderer.gameObject.activeInHierarchy;

    private static Mesh? SharedMesh(Renderer? renderer)
    {
        if (renderer == null) return null;
        return renderer is SkinnedMeshRenderer skinned ? skinned.sharedMesh : renderer.GetComponent<MeshFilter>()?.sharedMesh;
    }
}
