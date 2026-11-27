import { resolveItemAsset } from "./game-assets.js";
import { gameItemName, tr } from "./i18n.js";
import { parseCaptureId } from "./packet-watch-client.js";

const ROOT = "/api/navigation/captures";
const CATEGORIES = {
  all: ["全部", "All", ""],
  climb: ["攀登", "Climbing", "⤴"],
  food: ["饮食", "Food", "◒"],
  medical: ["医疗", "Medical", "✚"],
  gear: ["装备", "Gear", "◈"],
  mystical: ["奇物", "Mystical", "✦"],
  other: ["其他", "Other", "◇"],
};
const ORDER_WAIT_MS = 70_000;
const REQUEST_TIMEOUT_MS = 6_000;
const PLAYER_ID = /^p[1-9][0-9]{0,9}$/;
const FINAL_ORDER_STATUS = new Set(["sent", "rejected", "unconfirmed"]);

function catalog(value) {
  if (!Array.isArray(value?.items) || !Array.isArray(value?.players)) return null;
  const items = new Map();
  for (const item of value.items.slice(0, 1024)) {
    if (!Number.isSafeInteger(item?.itemId) || item.itemId < 0 || items.has(item.itemId)
        || typeof item.name !== "string" || !item.name.trim() || item.name.length > 100
        || item.category === "all" || !Object.hasOwn(CATEGORIES, item.category)) continue;
    items.set(item.itemId, { itemId: item.itemId, name: item.name, category: item.category });
  }
  const players = new Map();
  for (const player of value.players.slice(0, 128)) {
    if (PLAYER_ID.test(player?.playerId) && typeof player.name === "string" && player.name.trim())
      players.set(player.playerId, player.name.slice(0, 100));
  }
  return { items, players };
}

function itemLabel(item) {
  return gameItemName(item.name);
}

function itemMatches(item, category, query) {
  return (category === "all" || item.category === category)
    && (!query || [item.name, itemLabel(item)].some(value => value.normalize("NFKC").toLowerCase().includes(query)));
}

