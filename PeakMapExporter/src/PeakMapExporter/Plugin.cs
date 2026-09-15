using System.Collections;
using BepInEx;
using BepInEx.Configuration;
using UnityEngine;

namespace PeakTrail.MapExporter;

[BepInPlugin(PluginGuid, PluginName, PluginVersion)]
public sealed class Plugin : BaseUnityPlugin
{
    public const string PluginGuid = "peaktrail.mapexporter";
    public const string PluginName = "PeakMapExporter";
    public const string PluginVersion = "0.2.0";

    private ConfigEntry<KeyboardShortcut> _exportKey = null!;
    private ConfigEntry<string> _outputDirectory = null!;
    private ConfigEntry<int> _textureResolution = null!;
    private ConfigEntry<int> _heightResolution = null!;
    private ConfigEntry<float> _boundsPadding = null!;
    private ConfigEntry<int> _heightRowsPerFrame = null!;
    private ConfigEntry<int> _cameraCullingMask = null!;
    private bool _isExporting;

    private void Awake()
    {
        _exportKey = Config.Bind(
            "Export",
            "Hotkey",
            new KeyboardShortcut(KeyCode.F8),
            "Export the currently loaded PEAK map scene."
        );
        _outputDirectory = Config.Bind(
            "Export",
            "OutputDirectory",
            System.IO.Path.Combine(Paths.BepInExRootPath, "PeakMapExporter", "exports"),
            "Destination for generated map-pack directories."
        );
        _textureResolution = Config.Bind(
            "Capture",
            "TextureResolution",
            2048,
            "Square PNG resolution for each segment (256-8192)."
        );
        _heightResolution = Config.Bind(
            "Capture",
            "HeightResolution",
            512,
            "Square float32 height-field resolution for each segment (64-2048)."
        );
        _boundsPadding = Config.Bind(
            "Capture",
            "BoundsPaddingMeters",
            5f,
            "Padding around the square XZ capture bounds."
        );
        _heightRowsPerFrame = Config.Bind(
            "Capture",
            "HeightRowsPerFrame",
            8,
            "Height-field rows processed per rendered frame. Lower values reduce long frame stalls."
        );
        _cameraCullingMask = Config.Bind(
            "Capture",
            "CameraCullingMask",
            ~(1 << 5),
            "Unity layer mask used by the temporary top-down camera. The default excludes UI."
        );

        Logger.LogInfo($"{PluginName} loaded. Press {_exportKey.Value} in a generated map scene to export it.");
    }

    private void Update()
    {
        if (!_exportKey.Value.IsDown())
        {
            return;
        }

        if (_isExporting)
        {
            Logger.LogWarning("A map export is already running.");
            return;
        }

        if (!MapHandler.Exists || MapHandler.Instance == null || MapHandler.Instance.segments == null)
        {
            Logger.LogWarning("No initialized MapHandler is present. Load a generated PEAK map first.");
            return;
        }

        StartCoroutine(Export());
    }

    private IEnumerator Export()
    {
        _isExporting = true;
        try
        {
            var settings = new ExportSettings(
                _outputDirectory.Value,
                Mathf.Clamp(_textureResolution.Value, 256, 8192),
                Mathf.Clamp(_heightResolution.Value, 64, 2048),
                Mathf.Max(0f, _boundsPadding.Value),
                Mathf.Clamp(_heightRowsPerFrame.Value, 1, 128),
                _cameraCullingMask.Value
            );

            var exporter = new MapPackExporter(Logger, settings);
            yield return exporter.ExportCurrentScene();
        }
        finally
        {
            _isExporting = false;
        }
    }
}
