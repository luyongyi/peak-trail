import { buildHomeDailyView } from "./home-daily.js";
import { HOME_ART, HOME_ENDINGS } from "./home-art.js";
import { getLocale, onLocaleChange, tr } from "./i18n.js";

const COPY = {
  shore: "SHORE",
  roots: "ROOTS",
  tropics: "TROPICS",
  alpine: "ALPINE",
  mesa: "MESA",
  volcano: "CALDERA",
  swamp: "GLOOM",
};

/** A separate daily presentation: importing a replay must never replace its map. */
export class HomePage {
  constructor({ root, loadCatalog, loadMapPack, onExplore, onRefresh }) {
    this.root = root;
    this.loadCatalog = loadCatalog;
    this.loadMapPack = loadMapPack;
    this.onExplore = onExplore;
    this.visible = true;
    this.revision = 0;
    this.cells = [...root.querySelectorAll('.home-chapter')];
    this.buttons = this.cells.map(cell => cell.querySelector('button'));
    this.$ = id => root.querySelector(`#${id}`);
    this.buttons.slice(0, 4).forEach((button, segment) => button.addEventListener('click', () => {
      // Re-evaluate the deadline on the action, even if the browser was sleeping.
      const view = this.view();
      if (view.cards[segment]?.available && this.mapPack) this.onExplore(this.mapPack, segment, view);
    }));
    this.$('homeEndingExplore').addEventListener('click', () => {
      const view = this.view();
      const ending = view.cards[3]?.ending;
      if (ending && this.mapPack) this.onExplore(this.mapPack, ending.segment, view);
    });
    for (const id of ['peak', 'nadir']) {
      this.$(`home-${id}-explore`).addEventListener('click', () => {
        const view = this.view();
        const destination = view.destinations.find(item => item.id === id);
        if (destination?.available && this.mapPack) this.onExplore(this.mapPack, destination.segment, view,
          { destinationId: destination.id, viewIntent: destination.viewIntent || null });
      });
    }
    this.$('homeRefresh').addEventListener('click', async () => {
      this.$('homeRefresh').disabled = true;
      try { await onRefresh(); } finally { this.$('homeRefresh').disabled = false; }
    });
    this.onVisibility = () => {
      this.tick();
    };
    document.addEventListener('visibilitychange', this.onVisibility);
    this.clock = setInterval(() => { if (this.visible && !document.hidden) this.tick(); }, 1000);
    this.stopLocaleListener = onLocaleChange(() => { if (!this.disposed) this.tick(); });
    this.tick();
  }

  view() { return buildHomeDailyView({ daily: this.daily, catalog: this.catalog, mapPack: this.mapPack }); }

  async update(daily) {
    const revision = ++this.revision;
    this.daily = daily;
    this.error = null;
    this.tick();
    try {
      const { catalog, baseUrl } = await this.loadCatalog();
      if (revision !== this.revision) return;
      this.catalog = catalog;
      const entry = this.view().mapEntry;
      if (!entry) {
        this.mapPack = null;
        this.tick();
        return;
      }
      if (this.mapPack?.mapPackId !== entry.mapPackId) {
        this.mapPack = null;
        this.tick();
        const map = await this.loadMapPack(new URL(entry.path, baseUrl).href);
        if (revision !== this.revision) { map.disposeAssets?.(); return; }
        const checked = buildHomeDailyView({ daily: this.daily, catalog, mapPack: map });
        if (checked.mapStatus === 'identity-mismatch') throw new Error(tr('轮换与模型身份不一致', 'The daily rotation and map identities do not match'));
        this.mapPack = map;
      }
      this.tick();
    } catch (error) {
      if (revision !== this.revision) return;
      this.error = error?.message || tr('地图暂不可用', 'Map temporarily unavailable');
      this.tick();
    }
  }

