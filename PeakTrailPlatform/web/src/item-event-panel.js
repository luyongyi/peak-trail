import { tr, onLocaleChange } from './i18n.js';
import { loadGameAssetPack, resolveItemAsset } from './game-assets.js';
import { itemEventKind, itemEventName, itemEventTime, loadTeamItemEvents, relatedUseEvent, MAX_ITEM_MARKERS } from './item-events.js';

const INDEX_URL = new URL('../data/item-event-assets/catalog.json', import.meta.url);
export function createItemEventPanel({ getContext, getScene, root = document, fetchImpl, loadAssets = loadGameAssetPack } = {}) {
  const $ = id => root.getElementById(id);
  const button = $('itemEventsToggle'), card = $('itemEventCard'), status = $('itemEventStatus');
  let enabled = true, disposed = false, key = null, request = null, revision = 0, events = [], truncated = false;
  let selectedId = null, pack = null, packBuild = null, loading = false, failed = false;
  const packs = new Map(), listeners = [];
  const listen = (element, name, fn) => { element?.addEventListener(name, fn); listeners.push(() => element?.removeEventListener(name, fn)); };
  function select(id) { selectedId = id; getScene()?.selectItemEvent(id); render(); }
  function render() {
    if (disposed) return;
    const context = getContext(), active = context.enabled && enabled;
    button.hidden = !context.enabled; button.textContent = tr('道具事件', 'Item events'); button.setAttribute('aria-pressed', String(enabled));
    const event = active && events.find(value => value.id === selectedId);
    card.hidden = !event;
    status.hidden = !active;
    status.textContent = loading ? tr('读取道具事件…', 'Loading item events…') : failed ? tr('道具事件暂时无法读取，切换开关可重试。', 'Item events unavailable. Toggle this layer to retry.')
      : context.stageIndex == null && !context.live ? tr('选择关卡查看道具事件。', 'Choose a chapter to view item events.')
      : events.length ? (truncated || events.length > MAX_ITEM_MARKERS ? (!context.live || context.persistence === 'durable' ? tr('道具事件 · 显示有限标记，更多事件保存在轨迹中', 'Item events · Markers limited; more events remain in the recording') : tr('道具事件 · 仅显示有限的近期标记', 'Item events · Showing a limited set of recent markers')) : tr('道具事件 · 点击标记查看记录位置', 'Item events · Tap a marker for its recorded location'))
      : tr('本关暂无道具事件', 'No item events in this chapter');
    if (!event) return;
    $('itemEventName').textContent = itemEventName(event);
    const name = event.playerName || context.participants?.find(value => value.id === event.playerKey)?.nickname || (event.playerKey ? tr('未命名玩家', 'Unnamed player') : tr('使用者未知', 'Unknown player'));
    $('itemEventMeta').textContent = `${name} · ${itemEventTime(event)} · ${itemEventKind(event)}`;
    $('itemEventNote').textContent = tr('记录发生时的位置；小模型仅作标记，不表示道具现在仍在场。', 'Location when recorded. Miniatures are markers and do not imply the item is still present.');
    const icon = resolveItemAsset(pack, event.item)?.iconUrl, image = $('itemEventIcon');
    image.hidden = !icon; if (icon && image.getAttribute('src') !== icon) image.src = icon;
    $('itemEventUse').hidden = !relatedUseEvent(events, event); $('itemEventUse').textContent = tr('查看使用点', 'View use point');
    $('itemEventLocate').textContent = tr('靠近记录位置', 'View recorded location');
    $('itemEventClose').textContent = tr('关闭', 'Close');
  }
  function apply() {
    const context = getContext();
    getScene()?.setItemEvents({ ...context, enabled: context.enabled && enabled, events, pack,
      timeMs: context.timeMs ?? Infinity });
    render();
  }
  function syncAssets(context) {
    const build = String(context.gameBuildId || '');
    if (!build) return;
    if (build === packBuild) {
      if (!pack && String(context.fallbackPack?.gameBuildId) === build) pack = context.fallbackPack;
      return;
    }
    packBuild = build; pack = null;
    if (!packs.has(build)) packs.set(build, loadAssets(build, { indexUrl: INDEX_URL }).catch(() => null));
    void packs.get(build).then(value => {
      if (disposed || packBuild !== build) return;
      const fallback = getContext().fallbackPack;
      pack = value || (String(fallback?.gameBuildId) === build ? fallback : null); apply();
    });
  }
  function sync() {
    if (disposed) return;
    const context = getContext();
    const nextKey = context.enabled ? context.live ? context.trace : JSON.stringify([context.teamId, context.groupId, context.stageIndex, context.teamRevision, context.mapPackId, context.alignmentId]) : null;
    if (nextKey !== key) {
      key = nextKey; request?.abort(); request = null; ++revision; events = []; truncated = false; selectedId = null; loading = false; failed = false;
      getScene()?.selectItemEvent(null);
    }
    if (!context.enabled || !enabled) { apply(); return; }
    syncAssets(context);
    if (context.live) { events = context.trace?.itemEvents || []; truncated = Boolean(context.trace?.itemEventsTruncated); apply(); return; }
    if (context.ready && context.stageIndex != null && !request && !failed) {
      request = new AbortController(); const token = revision; loading = true;
      void loadTeamItemEvents(context, { fetchImpl, signal: request.signal }).then(result => {
        if (disposed || revision !== token) return;
        events = result.events; truncated = result.truncated; loading = false; apply();
      }).catch(error => {
        if (disposed || revision !== token || error?.name === 'AbortError') return;
        loading = false; failed = true; apply();
      });
    }
    apply();
  }
  listen(button, 'click', () => { enabled = !enabled; if (enabled && failed) { request = null; failed = false; } sync(); });
  listen($('sceneCanvas'), 'peaktrail-item-event', event => select(event.detail?.id || null));
  listen($('itemEventClose'), 'click', () => select(null));
  listen($('itemEventLocate'), 'click', () => { const event = events.find(value => value.id === selectedId); if (event) getScene()?.focusItemEvent(event); });
  listen($('itemEventUse'), 'click', () => { const use = relatedUseEvent(events, events.find(value => value.id === selectedId)); if (use) getScene()?.focusItemEvent(use); });
  listen($('itemEventIcon'), 'error', () => { $('itemEventIcon').hidden = true; });
  const unlocale = onLocaleChange(render);
  return { sync, dispose() { disposed = true; ++revision; request?.abort(); listeners.forEach(remove => remove()); unlocale(); } };
}
