import { parseCaptureId } from "./packet-watch-client.js";

const ROOT = "/api/packet-replay";
const STOPPABLE = new Set(["connecting", "recording"]);
const MESSAGES = {
  checking: ["正在检查停采权限…", "Checking permission…"],
  stopping: ["正在停止采集…", "Stopping capture…"],
  incorrect: ["访问码有误，请重新输入。", "Incorrect access code. Try again."],
  limited: ["尝试次数过多，请稍后再试。", "Too many attempts. Try again later."],
  expired: ["请重新输入管理员访问码。", "Enter the administrator access code again."],
  unavailable: ["停采服务暂不可用。", "The stop service is temporarily unavailable."],
  failed: ["暂未确认停止，请查看房间状态后重试。", "Stop was not confirmed. Check the room status before retrying."],
};

export function createPacketStop({ group, button, buttonLabel, menu, dialog, form, title, description,
  authorization, codeLabel, code, status, cancel, confirm, translate, fetchImpl = (...args) => globalThis.fetch(...args) }) {
  let target = null, accepted = false, needsCode = false, busy = false, message = null, inFlight = null;
  const text = key => translate(...MESSAGES[key]);

  function render() {
    group.hidden = target === null;
    button.disabled = accepted;
    buttonLabel.textContent = accepted ? text("stopping") : translate("停止采集", "Stop capture");
    title.textContent = translate("停止采集？", "Stop capture?");
    description.textContent = translate("本房间的实时导航将结束，并保存已收到的数据。", "Live navigation for this room will end and the captured data will be saved.");
    authorization.hidden = !needsCode;
    code.required = needsCode;
    code.disabled = !needsCode || busy;
    codeLabel.textContent = translate("管理员访问码", "Administrator access code");
    status.textContent = message ? text(message) : "";
    status.hidden = !status.textContent;
    cancel.textContent = translate("取消", "Cancel");
    cancel.disabled = busy && message === "stopping";
    confirm.textContent = translate("确认停止", "Confirm stop");
    confirm.disabled = busy || message === "unavailable";
  }

  function reset() {
    inFlight?.abort();
    inFlight = null;
    needsCode = false;
    busy = false;
    message = null;
    code.value = "";
  }

  async function request(path, signal, method = "GET", body) {
    return fetchImpl(ROOT + path, {
      method, signal, credentials: "same-origin", cache: "no-store", redirect: "error",
      headers: body ? { Accept: "application/json", "Content-Type": "application/json" } : { Accept: "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  async function perform(nextMessage, work) {
    const controller = new AbortController(), capture = target;
    inFlight = controller;
    const current = () => target === capture && inFlight === controller && dialog.open;
    const deadline = setTimeout(() => controller.abort(), 12_000);
    busy = true;
    message = nextMessage;
    render();
    try {
      await work(controller.signal, current, capture);
    } catch {
      if (current()) message = nextMessage === "checking" ? "unavailable" : "failed";
    } finally {
      clearTimeout(deadline);
      if (current()) {
        inFlight = null;
        busy = false;
        render();
        if (needsCode) code.focus();
      }
    }
  }

  button.addEventListener("click", () => {
    if (!target || accepted || dialog.open) return;
    reset();
    menu.open = false;
    dialog.showModal();
    void perform("checking", async (signal, current) => {
      const response = await request("/session", signal);
      if (!response.ok) throw new Error("Session unavailable");
      const value = await response.json();
      if (!current()) return;
      needsCode = value?.configured === true && value.authenticated !== true;
      message = value?.configured === true ? null : "unavailable";
    });
  });

  form.addEventListener("submit", event => {
    event.preventDefault();
    if (!target || accepted || busy || !dialog.open) return;
    const accessCode = needsCode ? code.value : null;
    if (needsCode && !accessCode) return;
    code.value = "";
    void perform("stopping", async (signal, current, capture) => {
      if (accessCode !== null) {
        const login = await request("/session", signal, "POST", { accessCode });
        if (!current()) return;
        if (!login.ok) {
          message = login.status === 401 ? "incorrect" : login.status === 429 ? "limited" : "unavailable";
          return;
        }
        if ((await login.json())?.authenticated !== true) throw new Error("Authentication did not complete");
        if (!current()) return;
        needsCode = false;
      }
      const response = await request(`/captures/${capture.replace(".", "/")}/stop`, signal, "POST");
      if (!current()) return;
      if (response.status === 401) {
        needsCode = true;
        message = "expired";
        return;
      }
      if (!response.ok) {
        message = "failed";
        return;
      }
      const value = await response.json();
      if (!current()) return;
      if (`${value?.roomCode}.${value?.featureCode}` !== capture || !["stopping", "completed"].includes(value?.status))
        throw new Error("Unexpected stop response");
      accepted = true;
      dialog.close();
      reset();
      render();
    });
  });
  cancel.addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", event => {
    if (busy && message === "stopping") event.preventDefault();
  });
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    reset();
    if (target && !menu.hidden) menu.querySelector("summary")?.focus();
  });

  return {
    update(captureId, captureStatus) {
      const next = STOPPABLE.has(captureStatus) ? parseCaptureId(captureId) : null;
      if (next !== target) {
        target = next;
        accepted = false;
        reset();
        if (dialog.open) dialog.close();
      }
      render();
    },
  };
}
