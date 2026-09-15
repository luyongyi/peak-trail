using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using BepInEx;
using BepInEx.Logging;
using Steamworks;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace PeakTrail.MapExporter;

internal sealed class MapPackExporter
{
    private const int SchemaVersion = 1;
    private const int ProjectionVersion = 1;
    private const string HeightEncoding = "float32-le-row-major-minz-minx";

    private readonly ManualLogSource _log;
    private readonly ExportSettings _settings;
    private readonly RaycastHit[] _raycastBuffer = new RaycastHit[128];

    public MapPackExporter(ManualLogSource log, ExportSettings settings)
    {
        _log = log;
        _settings = settings;
    }

    public IEnumerator ExportCurrentScene()
    {
        MapHandler map = MapHandler.Instance;
        MapHandler.MapSegment[] segments = map.segments;
        if (segments.Length == 0)
        {
            _log.LogWarning("MapHandler has no segments; export cancelled.");
            yield break;
        }

        string sceneName = SceneManager.GetActiveScene().name;
        string exportName = $"{SafeFileName(sceneName)}-{DateTime.UtcNow:yyyyMMdd-HHmmss}Z";
        string outputRoot = Path.GetFullPath(Environment.ExpandEnvironmentVariables(_settings.OutputDirectory));
        string outputDirectory = Path.Combine(outputRoot, exportName);
        Directory.CreateDirectory(outputDirectory);

        List<ActiveState> activeStates = SnapshotSegmentStates(segments);
        float originalTimeScale = Time.timeScale;
        var layers = new List<LayerManifest>(segments.Length);
        bool completed = false;

        _log.LogMessage(
            $"Exporting {sceneName} ({segments.Length} segments) to '{outputDirectory}'. "
                + "The game will be paused while scene objects are isolated."
        );

        Time.timeScale = 0f;
        try
        {
            for (int index = 0; index < segments.Length; index++)
            {
                SetOnlySegmentActive(segments, index);
                Physics.SyncTransforms();
                yield return null;

                MapHandler.MapSegment segment = segments[index];
                List<Transform> roots = GetLayerRoots(segment);
                Geometry geometry = CollectGeometry(roots);
                if (!geometry.TryGetBounds(out Bounds bounds))
                {
                    _log.LogWarning($"Segment {index} ({segment.biome}) has no active renderer/collider bounds; skipping it.");
                    continue;
                }

                CaptureRect rect = CaptureRect.FromBounds(bounds, _settings.BoundsPadding);
                string slug = SafeFileName(segment.biome.ToString()).ToLowerInvariant();
                string layerId = $"segment-{index:D2}-{slug}";
                string textureName = layerId + ".png";
                string heightName = layerId + ".height.f32";
                string texturePath = Path.Combine(outputDirectory, textureName);
                string heightPath = Path.Combine(outputDirectory, heightName);

                _log.LogMessage(
                    $"[{index + 1}/{segments.Length}] Capturing {segment.biome}: "
                        + $"XZ {rect.Size:F1}m square, Y {bounds.min.y:F1}..{bounds.max.y:F1}."
                );

                var hiddenRenderers = new List<Renderer>();
                var hiddenTerrains = new List<Terrain>();
                try
                {
                    HideRenderersOutside(geometry.Renderers, hiddenRenderers);
                    HideTerrainsOutside(geometry.Terrains, hiddenTerrains);
                    CaptureTexture(rect, bounds, texturePath);
                }
                finally
                {
                    RestoreRenderers(hiddenRenderers);
                    RestoreTerrains(hiddenTerrains);
                }

                HeightResult heightResult = default;
                yield return WriteHeightField(
                    rect,
                    bounds,
                    geometry.ColliderIds,
                    heightPath,
                    result => heightResult = result
                );

                layers.Add(
                    new LayerManifest
                    {
                        id = layerId,
                        name = segment.biome.ToString(),
                        segment = index,
                        biome = segment.biome.ToString(),
                        texture = textureName,
                        textureSha256 = Sha256File(texturePath),
                        height = heightName,
                        heightSha256 = heightResult.Sha256,
                        columns = _settings.HeightResolution,
                        rows = _settings.HeightResolution,
                        minX = rect.MinX,
                        maxX = rect.MaxX,
                        minY = bounds.min.y,
                        maxY = bounds.max.y,
                        minZ = rect.MinZ,
                        maxZ = rect.MaxZ,
                        heightEncoding = HeightEncoding,
                        validHeightSamples = heightResult.ValidSamples,
                    }
                );
            }

            if (layers.Count == 0)
            {
                _log.LogError("No map layers could be exported.");
                yield break;
            }

            var manifest = new MapPackManifest
            {
                schemaVersion = SchemaVersion,
                generatedAtUtc = DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture),
                gameVersion = Application.version,
                gameBuildId = GetSteamBuildId(),
                sceneName = sceneName,
                mapSlot = ParseMapSlot(sceneName),
                projectionVersion = ProjectionVersion,
                coordinateSpace = "unity-world-meters",
                layers = layers.ToArray(),
            };
            manifest.mapPackId = MapPackIdentity.ComputeId(manifest);

            string manifestPath = Path.Combine(outputDirectory, "map-pack.json");
            File.WriteAllText(manifestPath, JsonUtility.ToJson(manifest, prettyPrint: true), new UTF8Encoding(false));
            completed = true;
            _log.LogMessage($"Map pack complete: {manifest.mapPackId}\n{manifestPath}");
        }
        finally
        {
            RestoreSegmentStates(activeStates);
            Physics.SyncTransforms();
            Time.timeScale = originalTimeScale;
            if (!completed)
            {
                _log.LogWarning(
                    $"Export did not complete. Original object states were restored; partial files remain in '{outputDirectory}'."
                );
            }
        }
    }

    private IEnumerator WriteHeightField(
        CaptureRect rect,
        Bounds bounds,
        HashSet<int> colliderIds,
        string outputPath,
        Action<HeightResult> completed
    )
    {
        int columns = _settings.HeightResolution;
        int rows = _settings.HeightResolution;
        float cellX = rect.Size / columns;
        float cellZ = rect.Size / rows;
        float rayMargin = Mathf.Max(10f, rect.Size * 0.02f);
        float originY = bounds.max.y + rayMargin;
        float rayDistance = Mathf.Max(1f, bounds.size.y + rayMargin * 2f);
        int validSamples = 0;

        using (var stream = new FileStream(outputPath, FileMode.CreateNew, FileAccess.Write, FileShare.Read))
        using (var writer = new BinaryWriter(stream))
        {
            for (int row = 0; row < rows; row++)
            {
                // Shared schema: row zero starts at minZ, column zero starts at minX.
                float z = rect.MinZ + (row + 0.5f) * cellZ;
                for (int column = 0; column < columns; column++)
                {
                    float x = rect.MinX + (column + 0.5f) * cellX;
                    float height = FindTopSurfaceHeight(x, z, originY, rayDistance, colliderIds);
                    if (!float.IsNaN(height))
                    {
                        validSamples++;
                    }

                    // BinaryWriter writes primitive numeric values little-endian.
                    writer.Write(height);
                }

                if ((row + 1) % _settings.HeightRowsPerFrame == 0)
                {
                    yield return null;
                }
            }
        }

        completed(new HeightResult(Sha256File(outputPath), validSamples));
    }

    private float FindTopSurfaceHeight(
        float x,
        float z,
        float originY,
        float distance,
        HashSet<int> colliderIds
    )
    {
        Vector3 origin = new(x, originY, z);
        int count = Physics.RaycastNonAlloc(
            origin,
            Vector3.down,
            _raycastBuffer,
            distance,
            ~0,
            QueryTriggerInteraction.Ignore
        );

        float result = float.NaN;
        if (count < _raycastBuffer.Length)
        {
            for (int i = 0; i < count; i++)
            {
                RaycastHit hit = _raycastBuffer[i];
                if (hit.collider != null && colliderIds.Contains(hit.collider.GetInstanceID()))
                {
                    result = float.IsNaN(result) ? hit.point.y : Mathf.Max(result, hit.point.y);
                }
            }
            return result;
        }

        // A saturated non-alloc buffer could omit the selected segment's hit.
        // Fall back to the allocating API only for these unusually dense cells.
        RaycastHit[] allHits = Physics.RaycastAll(
            origin,
            Vector3.down,
            distance,
            ~0,
            QueryTriggerInteraction.Ignore
        );
        foreach (RaycastHit hit in allHits)
        {
            if (hit.collider != null && colliderIds.Contains(hit.collider.GetInstanceID()))
            {
                result = float.IsNaN(result) ? hit.point.y : Mathf.Max(result, hit.point.y);
            }
        }
        return result;
    }

    private void CaptureTexture(CaptureRect rect, Bounds bounds, string outputPath)
    {
        int resolution = _settings.TextureResolution;
        float margin = Mathf.Max(10f, rect.Size * 0.02f);
        float cameraY = bounds.max.y + margin;
        GameObject cameraObject = new("PeakMapExporter-Camera")
        {
            hideFlags = HideFlags.HideAndDontSave,
        };
        Camera camera = cameraObject.AddComponent<Camera>();
        RenderTexture? renderTexture = null;
        Texture2D? texture = null;
        RenderTexture? previousActive = RenderTexture.active;

        try
        {
            camera.enabled = false;
            camera.orthographic = true;
            camera.orthographicSize = rect.Size * 0.5f;
            camera.aspect = 1f;
            camera.transform.position = new Vector3(rect.CenterX, cameraY, rect.CenterZ);
            camera.transform.rotation = Quaternion.Euler(90f, 0f, 0f);
            camera.nearClipPlane = 0.05f;
            camera.farClipPlane = Mathf.Max(1f, bounds.size.y + margin * 2f);
            camera.clearFlags = CameraClearFlags.SolidColor;
            camera.backgroundColor = new Color(0f, 0f, 0f, 0f);
            camera.cullingMask = _settings.CameraCullingMask;
            camera.useOcclusionCulling = false;
            camera.allowHDR = false;
            camera.allowMSAA = false;

            renderTexture = RenderTexture.GetTemporary(
                resolution,
                resolution,
                24,
                RenderTextureFormat.ARGB32,
                RenderTextureReadWrite.sRGB
            );
            renderTexture.filterMode = FilterMode.Bilinear;
            camera.targetTexture = renderTexture;
            camera.Render();

            RenderTexture.active = renderTexture;
            texture = new Texture2D(resolution, resolution, TextureFormat.RGBA32, mipChain: false, linear: false)
            {
                hideFlags = HideFlags.HideAndDontSave,
            };
            texture.ReadPixels(new Rect(0f, 0f, resolution, resolution), 0, 0, recalculateMipMaps: false);
            texture.Apply(updateMipmaps: false, makeNoLongerReadable: false);
            File.WriteAllBytes(outputPath, texture.EncodeToPNG());
        }
        finally
        {
            RenderTexture.active = previousActive;
            camera.targetTexture = null;
            if (renderTexture != null)
            {
                RenderTexture.ReleaseTemporary(renderTexture);
            }
            if (texture != null)
            {
                UnityEngine.Object.Destroy(texture);
            }
            UnityEngine.Object.Destroy(cameraObject);
        }
    }

    private static Geometry CollectGeometry(IReadOnlyList<Transform> roots)
    {
        var renderers = new List<Renderer>();
        var colliders = new List<Collider>();
        var terrains = new List<Terrain>();
        var seenRenderers = new HashSet<int>();
        var seenColliders = new HashSet<int>();
        var seenTerrains = new HashSet<int>();

        foreach (Transform root in roots)
        {
            foreach (Renderer renderer in root.GetComponentsInChildren<Renderer>(includeInactive: true))
            {
                if (
                    renderer != null
                    && renderer.enabled
                    && renderer.gameObject.activeInHierarchy
                    && IsStaticMapGeometry(renderer)
                    && seenRenderers.Add(renderer.GetInstanceID())
                )
                {
                    renderers.Add(renderer);
                }
            }

            foreach (Collider collider in root.GetComponentsInChildren<Collider>(includeInactive: true))
            {
                if (
                    collider != null
                    && collider.enabled
                    && !collider.isTrigger
                    && collider.gameObject.activeInHierarchy
                    && IsStaticMapGeometry(collider)
                    && seenColliders.Add(collider.GetInstanceID())
                )
                {
                    colliders.Add(collider);
                }
            }

            foreach (Terrain terrain in root.GetComponentsInChildren<Terrain>(includeInactive: true))
            {
                if (
                    terrain != null
                    && terrain.enabled
                    && terrain.gameObject.activeInHierarchy
                    && seenTerrains.Add(terrain.GetInstanceID())
                )
                {
                    terrains.Add(terrain);
                }
            }
        }

        return new Geometry(renderers, colliders, terrains);
    }

    private static bool IsStaticMapGeometry(Component component)
    {
        if (component is ParticleSystemRenderer || component is TrailRenderer || component is LineRenderer)
        {
            return false;
        }

        Rigidbody? body = component.GetComponentInParent<Rigidbody>();
        return body == null || body.isKinematic;
    }

    private static void HideRenderersOutside(
        IReadOnlyCollection<Renderer> included,
        ICollection<Renderer> hidden
    )
    {
        var includedIds = new HashSet<int>(included.Select(renderer => renderer.GetInstanceID()));
        Renderer[] all = UnityEngine.Object.FindObjectsByType<Renderer>(
            FindObjectsInactive.Include,
            FindObjectsSortMode.None
        );
        foreach (Renderer renderer in all)
        {
            if (
                renderer != null
                && renderer.enabled
                && renderer.gameObject.activeInHierarchy
                && !includedIds.Contains(renderer.GetInstanceID())
            )
            {
                renderer.enabled = false;
                hidden.Add(renderer);
            }
        }
    }

    private static void HideTerrainsOutside(
        IReadOnlyCollection<Terrain> included,
        ICollection<Terrain> hidden
    )
    {
        var includedIds = new HashSet<int>(included.Select(terrain => terrain.GetInstanceID()));
        Terrain[] all = UnityEngine.Object.FindObjectsByType<Terrain>(
            FindObjectsInactive.Include,
            FindObjectsSortMode.None
        );
        foreach (Terrain terrain in all)
        {
            if (
                terrain != null
                && terrain.enabled
                && terrain.gameObject.activeInHierarchy
                && !includedIds.Contains(terrain.GetInstanceID())
            )
            {
                terrain.enabled = false;
                hidden.Add(terrain);
            }
        }
    }

    private static void RestoreRenderers(IEnumerable<Renderer> renderers)
    {
        foreach (Renderer renderer in renderers)
        {
            if (renderer != null)
            {
                renderer.enabled = true;
            }
        }
    }

    private static void RestoreTerrains(IEnumerable<Terrain> terrains)
    {
        foreach (Terrain terrain in terrains)
        {
            if (terrain != null)
            {
                terrain.enabled = true;
            }
        }
    }

    private static List<Transform> GetLayerRoots(MapHandler.MapSegment segment)
    {
        var roots = new List<Transform>(4);
        AddRoot(roots, segment.segmentParent);
        AddRoot(roots, segment.segmentCampfire);
        AddRoot(roots, segment.wallNext);
        AddRoot(roots, segment.wallPrevious);
        return roots;
    }

    private static void AddRoot(ICollection<Transform> roots, GameObject? gameObject)
    {
        if (gameObject == null)
        {
            return;
        }
        Transform transform = gameObject.transform;
        if (!roots.Any(existing => transform == existing || transform.IsChildOf(existing)))
        {
            roots.Add(transform);
        }
    }

    private static List<ActiveState> SnapshotSegmentStates(IEnumerable<MapHandler.MapSegment> segments)
    {
        var states = new List<ActiveState>();
        var seen = new HashSet<int>();
        foreach (MapHandler.MapSegment segment in segments)
        {
            foreach (Transform root in GetLayerRoots(segment))
            {
                GameObject gameObject = root.gameObject;
                if (seen.Add(gameObject.GetInstanceID()))
                {
                    states.Add(new ActiveState(gameObject, gameObject.activeSelf));
                }
            }
        }
        return states;
    }

    private static void SetOnlySegmentActive(IReadOnlyList<MapHandler.MapSegment> segments, int selectedIndex)
    {
        var allRoots = new List<Transform>();
        var seen = new HashSet<int>();
        foreach (MapHandler.MapSegment segment in segments)
        {
            foreach (Transform root in GetLayerRoots(segment))
            {
                if (seen.Add(root.gameObject.GetInstanceID()))
                {
                    allRoots.Add(root);
                }
            }
        }

        foreach (Transform root in allRoots)
        {
            root.gameObject.SetActive(false);
        }
        foreach (Transform root in GetLayerRoots(segments[selectedIndex]))
        {
            root.gameObject.SetActive(true);
        }
    }

    private static void RestoreSegmentStates(IEnumerable<ActiveState> states)
    {
        foreach (ActiveState state in states)
        {
            if (state.GameObject != null)
            {
                state.GameObject.SetActive(state.ActiveSelf);
            }
        }
    }

    private static int ParseMapSlot(string sceneName)
    {
        const string prefix = "Level_";
        if (
            sceneName.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
            && int.TryParse(
                sceneName.Substring(prefix.Length),
                NumberStyles.None,
                CultureInfo.InvariantCulture,
                out int slot
            )
        )
        {
            return slot;
        }
        return 0;
    }

    private int GetSteamBuildId()
    {
        try
        {
            if (SteamManager.Initialized)
            {
                int buildId = SteamApps.GetAppBuildId();
                if (buildId > 0)
                {
                    return buildId;
                }
            }
        }
        catch
        {
            // Fall through to Steam's local app manifest.
        }

        try
        {
            string appManifest = Path.GetFullPath(
                Path.Combine(Paths.GameRootPath, "..", "..", "appmanifest_3527290.acf")
            );
            if (File.Exists(appManifest))
            {
                Match match = Regex.Match(
                    File.ReadAllText(appManifest),
                    "\\\"buildid\\\"\\s+\\\"(?<id>[0-9]+)\\\"",
                    RegexOptions.CultureInvariant
                );
                if (
                    match.Success
                    && int.TryParse(
                        match.Groups["id"].Value,
                        NumberStyles.None,
                        CultureInfo.InvariantCulture,
                        out int buildId
                    )
                )
                {
                    return buildId;
                }
            }
        }
        catch (Exception exception)
        {
            _log.LogWarning($"Could not read the Steam app manifest: {exception.Message}");
        }

        _log.LogWarning("Steam build ID is unavailable; map-pack.json will contain gameBuildId=0.");
        return 0;
    }

    private static string Sha256File(string path)
    {
        using var stream = File.OpenRead(path);
        using SHA256 sha = SHA256.Create();
        return ToHex(sha.ComputeHash(stream));
    }

    private static string ToHex(byte[] bytes)
    {
        var result = new StringBuilder(bytes.Length * 2);
        foreach (byte value in bytes)
        {
            result.Append(value.ToString("x2", CultureInfo.InvariantCulture));
        }
        return result.ToString();
    }

    private static string SafeFileName(string value)
    {
        char[] invalid = Path.GetInvalidFileNameChars();
        var result = new StringBuilder(value.Length);
        foreach (char character in value)
        {
            result.Append(invalid.Contains(character) ? '_' : character);
        }
        return result.Length == 0 ? "unnamed" : result.ToString();
    }

    private readonly struct ActiveState
    {
        public ActiveState(GameObject gameObject, bool activeSelf)
        {
            GameObject = gameObject;
            ActiveSelf = activeSelf;
        }

        public GameObject GameObject { get; }
        public bool ActiveSelf { get; }
    }

    private readonly struct CaptureRect
    {
        private CaptureRect(float centerX, float centerZ, float size)
        {
            CenterX = centerX;
            CenterZ = centerZ;
            Size = size;
        }

        public float CenterX { get; }
        public float CenterZ { get; }
        public float Size { get; }
        public float MinX => CenterX - Size * 0.5f;
        public float MaxX => CenterX + Size * 0.5f;
        public float MinZ => CenterZ - Size * 0.5f;
        public float MaxZ => CenterZ + Size * 0.5f;

        public static CaptureRect FromBounds(Bounds bounds, float padding)
        {
            float size = Mathf.Max(bounds.size.x, bounds.size.z) + padding * 2f;
            return new CaptureRect(bounds.center.x, bounds.center.z, Mathf.Max(size, 1f));
        }
    }

    private readonly struct HeightResult
    {
        public HeightResult(string sha256, int validSamples)
        {
            Sha256 = sha256;
            ValidSamples = validSamples;
        }

        public string Sha256 { get; }
        public int ValidSamples { get; }
    }

    private sealed class Geometry
    {
        public Geometry(List<Renderer> renderers, List<Collider> colliders, List<Terrain> terrains)
        {
            Renderers = renderers;
            Colliders = colliders;
            Terrains = terrains;
            ColliderIds = new HashSet<int>(colliders.Select(collider => collider.GetInstanceID()));
        }

        public List<Renderer> Renderers { get; }
        public List<Collider> Colliders { get; }
        public List<Terrain> Terrains { get; }
        public HashSet<int> ColliderIds { get; }

        public bool TryGetBounds(out Bounds bounds)
        {
            bool found = false;
            bounds = default;

            foreach (Renderer renderer in Renderers)
            {
                AddBounds(renderer.bounds, ref bounds, ref found);
            }
            foreach (Collider collider in Colliders)
            {
                AddBounds(collider.bounds, ref bounds, ref found);
            }
            foreach (Terrain terrain in Terrains)
            {
                if (terrain.terrainData != null)
                {
                    Bounds terrainBounds = terrain.terrainData.bounds;
                    terrainBounds.center += terrain.transform.position;
                    AddBounds(terrainBounds, ref bounds, ref found);
                }
            }
            return found;
        }

        private static void AddBounds(Bounds candidate, ref Bounds total, ref bool found)
        {
            Vector3 min = candidate.min;
            Vector3 max = candidate.max;
            if (!IsFinite(min) || !IsFinite(max) || candidate.size.sqrMagnitude <= 0.000001f)
            {
                return;
            }

            if (!found)
            {
                total = candidate;
                found = true;
            }
            else
            {
                total.Encapsulate(candidate);
            }
        }

        private static bool IsFinite(Vector3 value)
        {
            return IsFinite(value.x) && IsFinite(value.y) && IsFinite(value.z);
        }

        private static bool IsFinite(float value)
        {
            return !float.IsNaN(value) && !float.IsInfinity(value);
        }
    }
}
