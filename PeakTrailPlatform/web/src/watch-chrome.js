/** Reuse the existing controls and listeners, restoring their homes on exit. */
export function createWatchChrome({ shell, menu, groups, onClosePanel, root = document }) {
  let active = false;
  const homes = [];
  const summary = menu.querySelector('summary');
  const closeMenu = (focus = false) => {
    const wasOpen = menu.open;
    menu.open = false;
    for (const details of menu.querySelectorAll('details[open]')) details.open = false;
    if (focus && wasOpen) summary.focus();
    return wasOpen;
  };
  function reset() {
    closeMenu();
    for (const kind of ['players', 'replay']) onClosePanel(kind);
  }
  function setActive(next) {
    next = Boolean(next);
    menu.hidden = !next;
    if (active === next) return;
    reset();
    active = next;
    if (next) {
      for (const { slot, controls } of groups) for (const control of controls) {
        if (!control) continue;
        const home = root.createComment('watch control home');
        control.before(home);
        homes.push({ control, home });
        slot.append(control);
      }
      closeMenu();
    } else {
      for (const { control, home } of homes) { home.before(control); home.remove(); }
      homes.length = 0;
    }
  }
  root.addEventListener('click', event => {
    if (active && menu.open && !menu.contains(event.target)) closeMenu();
  });
  // Handle only the top visible UI layer. The same Escape must not also cancel
  // the spectator camera, and Tab retains its normal document navigation.
  root.addEventListener('keydown', event => {
    if (!active || event.key !== 'Escape') return;
    let closed = closeMenu(true);
    if (!closed) for (const kind of ['players', 'replay']) {
      if (shell.classList.contains(`watch-${kind}-open`)) {
        onClosePanel(kind); summary.focus(); closed = true; break;
      }
    }
    if (closed) { event.preventDefault(); event.stopPropagation(); }
  }, true);
  return { setActive, reset, closeMenu };
}
