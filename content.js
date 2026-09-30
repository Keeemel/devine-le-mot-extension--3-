// content.js — UI de calibration, overlay de résultats, boucle de scan.
(() => {
  const HOSTNAME = location.hostname || "local-file";
  const STORAGE_KEY = "dlm_calibrations";
  // Chrome limite captureVisibleTab à 2 appels/seconde
  // (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND). On vise ce plafond au plus
  // près (550 ms de marge) plutôt qu'un intervalle fixe conservateur : la
  // boucle se reprogramme elle-même juste après chaque scan, donc elle va
  // aussi vite que le pipeline OCR le permet sans jamais dépasser la limite.
  const MIN_SCAN_GAP_MS = 550;
  const CONFIDENCE_WARNING_THRESHOLD = 60;
  const CANDIDATE_BATCH_SIZE = 100;

  let state = {
    rect: null, // {x, y, width, height} en CSS px, relatif au viewport
    referenceLength: null,
    scanning: false,
    paused: false,
    intervalId: null,
    pendingPattern: null,
    pendingCount: 0,
    lastValidatedPattern: null,
    lastConfidence: null,
    manualOverrides: new Map(),
    manualPattern: null,
    manualSolveRequest: 0,
    inFlight: false,
  };

  // ---------- Stockage ----------
  async function loadCalibration() {
    const all = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || {};
    return all[HOSTNAME] || null;
  }

  async function saveCalibration(rect, referenceLength) {
    const all = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || {};
    all[HOSTNAME] = { rect, referenceLength };
    await chrome.storage.local.set({ [STORAGE_KEY]: all });
  }

  // ---------- Overlay de calibration ----------
  function startCalibration(existingRect) {
    stopScanning();

    const backdrop = document.createElement("div");
    backdrop.id = "dlm-calib-backdrop";
    document.body.appendChild(backdrop);

    const box = document.createElement("div");
    box.id = "dlm-calib-box";
    const initial = existingRect || {
      x: window.innerWidth / 2 - 100,
      y: window.innerHeight / 2 - 40,
      width: 200,
      height: 80,
    };
    Object.assign(box.style, {
      left: `${initial.x}px`,
      top: `${initial.y}px`,
      width: `${initial.width}px`,
      height: `${initial.height}px`,
    });
    document.body.appendChild(box);

    ["nw", "ne", "sw", "se"].forEach((corner) => {
      const h = document.createElement("div");
      h.className = `dlm-handle ${corner}`;
      box.appendChild(h);
    });

    const panel = document.createElement("div");
    panel.id = "dlm-calib-panel";
    panel.innerHTML = `
      <span>Zone du mot : cadre + déplace/redimensionne</span>
      <label>Lettres&nbsp;<input type="number" id="dlm-ref-length" min="1" max="20" placeholder="?" /></label>
      <button id="dlm-calib-validate">Valider</button>
      <button id="dlm-calib-cancel">Annuler</button>
    `;
    document.body.appendChild(panel);
    positionPanelBelowBox();

    const refInput = panel.querySelector("#dlm-ref-length");
    if (existingRect && state.referenceLength) refInput.value = state.referenceLength;

    function positionPanelBelowBox() {
      const r = box.getBoundingClientRect();
      panel.style.left = `${Math.max(8, r.left)}px`;
      panel.style.top = `${r.bottom + 10}px`;
    }

    // --- Déplacement de la box (drag depuis son intérieur) ---
    let dragMode = null; // 'move' | 'nw' | 'ne' | 'sw' | 'se'
    let dragStart = null;

    function onBoxMouseDown(e, mode) {
      e.preventDefault();
      e.stopPropagation();
      dragMode = mode;
      const r = box.getBoundingClientRect();
      dragStart = {
        mouseX: e.clientX,
        mouseY: e.clientY,
        x: r.left,
        y: r.top,
        width: r.width,
        height: r.height,
      };
    }

    box.addEventListener("mousedown", (e) => {
      if (e.target.classList.contains("dlm-handle")) return;
      onBoxMouseDown(e, "move");
    });
    box.querySelectorAll(".dlm-handle").forEach((h) => {
      const corner = [...h.classList].find((c) => c !== "dlm-handle");
      h.addEventListener("mousedown", (e) => onBoxMouseDown(e, corner));
    });

    function onMouseMove(e) {
      if (!dragMode) return;
      const dx = e.clientX - dragStart.mouseX;
      const dy = e.clientY - dragStart.mouseY;
      let { x, y, width, height } = dragStart;

      if (dragMode === "move") {
        x += dx;
        y += dy;
      } else {
        if (dragMode.includes("e")) width = Math.max(20, dragStart.width + dx);
        if (dragMode.includes("s")) height = Math.max(16, dragStart.height + dy);
        if (dragMode.includes("w")) {
          width = Math.max(20, dragStart.width - dx);
          x = dragStart.x + dx;
        }
        if (dragMode.includes("n")) {
          height = Math.max(16, dragStart.height - dy);
          y = dragStart.y + dy;
        }
      }

      Object.assign(box.style, {
        left: `${x}px`,
        top: `${y}px`,
        width: `${width}px`,
        height: `${height}px`,
      });
      positionPanelBelowBox();
    }

    function onMouseUp() {
      dragMode = null;
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);

    function cleanup() {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      backdrop.remove();
      box.remove();
      panel.remove();
    }

    panel.querySelector("#dlm-calib-cancel").addEventListener("click", () => {
      cleanup();
      if (state.rect) startScanning(); // reprend si une calibration existait déjà
    });

    panel.querySelector("#dlm-calib-validate").addEventListener("click", async () => {
      const r = box.getBoundingClientRect();
      const rect = { x: r.left, y: r.top, width: r.width, height: r.height };
      const referenceLength = refInput.value ? parseInt(refInput.value, 10) : null;

      await saveCalibration(rect, referenceLength);
      state.rect = rect;
      state.referenceLength = referenceLength;

      cleanup();
      startScanning();
    });
  }

  // ---------- Overlay de résultats ----------
  let overlayEls = null;
  let candidateEntries = [];
  let renderedCandidateCount = 0;
  let renderedCandidatePattern = null;
  let renderedInputPattern = null;
  let copyStatusTimer = null;

  function ensureResultOverlay() {
    if (overlayEls) return overlayEls;

    const root = document.createElement("div");
    root.id = "dlm-result-overlay";
    root.innerHTML = `
      <div id="dlm-result-header">
        <span class="dlm-brand"><span>🔎 Devine le Mot</span><span class="dlm-local-ai">IA LOCALE</span></span>
        <span>
          <button id="dlm-new-word" title="Réinitialiser pour un nouveau mot" aria-label="Nouveau mot">↻</button>
          <button id="dlm-pause" title="Pause/Reprendre" aria-label="Pause ou reprise">⏸</button>
          <button id="dlm-recalibrate" title="Recalibrer" aria-label="Recalibrer">⚙️</button>
        </span>
      </div>
      <div id="dlm-result-body">
        <div id="dlm-pattern" aria-label="Mot détecté"></div>
        <div id="dlm-confidence">confiance: –</div>
        <div id="dlm-copy-status" aria-live="polite"></div>
        <ul id="dlm-candidates"></ul>
        <div id="dlm-warning" style="display:none;"></div>
      </div>
    `;
    document.body.appendChild(root);

    // drag via le header
    const header = root.querySelector("#dlm-result-header");
    let dragging = false;
    let start = null;
    header.addEventListener("mousedown", (e) => {
      if (e.target.tagName === "BUTTON") return;
      dragging = true;
      const r = root.getBoundingClientRect();
      start = { mouseX: e.clientX, mouseY: e.clientY, x: r.left, y: r.top };
      root.style.right = "auto";
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      root.style.left = `${start.x + (e.clientX - start.mouseX)}px`;
      root.style.top = `${start.y + (e.clientY - start.mouseY)}px`;
    });
    document.addEventListener("mouseup", () => (dragging = false));

    root.querySelector("#dlm-pause").addEventListener("click", () => {
      state.paused = !state.paused;
      root.querySelector("#dlm-pause").textContent = state.paused ? "▶" : "⏸";
    });
    root.querySelector("#dlm-recalibrate").addEventListener("click", () => {
      startCalibration(state.rect);
    });
    root.querySelector("#dlm-new-word").addEventListener("click", resetCurrentWord);
    root.querySelector("#dlm-pattern").addEventListener("input", handleManualLetterInput);
    root.querySelector("#dlm-candidates").addEventListener("click", (event) => {
      const item = event.target.closest("li[data-word]");
      if (item) copyWord(item.dataset.word);
    });
    root.querySelector("#dlm-candidates").addEventListener("keydown", (event) => {
      const item = event.target.closest("li[data-word]");
      if (item && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        copyWord(item.dataset.word);
      }
    });
    root.querySelector("#dlm-candidates").addEventListener("scroll", () => {
      if (overlayEls.candidates.scrollTop + overlayEls.candidates.clientHeight >=
        overlayEls.candidates.scrollHeight - 32) {
        renderCandidateBatch();
      }
    });

    overlayEls = {
      root,
      pattern: root.querySelector("#dlm-pattern"),
      confidence: root.querySelector("#dlm-confidence"),
      copyStatus: root.querySelector("#dlm-copy-status"),
      candidates: root.querySelector("#dlm-candidates"),
      warning: root.querySelector("#dlm-warning"),
    };
    return overlayEls;
  }

  function renderCandidateBatch() {
    if (!overlayEls || renderedCandidateCount >= candidateEntries.length) return;

    const end = Math.min(
      renderedCandidateCount + CANDIDATE_BATCH_SIZE,
      candidateEntries.length
    );
    const fragment = document.createDocumentFragment();
    for (; renderedCandidateCount < end; renderedCandidateCount++) {
      const item = document.createElement("li");
      const word = candidateEntries[renderedCandidateCount].word;
      item.textContent = word;
      item.dataset.word = word;
      item.tabIndex = 0;
      item.setAttribute("role", "button");
      fragment.appendChild(item);
    }
    overlayEls.candidates.appendChild(fragment);
  }

  function setCandidateList(pattern, candidates, force = false) {
    if (renderedCandidatePattern === pattern && !force) return;

    renderedCandidatePattern = pattern;
    candidateEntries = candidates;
    renderedCandidateCount = 0;
    overlayEls.candidates.replaceChildren();
    if (candidateEntries.length === 0) {
      const item = document.createElement("li");
      item.textContent = "Aucun candidat";
      overlayEls.candidates.appendChild(item);
      return;
    }
    renderCandidateBatch();
  }

  function renderEditablePattern(pattern) {
    if (renderedInputPattern === pattern) return;

    const activeInput = document.activeElement?.closest?.(".dlm-letter-input");
    const focusedIndex = activeInput ? Number(activeInput.dataset.index) : null;
    overlayEls.pattern.replaceChildren();

    [...pattern].forEach((letter, index) => {
      const input = document.createElement("input");
      input.className = "dlm-letter-input";
      input.type = "text";
      input.maxLength = 1;
      input.autocomplete = "off";
      input.spellcheck = false;
      input.value = letter;
      input.dataset.index = index;
      input.setAttribute("aria-label", `Lettre ${index + 1}, modifier`);
      input.title = "Corriger cette lettre";
      overlayEls.pattern.appendChild(input);
    });
    renderedInputPattern = pattern;

    if (focusedIndex !== null) {
      const nextInput = overlayEls.pattern.querySelector(`[data-index="${focusedIndex}"]`);
      nextInput?.focus();
      nextInput?.select();
    }
  }

  function applyManualOverrides(pattern) {
    const letters = [...pattern];
    for (const [index, letter] of state.manualOverrides) {
      if (index < letters.length) letters[index] = letter;
    }
    return letters.join("");
  }

  function handleManualLetterInput(event) {
    const input = event.target.closest(".dlm-letter-input");
    if (!input) return;

    const value = input.value.toUpperCase().replace(/[^A-Z_]/g, "").slice(0, 1);
    const index = Number(input.dataset.index);
    const basePattern = state.lastValidatedPattern || state.pendingPattern;
    input.value = value;
    if (!basePattern || index >= basePattern.length) return;

    if (!value || value === basePattern[index]) {
      state.manualOverrides.delete(index);
    } else {
      state.manualOverrides.set(index, value);
    }

    const pattern = applyManualOverrides(basePattern);
    state.manualPattern = pattern;
    renderedInputPattern = null;
    renderEditablePattern(pattern);
    requestManualCandidates(pattern);
  }

  async function requestManualCandidates(pattern) {
    const requestId = ++state.manualSolveRequest;
    overlayEls.confidence.textContent = `confiance: ${state.lastConfidence ?? "–"}% · calcul…`;

    try {
      const response = await chrome.runtime.sendMessage({
        target: "background",
        type: "SOLVE_PATTERN",
        pattern,
      });
      if (requestId !== state.manualSolveRequest || state.manualPattern !== pattern) return;
      if (!response?.ok) return;

      setCandidateList(pattern, response.candidates, true);
      overlayEls.confidence.textContent =
        `confiance: ${state.lastConfidence ?? "–"}% · ${response.candidates.length} mots`;
    } catch (error) {
      console.warn("[DevineLeMot] correction manuelle échouée:", error);
    }
  }

  function insertIntoTwitchChat(word) {
    if (!/(^|\.)twitch\.tv$/i.test(location.hostname)) return false;

    const editableSelector = 'textarea, input, [contenteditable="true"], [role="textbox"]';
    const chatRoots = document.querySelectorAll(
      '[data-a-target="chat-input"], [data-test-selector="chat-input"]'
    );
    let input = null;
    for (const root of chatRoots) {
      if (root.matches(editableSelector)) {
        input = root;
        break;
      }
      input = root.querySelector(editableSelector);
      if (input) break;
    }
    input ||= document.querySelector(
      'textarea[aria-label*="chat" i], [contenteditable="true"][aria-label*="chat" i]'
    );
    if (!input) return false;

    const insertedWord = word.toLowerCase();
    input.focus();

    if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
      const currentValue = input.value;
      const start = input.selectionStart ?? currentValue.length;
      const end = input.selectionEnd ?? start;
      const nextValue = currentValue.slice(0, start) + insertedWord + currentValue.slice(end);
      const valueSetter = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(input),
        "value"
      )?.set;
      if (!valueSetter) return false;

      valueSetter.call(input, nextValue);
      input.setSelectionRange(start + insertedWord.length, start + insertedWord.length);
      input.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: insertedWord,
      }));
      return true;
    }

    if (input.isContentEditable) {
      const selection = window.getSelection();
      let range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      if (!range || !input.contains(range.commonAncestorContainer)) {
        range = document.createRange();
        range.selectNodeContents(input);
        range.collapse(false);
      }
      selection?.removeAllRanges();
      selection?.addRange(range);
      if (document.execCommand?.("insertText", false, insertedWord)) return true;

      range.deleteContents();
      const textNode = document.createTextNode(insertedWord);
      range.insertNode(textNode);
      range.setStartAfter(textNode);
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);
      input.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: insertedWord,
      }));
      return true;
    }

    return false;
  }

  function showCopyStatus(message, failed = false) {
    overlayEls.copyStatus.textContent = message;
    overlayEls.copyStatus.classList.toggle("failed", failed);
    overlayEls.copyStatus.style.display = "block";
    clearTimeout(copyStatusTimer);
    copyStatusTimer = setTimeout(() => {
      overlayEls.copyStatus.style.display = "none";
    }, 1800);
  }

  async function copyWord(word) {
    const copiedWord = word.toLowerCase();
    if (insertIntoTwitchChat(copiedWord)) {
      showCopyStatus(`${copiedWord} ajouté au chat Twitch · Entrée pour envoyer`);
      return;
    }

    let copied = false;
    try {
      await navigator.clipboard.writeText(copiedWord);
      copied = true;
    } catch {
      const input = document.createElement("textarea");
      input.value = copiedWord;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      copied = document.execCommand("copy");
      input.remove();
    }

    const isTwitch = /(^|\.)twitch\.tv$/i.test(location.hostname);
    showCopyStatus(
      copied
        ? isTwitch
          ? `${copiedWord} copié · chat Twitch introuvable`
          : `${copiedWord} copié`
        : "Copie impossible",
      !copied
    );
  }

  function resetCurrentWord() {
    state.pendingPattern = null;
    state.pendingCount = 0;
    state.lastValidatedPattern = null;
    state.lastConfidence = null;
    state.manualOverrides.clear();
    state.manualPattern = null;
    state.manualSolveRequest++;
    candidateEntries = [];
    renderedCandidateCount = 0;
    renderedCandidatePattern = null;
    renderedInputPattern = null;

    if (!overlayEls) return;
    overlayEls.pattern.replaceChildren();
    overlayEls.confidence.textContent = "confiance: –";
    overlayEls.confidence.classList.remove("low");
    overlayEls.candidates.innerHTML = "<li>Recherche du nouveau mot…</li>";
    overlayEls.warning.style.display = "none";
  }

  function renderResult({ pattern, confidence, candidates, plausible }) {
    const els = ensureResultOverlay();
    const displayPattern = applyManualOverrides(pattern);
    renderEditablePattern(displayPattern);
    state.lastConfidence = confidence;

    if (state.manualOverrides.size > 0) {
      if (displayPattern !== state.manualPattern) {
        state.manualPattern = displayPattern;
        requestManualCandidates(displayPattern);
      }
      if (renderedCandidatePattern !== displayPattern) {
        setCandidateList(displayPattern, []);
      }
    } else if (candidates !== null && candidates !== undefined) {
      setCandidateList(displayPattern, candidates);
    } else if (renderedCandidatePattern !== displayPattern) {
      setCandidateList(displayPattern, []);
    }
    const candidateCount =
      renderedCandidatePattern === displayPattern ? candidateEntries.length : 0;
    els.confidence.textContent = `confiance: ${confidence}% · ${candidateCount} mots`;
    els.confidence.classList.toggle("low", confidence < CONFIDENCE_WARNING_THRESHOLD);

    if (!plausible) {
      els.warning.style.display = "block";
      els.warning.textContent =
        "⚠️ Lecture incohérente (longueur inattendue) — vérifie la calibration.";
      return;
    }
    if (confidence < CONFIDENCE_WARNING_THRESHOLD) {
      els.warning.style.display = "block";
      els.warning.textContent = "⚠️ Confiance OCR faible — essaie de recalibrer.";
    } else {
      els.warning.style.display = "none";
    }

  }

  // ---------- Boucle de scan (auto-régulée, pas d'intervalle fixe) ----------
  let scanTimer = null;
  let scanActive = false;

  function startScanning() {
    if (scanActive) return;
    scanActive = true;
    state.intervalId = true; // utilisé par GET_STATUS pour savoir si ça tourne
    state.scanning = true;
    state.paused = false;
    ensureResultOverlay();
    loop();
  }

  function stopScanning() {
    scanActive = false;
    state.intervalId = null;
    state.scanning = false;
    if (scanTimer) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }
  }

  async function loop() {
    if (!scanActive) return;
    const t0 = performance.now();
    await tick();
    if (!scanActive) return; // stoppé pendant le tick (ex: erreur fatale)
    const elapsed = performance.now() - t0;
    const delay = Math.max(0, MIN_SCAN_GAP_MS - elapsed);
    scanTimer = setTimeout(loop, delay);
  }

  async function tick() {
    if (state.paused || state.inFlight || !state.rect) return;
    state.inFlight = true;

    try {
      const dpr = window.devicePixelRatio || 1;
      const rectDevicePx = {
        x: Math.round(state.rect.x * dpr),
        y: Math.round(state.rect.y * dpr),
        width: Math.round(state.rect.width * dpr),
        height: Math.round(state.rect.height * dpr),
      };

      const response = await chrome.runtime.sendMessage({
        target: "background",
        type: "REQUEST_SCAN",
        rect: rectDevicePx,
        referenceLength: state.referenceLength,
        knownPattern: state.lastValidatedPattern,
      });

      if (!response || !response.ok) {
        const errMsg = response?.error || "";

        // Erreurs transitoires : pas graves, on retente à la frame suivante.
        const isQuota = /MAX_CAPTURE_VISIBLE_TAB/.test(errMsg);
        const isTabBusy = /cannot be edited right now/.test(errMsg);
        if (isQuota || isTabBusy) return;

        // L'accès au site n'est pas (ou plus) accordé de façon persistante :
        // le scan automatique ne peut pas fonctionner tant que l'utilisateur
        // n'a pas mis l'accès sur "Sur tous les sites" pour ce domaine.
        if (/activeTab.*not in effect/i.test(errMsg)) {
          if (overlayEls) {
            overlayEls.warning.style.display = "block";
            overlayEls.warning.textContent =
              "⚠️ Accès au site requis : chrome://extensions → Détails → Accès au site → \"Sur tous les sites\", puis recharge la page.";
          }
          return;
        }

        console.warn("[DevineLeMot] scan échoué:", errMsg);
        return;
      }

      // Debounce : un pattern doit être lu 2 fois de suite avant d'être
      // affiché comme "validé", pour absorber les lectures OCR isolées
      // foireuses.
      if (response.pattern === state.pendingPattern) {
        state.pendingCount++;
      } else {
        state.pendingPattern = response.pattern;
        state.pendingCount = 1;
      }

      if (state.pendingCount >= 2) {
        state.lastValidatedPattern = response.pattern;
        renderResult(response);
      }
    } catch (err) {
      if (String(err).includes("Extension context invalidated")) {
        // L'extension a été rechargée depuis chrome://extensions pendant
        // que cette page était ouverte : ce content script est orphelin,
        // inutile de continuer à spammer la console. Recharge la page.
        stopScanning();
        if (overlayEls) {
          overlayEls.warning.style.display = "block";
          overlayEls.warning.textContent =
            "⚠️ Extension rechargée — recharge cette page (F5) pour reprendre.";
        }
        return;
      }
      console.warn("[DevineLeMot] erreur scan:", err);
    } finally {
      state.inFlight = false;
    }
  }

  // ---------- Messages depuis le popup ----------
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.target !== "content") return false;

    if (message.type === "START_CALIBRATION") {
      startCalibration(state.rect);
      sendResponse({ ok: true });
    } else if (message.type === "GET_STATUS") {
      sendResponse({
        calibrated: !!state.rect,
        scanning: !!state.intervalId,
        paused: state.paused,
      });
    } else if (message.type === "TOGGLE_PAUSE") {
      state.paused = !state.paused;
      sendResponse({ paused: state.paused });
    }
    return true;
  });

  // ---------- Init ----------
  (async () => {
    const saved = await loadCalibration();
    if (saved) {
      state.rect = saved.rect;
      state.referenceLength = saved.referenceLength;
      startScanning();
    }
  })();
})();