  tick() {
    const view = this.view();
    const now = new Date();
    const dateParts = new Intl.DateTimeFormat(getLocale(), { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit' }).formatToParts(now);
    this.$('homeDate').textContent = ['month', 'day'].map(type => dateParts.find(part => part.type === type).value).join('.');
    this.$('homeDate').dateTime = now.toISOString();
    this.$('homeDateMeta').textContent = `${new Intl.DateTimeFormat(getLocale(), { timeZone: 'Asia/Shanghai', year: 'numeric', weekday: 'long' }).format(now)}${tr(' · 北京时间', ' · Beijing time (UTC+8)')}`;
    this.$('homeStatus').textContent = view.statusLabel;
    this.$('homeRouteLabel').textContent = view.sceneName ? `${view.isCurrent ? tr('本轮路线', 'Current rotation') : tr('上次确认', 'Last confirmed')} / ${view.sceneName} · ${String(this.daily.levelIndex).padStart(3, '0')}` : tr('等待确认本轮路线', 'Waiting for the current rotation');
    this.$('homeCountdown').textContent = view.isCurrent ? tr(`${view.countdownLabel} 后轮换`, `Next rotation in ${view.countdownLabel}`) : view.countdownLabel;
    this.$('homeCountdown').title = view.rotationLabel ? tr(`接口报告的轮换时间：${view.rotationLabel}（北京时间）`, `Reported rotation time: ${view.rotationLabel} (Beijing time, UTC+8)`) : '';
    this.root.dataset.freshness = view.freshness;
    for (const card of view.cards) {
      const cell = this.cells[card.segment], button = this.buttons[card.segment];
      cell.dataset.theme = card.theme;
      button.disabled = !card.available;
      button.setAttribute('aria-label', tr(`${view.isCurrent ? '查看本轮' : '查看上次确认的'}第${card.segment + 1}关：${card.title}`, `View ${view.isCurrent ? 'current' : 'last confirmed'} chapter ${card.segment + 1}: ${card.title}`));
      cell.querySelector('.home-biome-title').textContent = card.title;
      cell.querySelector('.home-biome-en').textContent = COPY[card.biome] || `CHAPTER ${card.ordinal}`;
      const img = cell.querySelector('img');
      const url = card.available ? HOME_ART[card.biome] : null;
      if (url && img.getAttribute('src') !== url) img.src = url;
      img.hidden = !url;
      img.alt = url ? tr(`${card.title}区域插画`, `${card.title} area illustration`) : '';
      cell.querySelector('.home-model-status').textContent = card.available ? '' : tr('等待确认', 'Awaiting confirmation');
    }
    const ending = view.cards[3]?.ending;
    const finale = HOME_ENDINGS[ending?.branch];
    const finaleElement = this.$('homeFinale');
    finaleElement.dataset.branch = ending?.branch || '';
    finaleElement.dataset.theme = ending?.branch === 'swamp-temple' ? 'swamp' : ending?.branch === 'volcano-kiln' ? 'volcano' : 'unknown';
    finaleElement.hidden = !finale;
    const finaleButton = this.$('homeEndingExplore');
    finaleButton.disabled = !finale;
    finaleButton.setAttribute('aria-label', finale && ending ? tr(`${view.isCurrent ? '查看本轮' : '查看上次确认的'}第5关：${ending.title}`, `View ${view.isCurrent ? 'current' : 'last confirmed'} chapter 5: ${ending.title}`) : tr('终段等待路线确认', 'Final chapter awaiting route confirmation'));
    this.$('homeEnding').textContent = ending?.title || tr('终段待确认', 'Final chapter unconfirmed');
    this.$('homeEndingEnglish').textContent = finale?.english || 'FINAL ASCENT';
    this.$('homeEndingStatus').textContent = finale ? '' : tr('等待路线确认', 'Awaiting route confirmation');
    const finaleArt = this.$('homeEndingArt');
    if (finale && finaleArt.getAttribute('src') !== finale.art) finaleArt.src = finale.art;
    finaleArt.hidden = !finale;
    finaleArt.alt = ending ? tr(`${ending.title}内部区域插画`, `${ending.title} interior illustration`) : '';
    for (const destination of view.destinations) {
      const art = this.$(`home-${destination.id}-art`);
      // These are alternative ending illustrations, not evidence that this
      // daily map or a recording has visited/selected either ending.
      const url = HOME_ART[destination.id];
      if (art.getAttribute('src') !== url) art.src = url;
      art.alt = tr(`${destination.title}结局区域插画`, `${destination.title} ending illustration`);
      const button = this.$(`home-${destination.id}-explore`);
      button.disabled = !destination.available;
      button.textContent = destination.actionLabel;
      button.setAttribute('aria-label', tr(`${view.isCurrent ? '本轮' : '上次确认的地图'}：${destination.actionLabel}`, `${view.isCurrent ? 'Current rotation' : 'Last confirmed map'}: ${destination.actionLabel}`));
    }
  }

  setVisible(visible) {
    this.visible = Boolean(visible);
    if (this.visible) this.tick();
  }

  dispose() {
    this.disposed = true;
    this.revision++;
    clearInterval(this.clock);
    this.stopLocaleListener?.();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.mapPack?.disposeAssets?.();
  }
}