export function createNavigationSupply({ menu, actionButtons, airportAction, airportGroup, dialog, title, close,
  shop, recipient, recipientPicker, recipientSelect, search, filters, items, empty, give, status,
  onTargetReady = () => {}, fetchImpl = (...args) => globalThis.fetch(...args) }) {
  let context = {};
  let session = null, nextRefresh = 0, refreshing = false;
  let mode = null, category = "all", selected = null, dialogTarget = null, message = null;
  let order = null, itemButtons = new Map(), filtersKey = "", itemsKey = "", focusOnClose;
  let wasTargetReady = false, airportPlayerId = null, recipientsKey = "";
  const doc = dialog.ownerDocument;

  function airportReady() {
    return Boolean(context.liveAirport && context.followsLive && session?.players.size
      && session.captureId === context.captureId && session.sceneEpoch === context.sceneEpoch);
  }

  function currentTarget() {
    const { captureId, followsLive, sceneEpoch } = context;
    const playerId = context.liveAirport ? airportPlayerId : context.playerId;
    const name = session?.players.get(playerId);
    return captureId && followsLive && name && session.captureId === captureId && session.sceneEpoch === sceneEpoch
      ? { captureId, sceneEpoch, playerId, name } : null;
  }

  function sameTarget(target) {
    const current = currentTarget();
    return current && target && current.captureId === target.captureId && current.sceneEpoch === target.sceneEpoch
      && current.playerId === target.playerId;
  }

  function setMessage(chinese, english, state = "") {
    message = { chinese, english, state };
  }

  function renderCatalog() {
    const languageKey = tr("zh", "en");
    const shownCategories = ["all", ...new Set(Array.from(session.items.values(), item => item.category))];
    if (!shownCategories.includes(category)) category = "all";
    const filterKey = JSON.stringify([languageKey, shownCategories]);
    if (filtersKey !== filterKey) {
      filtersKey = filterKey;
      filters.replaceChildren(...shownCategories.map(key => {
        const button = doc.createElement("button");
        button.type = "button";
        button.dataset.supplyCategory = key;
        button.textContent = tr(...CATEGORIES[key]);
        return button;
      }));
    }
    for (const button of filters.children) button.setAttribute("aria-pressed", String(button.dataset.supplyCategory === category));
    const query = search.value.trim().normalize("NFKC").toLowerCase();
    const visible = Array.from(session.items.values(), item => {
      return [item, resolveItemAsset(context.gameAssetPack, { itemId: item.itemId, name: item.name })?.iconUrl];
    }).filter(([item]) => itemMatches(item, category, query));
    const listKey = JSON.stringify([languageKey, category, query, visible]);
    if (itemsKey !== listKey) {
      itemsKey = listKey;
      items.scrollTop = 0;
      itemButtons = new Map();
      items.replaceChildren(...visible.map(([item, iconUrl]) => {
        const button = doc.createElement("button");
        button.type = "button";
        button.className = "navigation-supply-item";
        button.dataset.supplyItemId = String(item.itemId);
        const icon = doc.createElement("span");
        icon.className = "navigation-supply-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.textContent = CATEGORIES[item.category][2];
        if (iconUrl) {
          const image = doc.createElement("img");
          image.alt = "";
          image.hidden = true;
          image.decoding = "async";
          image.addEventListener("load", () => { icon.hidden = true; image.hidden = false; }, { once: true });
          image.src = iconUrl;
          button.append(image);
        }
        const label = doc.createElement("span");
        label.textContent = itemLabel(item);
        button.append(icon, label);
        itemButtons.set(item.itemId, button);
        return button;
      }));
    }
    for (const [id, button] of itemButtons) {
      button.setAttribute("aria-pressed", String(id === selected));
      button.disabled = Boolean(order) || !currentTarget();
    }
    empty.hidden = visible.length !== 0;
    empty.textContent = tr("没有匹配的物品。", "No matching items.");
  }

  function render() {
    const target = currentTarget();
    const airport = airportReady();
    const isTargetReady = Boolean(target) && !context.liveAirport;
    if (wasTargetReady !== isTargetReady) {
      wasTargetReady = isTargetReady;
      onTargetReady(isTargetReady);
    }
    for (const button of actionButtons) {
      button.hidden = !isTargetReady;
      button.disabled = Boolean(order);
      button.textContent = tr("给物品", "Give item");
    }
    if (airportGroup) airportGroup.hidden = !airport;
    if (airportAction) {
      airportAction.hidden = !airport;
      airportAction.disabled = Boolean(order);
      airportAction.textContent = tr("给物品", "Give item");
    }
    if (!dialog.open) return;
    title.textContent = tr("队伍补给", "Team supplies");
    close.setAttribute("aria-label", tr("关闭", "Close"));
    shop.hidden = mode !== "shop";
    if (recipientPicker) recipientPicker.hidden = !airport;
    if (airport && recipientSelect) {
      const key = JSON.stringify([tr("zh", "en"), [...session.players]]);
      if (recipientsKey !== key) {
        recipientsKey = key;
        recipientSelect.replaceChildren(...[["", tr("选择接收玩家", "Choose a player")], ...session.players].map(([id, name]) => {
          const option = doc.createElement("option");
          option.value = id;
          option.textContent = name;
          return option;
        }));
      }
      recipientSelect.value = airportPlayerId || "";
      recipientSelect.disabled = Boolean(order);
      recipientSelect.setAttribute("aria-label", tr("接收玩家", "Recipient"));
    }
    if (mode === "shop" && (sameTarget(dialogTarget) || airport && !dialogTarget)) {
      recipient.textContent = target ? tr(`给 ${target.name}`, `To ${target.name}`) : tr("先选择接收玩家", "Choose the recipient first");
      search.placeholder = tr("搜索物品", "Find items");
      search.setAttribute("aria-label", search.placeholder);
      filters.setAttribute("aria-label", tr("物品分类", "Item categories"));
      renderCatalog();
      const item = session.items.get(selected);
      give.disabled = !item || !target || Boolean(order);
      give.textContent = order ? tr("正在发送…", "Sending…")
        : item && target ? tr(`给 ${target.name} 1 个${itemLabel(item)}`, `Give ${target.name} 1 × ${itemLabel(item)}`)
        : tr("选择物品", "Select an item");
    }
    const statusText = message ? tr(message.chinese, message.english) : "";
    if (status.textContent !== statusText) status.textContent = statusText;
    status.hidden = !message;
    status.dataset.state = message?.state ?? "";
  }

  function hideDialog() {
    mode = null;
    selected = null;
    search.value = "";
    category = "all";
    message = null;
    dialogTarget = null;
    airportPlayerId = null;
    if (dialog.open) dialog.close();
  }

  function openDialog(nextMode, source) {
    if (dialog.open) return;
    mode = nextMode;
    // The airport has no climbing camera target. Show the actual current
    // recipient and require a choice when more than one player is present.
    if (airportReady()) airportPlayerId = session.players.size === 1 ? session.players.keys().next().value : null;
    dialogTarget = nextMode === "shop" ? currentTarget() : null;
    if (menu.open) menu.open = false;
    focusOnClose = menu.contains(source) ? menu.querySelector("summary") : source;
    dialog.showModal();
    render();
  }

  async function request(path, { body } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(ROOT + path, {
        method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store", redirect: "error",
        signal: controller.signal,
        headers: { Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, ok: response.ok, value: await response.json().catch(() => null) };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function refreshSession() {
    if (!context.followsLive || refreshing || Date.now() < nextRefresh) return;
    refreshing = true;
    nextRefresh = Date.now() + 4_000;
    const { captureId, sceneEpoch } = context;
    try {
      const { ok, value } = await request(`/${captureId.replace(".", "/")}/supply`);
      if (context.captureId !== captureId || context.sceneEpoch !== sceneEpoch) return;
      const refreshed = ok && value?.enabled === true && value.sceneEpoch === sceneEpoch ? catalog(value) : null;
      if (!refreshed) {
        session = null;
        hideDialog();
      } else {
        session = { captureId, sceneEpoch, ...refreshed };
        if (mode === "shop" && !sameTarget(dialogTarget) && !(airportReady() && !dialogTarget)) hideDialog();
        if (!session.items.has(selected)) selected = null;
      }
      render();
    } catch { /* Keep the current panel while a refresh is retried. */ }
    finally { refreshing = false; }
  }

  for (const button of [...actionButtons, airportAction].filter(Boolean)) button.addEventListener("click", () => {
    if ((currentTarget() || airportReady()) && !order) openDialog("shop", button);
  });
  recipientSelect?.addEventListener("change", () => {
    if (order || !airportReady() || mode !== "shop") return;
    airportPlayerId = session.players.has(recipientSelect.value) ? recipientSelect.value : null;
    dialogTarget = currentTarget();
    selected = null;
    message = null;
    render();
  });
  close.addEventListener("click", hideDialog);
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    hideDialog();
    if (!focusOnClose?.hidden && focusOnClose?.getClientRects().length) focusOnClose.focus();
  });
  filters.addEventListener("click", event => {
    const key = event.target.closest("[data-supply-category]")?.dataset.supplyCategory;
    if (!key || !Object.hasOwn(CATEGORIES, key) || mode !== "shop") return;
    category = key;
    selected = null;
    render();
  });
  search.addEventListener("input", () => { selected = null; render(); });
  items.addEventListener("click", event => {
    const button = event.target.closest("[data-supply-item-id]");
    if (!button || order || !sameTarget(dialogTarget)) return;
    selected = Number(button.dataset.supplyItemId);
    message = null;
    render();
  });

  async function settleOrder(current, firstResponse) {
    let response = await firstResponse.catch(() => null);
    let submitted = true;
    while (order === current) {
      const result = response?.value;
      if (response?.ok && result?.orderId === current.id && FINAL_ORDER_STATUS.has(result.status))
        return result.status;
      if (submitted && response && !response.ok && response.status >= 400 && response.status < 500)
        return ["supply_busy", "supply_capacity"].includes(result?.code) ? "busy" : "rejected";
      if (!submitted && [401, 403, 404, 410].includes(response?.status)) return "unconfirmed";
      if (Date.now() >= current.expiresAt) return "unconfirmed";
      await new Promise(resolve => setTimeout(resolve, 1_500));
      if (order !== current) break;
      submitted = false;
      response = await request(`${current.path}/${current.id}`).catch(() => null);
    }
    return "unconfirmed";
  }

  give.addEventListener("click", async () => {
    if (order || !sameTarget(dialogTarget) || !session.items.has(selected)) return;
    const current = {
      target: dialogTarget, path: `/${dialogTarget.captureId.replace(".", "/")}/supply`, id: globalThis.crypto.randomUUID(),
      expiresAt: Date.now() + ORDER_WAIT_MS,
    };
    const item = session.items.get(selected);
    order = current;
    setMessage("正在发送请求…", "Sending request…");
    render();
    const result = await settleOrder(current, request(current.path,
      { body: { orderId: current.id, sceneEpoch: current.target.sceneEpoch, playerId: current.target.playerId, itemId: item.itemId } }));
    if (order !== current) return;
    order = null;
    if (mode === "shop" && sameTarget(current.target)) {
      if (result === "sent") {
        selected = null;
        setMessage("请求已发出，请在游戏内查看。", "Request sent. Check in the game.", "sent");
      } else if (result === "busy") {
        setMessage("正在处理另一件补给，请稍后再试。", "Another request is being handled. Try again shortly.", "error");
      } else if (result === "unconfirmed") {
        selected = null;
        setMessage("暂未确认送达，请先在游戏内查看。", "Delivery is unconfirmed. Check in the game before trying again.", "error");
      } else {
        setMessage("请求未发出，请确认玩家仍在当前关卡。", "Request was not sent. Check that the player is still in this scene.", "error");
      }
    }
    render();
  });

  return {
    update(next = {}) {
      const captureId = parseCaptureId(next.captureId);
      const changedRoom = context.captureId !== captureId;
      const changedScene = changedRoom || context.sceneEpoch !== next.sceneEpoch;
      const changedMode = Boolean(context.liveAirport) !== Boolean(next.liveAirport);
      const followsLive = Boolean(captureId && next.followsLive);
      const language = tr("zh", "en");
      const changed = changedRoom || context.followsLive !== followsLive || context.language !== language
        || context.playerId !== next.playerId || context.sceneEpoch !== next.sceneEpoch || context.gameAssetPack !== next.gameAssetPack || changedMode;
      if (changedScene || changedMode) {
        session = null;
        nextRefresh = 0;
        hideDialog();
      }
      context = { ...next, captureId, followsLive, language };
      if (mode && (!followsLive || mode === "shop" && !sameTarget(dialogTarget) && !(airportReady() && !dialogTarget))) hideDialog();
      if (followsLive) void refreshSession();
      if (changed) render();
    },
  };
}
