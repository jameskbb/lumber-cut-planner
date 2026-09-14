// Lets the phone's back gesture close a full-screen dialog instead of leaving
// the app. Opening adds a history entry and back closes the dialog. Closing it
// any other way takes that entry off again, so no stray entry is left behind.

export function closeOnBack(dialog, key) {
  let pushed = false;
  // Pops caused by our own history.back(), which aren't the person going back.
  let ownPops = 0;

  window.addEventListener('popstate', () => {
    if (ownPops) { ownPops--; return; }
    if (!pushed || !dialog.open) return;
    pushed = false;
    dialog.close();
  });

  return {
    /** Call right after showing the dialog. */
    opened() {
      if (pushed) return;
      try { history.pushState({ [key]: true }, ''); pushed = true; } catch { pushed = false; }
    },
    /** Call from the dialog's close event. */
    closed() {
      if (!pushed) return;
      pushed = false;
      if (history.state?.[key]) { ownPops++; history.back(); }
    },
  };
}
