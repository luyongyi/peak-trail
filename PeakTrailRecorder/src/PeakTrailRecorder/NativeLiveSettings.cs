using System;
using System.Collections.Generic;
using BepInEx.Configuration;
using BepInEx.Logging;
using HarmonyLib;
using TMPro;
using UnityEngine;
using UnityEngine.Localization;
using UnityEngine.UI;
using Zorro.Core;
using Zorro.Settings;
using Zorro.Settings.UI;

namespace PeakTrailRecorder;

/// <summary>Registers real PEAK settings, rendered by the game's own settings prefabs.</summary>
internal static class NativeLiveSettings
{
    private const string ToggleLabel = "PEAKTRAIL_LIVE_PATHS";
    private const string CodeLabel = "PEAKTRAIL_LIVE_CODE";
    private const string LinkLabel = "PEAKTRAIL_LIVE_LINK";
    private static ConfigEntry<bool>? _enabled;
    private static Func<string?>? _watchCode;
    private static Func<string?>? _watchUrl;
    private static Func<string?>? _status;
    private static ManualLogSource? _log;
    private static Harmony? _harmony;
    private static SettingsHandler? _registeredHandler;
    private static float _copiedUntil;
    private static string? _copiedValue;
    private static event Action? RefreshRequested;
    private static GameObject? _linkTemplateRoot;
    private static GameObject? _linkTemplate;

    public static void Install(ConfigEntry<bool> enabled, Func<string?> watchCode, Func<string?> watchUrl,
        Func<string?> status, ManualLogSource log)
    {
        _enabled = enabled;
        _watchCode = watchCode;
        _watchUrl = watchUrl;
        _status = status;
        _log = log;
        _harmony = new Harmony("PeakTrailRecorder.native-live-settings");
        try
        {
            _harmony.Patch(AccessTools.Constructor(typeof(SettingsHandler), Type.EmptyTypes),
                postfix: new HarmonyMethod(typeof(NativeLiveSettings), nameof(AfterSettingsCreated)));
            _harmony.Patch(AccessTools.Method(typeof(ButtonSettingUI), nameof(ButtonSettingUI.Setup)),
                postfix: new HarmonyMethod(typeof(NativeLiveSettings), nameof(AfterButtonSetup)));
            EnsureRegistered();
        }
        catch (Exception exception)
        {
            log.LogWarning("Native live settings are unavailable: " + exception.Message);
        }
    }

    public static void EnsureRegistered()
    {
        SettingsHandler? handler = SettingsHandler.Instance;
        if (_enabled == null || handler == null || ReferenceEquals(handler, _registeredHandler)) return;
        try
        {
            RegisterLabels();
            if (handler.GetSetting<LivePathsSetting>() == null) handler.AddSetting(new LivePathsSetting());
            if (handler.GetSetting<LiveWatchCodeSetting>() == null) handler.AddSetting(new LiveWatchCodeSetting());
            if (handler.GetSetting<LiveWatchLinkSetting>() == null) handler.AddSetting(new LiveWatchLinkSetting());
            _registeredHandler = handler;
        }
        catch (Exception exception)
        {
            // Early startup can precede localization resources. Retry when the game is ready.
            if (Time.frameCount % 600 == 0) _log?.LogWarning("Waiting for native settings: " + exception.Message);
        }
    }

    private static void AfterSettingsCreated() => EnsureRegistered();

    private static void AfterButtonSetup(ButtonSettingUI __instance, Setting setting)
    {
        if (setting is not LiveCopySetting copySetting) return;
        var presenter = __instance.gameObject.GetComponent<LiveLinkPresenter>();
        if (presenter == null) presenter = __instance.gameObject.AddComponent<LiveLinkPresenter>();
        presenter.Cell = __instance;
        presenter.CopiesCode = copySetting.CopiesCode;
        presenter.Refresh();
    }

    public static void Uninstall()
    {
        _harmony?.UnpatchSelf();
        _harmony = null;
        _registeredHandler = null;
        _enabled = null;
        _watchCode = null;
        _watchUrl = null;
        _status = null;
        _copiedValue = null;
        RefreshRequested = null;
        if (_linkTemplateRoot != null) UnityEngine.Object.Destroy(_linkTemplateRoot);
        _linkTemplateRoot = null;
        _linkTemplate = null;
    }

