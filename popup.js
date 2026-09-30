async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refreshStatus() {
  const statusEl = document.getElementById("status");
  const statusText = statusEl.querySelector(".status-text");
  try {
    const tab = await getActiveTab();
    const res = await chrome.tabs.sendMessage(tab.id, {
      target: "content",
      type: "GET_STATUS",
    });
    if (!res) throw new Error("no response");
    statusEl.dataset.state = !res.calibrated ? "idle" : res.paused ? "paused" : "active";
    statusText.textContent = !res.calibrated
      ? "Non calibré sur cette page"
      : res.paused
        ? "Calibré · scan en pause"
        : "Calibré · scan actif";
  } catch {
    statusEl.dataset.state = "error";
    statusText.textContent =
      "Extension non active sur cet onglet (recharge la page).";
  }
}

document.getElementById("recalibrate").addEventListener("click", async () => {
  const tab = await getActiveTab();
  await chrome.tabs.sendMessage(tab.id, {
    target: "content",
    type: "START_CALIBRATION",
  });
  window.close();
});

document.getElementById("pause").addEventListener("click", async () => {
  const tab = await getActiveTab();
  await chrome.tabs.sendMessage(tab.id, {
    target: "content",
    type: "TOGGLE_PAUSE",
  });
  refreshStatus();
});

refreshStatus();
