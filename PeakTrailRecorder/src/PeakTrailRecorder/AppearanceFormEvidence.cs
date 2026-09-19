namespace PeakTrailRecorder;

/// <summary>Pure evidence rules; no form is inferred from held items or inventory.</summary>
internal static class AppearanceFormEvidence
{
    public static string Resolve(long observedForMs, bool? isSkeleton,
        bool? transformedRendererActive, bool transformedMeshIsMushroom,
        bool? chickenRendererActive, bool? isCannibalizable)
    {
        // Match the existing spawn grace period. Incomplete character refs must
        // be reported as unknown, not as a normal human that erases real data.
        if (observedForMs < 2000) return "unknown";
        // SetMushroomMan reuses skeletonRenderer with a distinct original mesh.
        // Its inactive leftover sharedMesh is not evidence of a current form.
        if (transformedRendererActive == true && transformedMeshIsMushroom) return "mushroom";
        if (isSkeleton == true) return "skeleton";
        if (isSkeleton != false || transformedRendererActive != false) return "unknown";
        if (chickenRendererActive == true && isCannibalizable == true) return "chicken";
        // Human/chicken cross-fades can leave one of these indicators changing
        // before the other; do not falsely stamp that transition as normal.
        if (chickenRendererActive != false || isCannibalizable != false) return "unknown";
        return "normal";
    }
}