    private static void RegisterLabels()
    {
        var table = LocalizedText.mainTable;
        int count = Enum.GetValues(typeof(LocalizedText.Language)).Length;
        var toggle = new List<string>(count);
        var code = new List<string>(count);
        var link = new List<string>(count);
        for (int index = 0; index < count; index++)
        {
            var language = (LocalizedText.Language)index;
            toggle.Add(language == LocalizedText.Language.SimplifiedChinese ? "路径直播"
                : language == LocalizedText.Language.TraditionalChinese ? "路徑直播" : "Live path sharing");
            code.Add(language == LocalizedText.Language.SimplifiedChinese ? "直播码"
                : language == LocalizedText.Language.TraditionalChinese ? "直播碼" : "Live code");
            link.Add(language == LocalizedText.Language.SimplifiedChinese ? "直播观看链接"
                : language == LocalizedText.Language.TraditionalChinese ? "直播觀看連結" : "Live viewing link");
        }
        table[ToggleLabel] = toggle;
        table[CodeLabel] = code;
        table[LinkLabel] = link;
    }

    private static bool Chinese => LocalizedText.CURRENT_LANGUAGE == LocalizedText.Language.SimplifiedChinese
        || LocalizedText.CURRENT_LANGUAGE == LocalizedText.Language.TraditionalChinese;

    private static string? CopyValue(bool copiesCode) => copiesCode ? _watchCode?.Invoke() : _watchUrl?.Invoke();

    private static bool WasCopied(string? value) => value != null && value == _copiedValue
        && Time.unscaledTime < _copiedUntil;

    private static string ButtonText(bool copiesCode, bool enabled, string? value, string? status, bool copied)
    {
        // A stale copy acknowledgement must never hide an off/waiting state or a new code.
        if (!enabled) return Chinese ? "直播已关闭" : "Sharing off";
        if (!string.IsNullOrEmpty(value))
        {
            if (copiesCode) return value + (copied ? (Chinese ? " · 已复制" : " · Copied")
                : (Chinese ? " · 点击复制" : " · Copy"));
            return copied ? (Chinese ? "已复制" : "Copied") : (Chinese ? "复制链接" : "Copy link");
        }
        if (string.IsNullOrEmpty(status) || status == nameof(LivePublisherStatus.WaitingForRun))
            return Chinese ? "等待进入对局" : "Waiting for a run";
        if (copiesCode && (status == nameof(LivePublisherStatus.Live) || status == nameof(LivePublisherStatus.Standby)))
            return Chinese ? "直播码暂不可用" : "Code unavailable";
        return Chinese ? "正在连接…" : "Connecting…";
    }

    private static void ApplyEnabled(bool enabled)
    {
        if (_enabled != null) _enabled.Value = enabled;
        if (!enabled) _copiedValue = null;
        RefreshRequested?.Invoke();
    }

    internal sealed class LivePathsSetting : CustomLocalizedOffOnSetting, IExposedSetting
    {
        protected override OffOnMode GetDefaultValue() => _enabled?.Value != false ? OffOnMode.ON : OffOnMode.OFF;
        public override void Load(ISettingsSaveLoad loader) => Value = GetDefaultValue();
        public override void Save(ISettingsSaveLoad saver)
        {
            ApplyEnabled(Value == OffOnMode.ON);
        }
        public override void ApplyValue()
        {
            ApplyEnabled(Value == OffOnMode.ON);
        }
        public override List<LocalizedString> GetLocalizedChoices() => null!;
        public string GetDisplayName() => ToggleLabel;
        public string GetCategory() => SettingsCategory.General.ToString();
    }

    internal sealed class LiveWatchCodeSetting : LiveCopySetting
    {
        internal override bool CopiesCode => true;
    }

    internal sealed class LiveWatchLinkSetting : LiveCopySetting
    {
        internal override bool CopiesCode => false;
    }

