// Build with dotnet build -c Release -p:PeakGameRoot=<isolated-game>. Copy the DLL from
// %TEMP%/PeakTrail/AirportFloorBake/bin/Release/netstandard2.1 to that game's BepInEx/plugins.
// Run PEAK.exe -batchmode -force-d3d11 -screen-width 640 -screen-height 480 -screen-fullscreen 0
// --peak-airport-floor "<new floor PNG>" or --peak-airport-mat "<new practice mats PNG>" (or both).
// The bake needs the graphics device even in batch mode.
using System;
using System.Collections;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using BepInEx;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;
using UnityEngine.SceneManagement;

[BepInPlugin("peaktrail.tools.airportfloor", "Airport Floor Bake", "1.0.0")]
public sealed class AirportFloorBake : BaseUnityPlugin
{
    private const string FloorOption = "--peak-airport-floor";
    private const string MatOption = "--peak-airport-mat";
    private const string SceneSha256 = "f1228b42b888d4db681c65eb4f9f6566f1f56589632488eb12a040ced767f3bd";
    private const int BakeLayer = 27;
    private const int Width = 1408;
    private const int Height = 1728;
    private string floorDestination;
    private string matDestination;

    private void Awake()
    {
        string[] args = Environment.GetCommandLineArgs();
        if (!args.Contains(FloorOption) && !args.Contains(MatOption))
        {
            enabled = false;
            return;
        }
        try
        {
            floorDestination = ReadOutput(args, FloorOption);
            matDestination = ReadOutput(args, MatOption);
            if (string.Equals(floorDestination, matDestination, StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("Use distinct filenames for the floor and mats.");
            using var input = File.OpenRead(Path.Combine(Application.dataPath, "level3"));
            using var sha = SHA256.Create();
            string actual = BitConverter.ToString(sha.ComputeHash(input)).Replace("-", "");
            if (!string.Equals(actual, SceneSha256, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("The airport layout and bake framing target PEAK build 26542162.");

            QualitySettings.vSyncCount = 0;
            Application.targetFrameRate = 30;
            StartCoroutine(Run());
        }
        catch (Exception error)
        {
            Fail(error);
        }
    }

    private static string ReadOutput(string[] args, string flag)
    {
        int index = Array.IndexOf(args, flag);
        if (index < 0) return null;
        if (index + 1 >= args.Length || Array.LastIndexOf(args, flag) != index ||
            !string.Equals(Path.GetExtension(args[index + 1]), ".png", StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Supply one PNG path after " + flag);
        string path = Path.GetFullPath(args[index + 1]);
        if (File.Exists(path) || !Directory.Exists(Path.GetDirectoryName(path)))
            throw new IOException("Use a new PNG filename in an existing directory.");
        return path;
    }

    private void Update()
    {
        if (Time.realtimeSinceStartup > 95)
            Fail(new TimeoutException("Timed out preparing the airport scene."));
    }

    private void Fail(Exception error)
    {
        enabled = false;
        Logger.LogError(error);
        Application.Quit(1);
    }

    private IEnumerator Run()
    {
        yield return new WaitForSecondsRealtime(6);
        if (!SceneManager.GetSceneByName("Airport").isLoaded)
        {
            var loading = SceneManager.LoadSceneAsync("Airport", LoadSceneMode.Additive);
            if (loading == null)
            {
                Fail(new InvalidOperationException("Could not load the airport."));
                yield break;
            }
            yield return loading;
        }
        Scene airport = SceneManager.GetSceneByName("Airport");
        if (!airport.isLoaded || !SceneManager.SetActiveScene(airport))
        {
            Fail(new InvalidOperationException("Could not activate the airport."));
            yield break;
        }
        // Let the original behaviours enable their cameras, volumes and indoor lighting.
        for (int i = 0; i < 10; i++)
            yield return null;

        try
        {
            Bake(airport);
            enabled = false;
            Application.Quit(0);
        }
        catch (Exception error)
        {
            Fail(error);
        }
    }

    private void Bake(Scene airport)
    {
        GameObject[] roots = airport.GetRootGameObjects();
        Camera native = roots.SelectMany(root => root.GetComponentsInChildren<Camera>(true))
            .First(camera => camera.name == "MainCamera");
        var source = native.GetComponent<UniversalAdditionalCameraData>();
        if (!source || !(GraphicsSettings.currentRenderPipeline is UniversalRenderPipelineAsset))
            throw new InvalidOperationException("The native URP camera is required.");

        foreach (var light in Resources.FindObjectsOfTypeAll<Light>())
        {
            if (!light.gameObject.scene.IsValid()) continue;
            if (light.gameObject.scene == airport)
                light.cullingMask |= 1 << BakeLayer;
            else
                light.enabled = false;
        }
        var renderers = roots.SelectMany(root => root.GetComponentsInChildren<MeshRenderer>(true))
            .Where(renderer => renderer.enabled && renderer.gameObject.activeInHierarchy).ToArray();
        var originalModes = renderers.Select(renderer => renderer.shadowCastingMode).ToArray();
        var paths = renderers.Select(renderer => HierarchyPath(renderer.transform)).ToArray();
        foreach (var renderer in renderers)
            renderer.gameObject.layer = BakeLayer;

        var camera = new GameObject("Airport floor bake camera").AddComponent<Camera>();
        camera.enabled = false;
        camera.transform.SetPositionAndRotation(new Vector3(4, 3.71f, 98), Quaternion.Euler(90, 0, 0));
        // World X [-40, 48], Z [44, 152], at 16 pixels per world unit.
        camera.orthographic = true;
        camera.orthographicSize = 54;
        camera.aspect = 88f / 108;
        camera.farClipPlane = 8;
        camera.clearFlags = CameraClearFlags.SolidColor;
        camera.backgroundColor = Color.clear;
        camera.cullingMask = 1 << BakeLayer;
        camera.allowHDR = native.allowHDR;
        camera.allowMSAA = false;
        camera.useOcclusionCulling = false;
        var settings = camera.GetUniversalAdditionalCameraData();
        settings.renderPostProcessing = source.renderPostProcessing;
        settings.renderShadows = source.renderShadows;
        settings.volumeLayerMask = source.volumeLayerMask;
        settings.antialiasing = source.antialiasing;
        Logger.LogInfo($"Renderer {SystemInfo.graphicsDeviceName}, HDR {camera.allowHDR}, post {settings.renderPostProcessing}, shadows {settings.renderShadows}, AA {settings.antialiasing}");
        if (floorDestination != null)
            RenderSurface(camera, floorDestination, 2.62f, renderers, originalModes, paths, IsFloor);
        if (matDestination != null)
        {
            // The native camera uses TAA; a different set of surfaces gets its own history.
            if (floorDestination != null) settings.resetHistory = true;
            RenderSurface(camera, matDestination, 1.23f, renderers, originalModes, paths,
                path => path.StartsWith("Map/Climbing Wall/Mat/", StringComparison.Ordinal));
        }
        Destroy(camera.gameObject);
    }

    private void RenderSurface(Camera camera, string destination, float nearClip, MeshRenderer[] renderers,
        ShadowCastingMode[] originalModes, string[] paths, Func<string, bool> include)
    {
        for (int i = 0; i < renderers.Length; i++)
            renderers[i].shadowCastingMode = include(paths[i]) ? originalModes[i] : ShadowCastingMode.ShadowsOnly;
        camera.nearClipPlane = nearClip;
        SaveImage(camera, destination);
        Logger.LogInfo("Wrote " + destination);
    }

    private static string HierarchyPath(Transform child)
    {
        return child.parent ? HierarchyPath(child.parent) + "/" + child.name : child.name;
    }

    private static bool IsFloor(string path)
    {
        const string structure = "Map/BL_Airport/Main Meshes/";
        return path == "Court" || path == "Chess/Plane" ||
            path == structure + "Airport" || path.StartsWith(structure + "Airport/", StringComparison.Ordinal) ||
            path == structure + "Carpet" || path.StartsWith(structure + "Carpet/", StringComparison.Ordinal) ||
            path == structure + "Airstrip" || path == structure + "Outside grid" || path == structure + "Outside grid (1)";
    }

    private void SaveImage(Camera camera, string destination)
    {
        var previous = RenderTexture.active;
        var target = RenderTexture.GetTemporary(Width, Height, 24, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB);
        var pixels = new Texture2D(Width, Height, TextureFormat.RGBA32, false);
        try
        {
            camera.targetTexture = target;
            camera.Render();
            RenderTexture.active = target;
            pixels.ReadPixels(new Rect(0, 0, Width, Height), 0, 0);
            pixels.Apply();
            byte[] png = pixels.EncodeToPNG();
            string temporary = destination + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                File.WriteAllBytes(temporary, png);
                File.Move(temporary, destination);
            }
            finally
            {
                if (File.Exists(temporary)) File.Delete(temporary);
            }
        }
        finally
        {
            camera.targetTexture = null;
            RenderTexture.active = previous;
            RenderTexture.ReleaseTemporary(target);
            Destroy(pixels);
        }
    }
}
