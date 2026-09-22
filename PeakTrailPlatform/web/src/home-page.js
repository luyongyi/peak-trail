import { buildHomeDailyView } from "./home-daily.js";
import { HOME_ART, HOME_ENDINGS } from "./home-art.js";

const COPY = {
  shore: ["SHORE", "海风、礁石与出发的地方"],
  roots: ["ROOTS", "沿着盘根错节的山壁向上"],
  tropics: ["TROPICS", "穿过树冠，走进山野深处"],
  alpine: ["ALPINE", "越过雪线，继续向高处走"],
  mesa: ["MESA", "台地与峡谷之间的攀登"],
  volcano: ["CALDERA", "穿过熔岩平原与低矮岩丘"],
  swamp: ["GLOOM", "贴地浓雾中，穿过低平湿地"],
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
    this.buttons.forEach((button, segment) => button.addEventListener('click', () => {
      // Re-evaluate the deadline on the action, even if the browser was sleeping.
      const view = this.view();
      if (view.cards[segment]?.available && this.mapPack) this.onExplore(this.mapPack, segment, view);
    }));
    this.$('homeRefresh').addEventListener('click', async () => {
      this.$('homeRefresh').disabled = true;
      try { await onRefresh(); } finally { this.$('homeRefresh').disabled = false; }
    });
    this.onVisibility = () => {
      this.tick();
    };
    document.addEventListener('visibilitychange', this.onVisibility);
    this.clock = setInterval(() => { if (this.visible && !document.hidden) this.tick(); }, 1000);
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
        if (checked.mapStatus === 'identity-mismatch') throw new Error('轮换与模型身份不一致');
        this.mapPack = map;
      }
      this.tick();
    } catch (error) {
      if (revision !== this.revision) return;
      this.error = error?.message || '地图暂不可用';
      this.tick();
    }
  }

  tick() {
    const view = this.view();
    const now = new Date();
    this.$('homeDate').textContent = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit' })
      .format(now).split('/').slice(0, 2).reverse().join('.');
    this.$('homeDate').dateTime = now.toISOString();
    this.$('homeDateMeta').textContent = `${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', weekday: 'long' }).format(now)} · 北京时间`;
    this.$('homeStatus').textContent = view.statusLabel;
    this.$('homeRouteLabel').textContent = view.sceneName ? `${view.isCurrent ? '本轮路线' : '上次确认'} / ${view.sceneName} · ${String(this.daily.levelIndex).padStart(3, '0')}` : '等待确认本轮路线';
    this.$('homeCountdown').textContent = view.isCurrent ? `${view.countdownLabel} 后轮换` : view.countdownLabel;
    this.$('homeCountdown').title = view.rotationLabel ? `接口报告的轮换时间：${view.rotationLabel}（北京时间）` : '';
    this.$('homeDescription').textContent = view.freshness === 'stale'
      ? '新一轮尚未同步，以下保留上次确认的地图，不代表今日关卡。'
      : '从海岸出发，把沿途的每一次攀登留在地图上。';
    this.root.dataset.freshness = view.freshness;
    for (const card of view.cards) {
      const cell = this.cells[card.segment], button = this.buttons[card.segment];
      cell.dataset.theme = card.theme;
      button.disabled = !card.available;
      button.setAttribute('aria-label', `${view.isCurrent ? '查看本轮' : '查看上次确认的'}第${card.segment + 1}关：${card.title}`);
      cell.querySelector('.home-biome-title').textContent = card.title;
      cell.querySelector('.home-biome-en').textContent = COPY[card.biome]?.[0] || `CHAPTER ${card.ordinal}`;
      cell.querySelector('.home-biome-detail').textContent = card.ending ? `${COPY[card.biome]?.[1] || ''} · 通往${card.ending.title}` : COPY[card.biome]?.[1] || '等待真实关卡数据';
      const img = cell.querySelector('img');
      const url = card.available ? HOME_ART[card.biome] : null;
      if (url && img.getAttribute('src') !== url) img.src = url;
      img.hidden = !url;
      img.alt = url ? `${card.title}主题氛围插画，并非本轮地图实景` : '';
      cell.querySelector('.home-model-status').textContent = card.available ? '' : '等待确认';
    }
    const ending = view.cards[3]?.ending;
    const finale = HOME_ENDINGS[ending?.branch];
    const finaleElement = this.$('homeFinale');
    // Close a previously expanded illustration when rotation changes its ending.
    if (finaleElement.dataset.branch !== (ending?.branch || '')) finaleElement.open = false;
    finaleElement.dataset.branch = ending?.branch || '';
    finaleElement.hidden = !finale;
    this.$('homeEnding').textContent = ending?.title || '终章待确认';
    this.$('homeEndingRoute').textContent = ending ? `${view.cards[3].title}之后 / ${finale?.english || ''}` : '';
    this.$('homeEndingDescription').textContent = finale?.description || '';
    for (const id of ['homeEndingThumb', 'homeEndingArt']) {
      const img = this.$(id);
      if (finale && img.getAttribute('src') !== finale.art) img.src = finale.art;
      img.alt = id === 'homeEndingArt' && ending ? `${ending.title}内部攀登空间主题插画，非地图实景` : '';
    }
    this.$('homeEvidence').textContent = this.error ? `路线暂不可用 · ${this.error}`
      : view.mapStatus === 'ready' ? `AI 主题插画 · 非地图实景 · 轮换于 ${view.observedLabel} 确认`
        : view.mapStatus === 'missing-build' ? '本轮地图尚无匹配的版本资源，未借用其他地图。'
          : view.mapStatus === 'route-unconfirmed' ? '部分路线待确认，未推测互斥关卡。'
            : '正在确认本轮关卡组合…';
  }

  setVisible(visible) {
    this.visible = Boolean(visible);
    if (this.visible) this.tick();
  }

  dispose() {
    this.disposed = true;
    this.revision++;
    clearInterval(this.clock);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.mapPack?.disposeAssets?.();
  }
}