    internal abstract class LiveCopySetting : ButtonSetting, IExposedSetting
    {
        internal abstract bool CopiesCode { get; }
        public string GetDisplayName() => CopiesCode ? CodeLabel : LinkLabel;
        public string GetCategory() => SettingsCategory.General.ToString();
        public override string GetButtonText()
        {
            string? value = CopyValue(CopiesCode);
            return ButtonText(CopiesCode, _enabled?.Value == true, value, _status?.Invoke(), WasCopied(value));
        }
        public override GameObject GetSettingUICell()
        {
            // PEAK ships the ButtonSetting type, but some builds leave its mapper
            // prefab empty. Reuse the actual game's Back button in that case.
            GameObject mapped = SingletonAsset<InputCellMapper>.Instance.ButtonSettingCell;
            if (mapped != null) return mapped;
            if (_linkTemplate != null) return _linkTemplate;
            var main = UnityEngine.Object.FindFirstObjectByType<MainMenuSettingsPage>(FindObjectsInactive.Include);
            var pause = UnityEngine.Object.FindFirstObjectByType<PauseMenuSettingsMenuPage>(FindObjectsInactive.Include);
            Button? source = main != null ? main.backButton : pause != null ? pause.backButton : null;
            if (source == null) throw new InvalidOperationException("PEAK settings button is not ready.");
            _linkTemplateRoot = new GameObject("PeakTrailNativeSettingsTemplates");
            _linkTemplateRoot.SetActive(false);
            UnityEngine.Object.DontDestroyOnLoad(_linkTemplateRoot);
            _linkTemplate = UnityEngine.Object.Instantiate(source.gameObject, _linkTemplateRoot.transform, false);
            _linkTemplate.name = "PeakTrailNativeCopyButton";
            _linkTemplate.SetActive(true);
            var rectangle = _linkTemplate.GetComponent<RectTransform>();
            rectangle.anchorMin = rectangle.anchorMax = new Vector2(0.5f, 0.5f);
            rectangle.anchoredPosition = Vector2.zero;
            rectangle.sizeDelta = source.GetComponent<RectTransform>().rect.size;
            rectangle.localScale = Vector3.one;
            foreach (LocalizedText label in _linkTemplate.GetComponentsInChildren<LocalizedText>(true)) label.enabled = false;
            var button = _linkTemplate.GetComponent<Button>();
            button.onClick = new Button.ButtonClickedEvent();
            var cell = _linkTemplate.AddComponent<ButtonSettingUI>();
            cell.Button = button;
            cell.Label = _linkTemplate.GetComponentInChildren<TextMeshProUGUI>(true);
            return _linkTemplate;
        }
        public override void OnClicked(ISettingHandler settingHandler)
        {
            string? value = CopyValue(CopiesCode);
            if (_enabled?.Value != true || string.IsNullOrWhiteSpace(value)) return;
            GUIUtility.systemCopyBuffer = value;
            _copiedValue = value;
            _copiedUntil = Time.unscaledTime + 3f;
            RefreshRequested?.Invoke();
        }
    }

    public sealed class LiveLinkPresenter : MonoBehaviour
    {
        internal ButtonSettingUI? Cell;
        internal bool CopiesCode;
        private bool _initialized;
        private bool _wasEnabled;
        private bool _wasCopied;
        private bool _wasChinese;
        private string? _lastValue;
        private string? _lastStatus;
        private void OnEnable() => RefreshRequested += Refresh;
        private void OnDisable() => RefreshRequested -= Refresh;
        private void Update() => Refresh();

        internal void Refresh()
        {
            if (Cell == null) return;
            bool enabled = _enabled?.Value == true;
            string? value = enabled ? CopyValue(CopiesCode) : null;
            string? status = enabled && value == null ? _status?.Invoke() : null;
            bool copied = enabled && WasCopied(value);
            bool chinese = Chinese;
            // Check changes every frame, but allocate text/update the canvas only when needed.
            if (_initialized && enabled == _wasEnabled && value == _lastValue && status == _lastStatus
                && copied == _wasCopied && chinese == _wasChinese) return;
            _initialized = true;
            _wasEnabled = enabled;
            _lastValue = value;
            _lastStatus = status;
            _wasCopied = copied;
            _wasChinese = chinese;
            if (Cell.Label != null) Cell.Label.text = ButtonText(CopiesCode, enabled, value, status, copied);
            if (Cell.Button != null) Cell.Button.interactable = enabled && !string.IsNullOrEmpty(value);
        }
    }
}
