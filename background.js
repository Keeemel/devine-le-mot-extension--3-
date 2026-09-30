// background.js — service worker (MV3, type module)
// Rôle : capturer l'onglet visible, déléguer le crop/préprocess/OCR au
// document "offscreen" (qui a accès au DOM/canvas), puis filtrer le
// dictionnaire via solver.js et renvoyer le résultat au content script.

import { solve, normalizeOcrConfusions, isPatternPlausible } from "./solver.js";

const OFFSCREEN_URL = "offscreen.html";
let offscreenReady = null;

// Petit cache : évite de refiltrer le dictionnaire si le pattern OCR
// nettoyé n'a pas changé par rapport à la frame précédente.
let lastCleanedPattern = null;
let lastCandidates = [];

async function ensureOffscreenDocument() {
  if (offscreenReady) return offscreenReady;

  offscreenReady = (async () => {
    // Evite de créer un doublon si un document offscreen existe déjà
    // (ex: après réveil du service worker).
    if (chrome.runtime.getContexts) {
      const existing = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
      });
      if (existing.length > 0) return;
    }
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["WORKERS", "BLOBS"],
      justification:
        "Prétraitement d'image (canvas) et OCR local (Tesseract.js) du mot mystère.",
    });
  })();

  return offscreenReady;
}

/**
 * Envoie un message au document offscreen et attend sa réponse.
 */
function sendToOffscreen(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { target: "offscreen", ...message },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      }
    );
  });
}

async function handleScanRequest(rect, referenceLength, knownPattern) {
  await ensureOffscreenDocument();
  const expectedLength = referenceLength || knownPattern?.length || null;

  // 1) Capture l'onglet visible (PNG, tel qu'affiché à l'écran).
  const dataUrl = await chrome.tabs.captureVisibleTab(undefined, {
    format: "png",
  });

  // 2) Le document offscreen crop + prétraite (niveaux de gris, seuillage,
  //    upscale, segmentation en cases) puis lance l'OCR case par case.
  const ocrResult = await sendToOffscreen({
    type: "RUN_OCR",
    dataUrl,
    rect,
    referenceLength: expectedLength,
  });

  if (!ocrResult || !ocrResult.ok) {
    return {
      ok: false,
      error: ocrResult?.error || "Echec OCR (document offscreen).",
    };
  }

  // 3) Nettoyage / normalisation du pattern détecté.
  const cleaned = normalizeOcrConfusions(ocrResult.pattern);
  const plausible = isPatternPlausible(cleaned, expectedLength);

  if (!plausible) {
    return {
      ok: true,
      pattern: cleaned,
      confidence: ocrResult.confidence,
      candidates: cleaned === knownPattern ? null : [],
      plausible: false,
    };
  }

  // 4) Filtrage du dictionnaire (réutilise le résultat précédent si le
  //    pattern n'a pas changé, pour ne pas refaire le travail inutilement).
  let candidates;
  if (cleaned === lastCleanedPattern) {
    candidates = lastCandidates;
  } else {
    candidates = await solve(cleaned);
    lastCleanedPattern = cleaned;
    lastCandidates = candidates;
  }

  return {
    ok: true,
    pattern: cleaned,
    confidence: ocrResult.confidence,
    candidates: cleaned === knownPattern ? null : candidates,
    plausible: true,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "background") return; // pas pour nous (ex: offscreen)

  if (message.type === "REQUEST_SCAN") {
    handleScanRequest(message.rect, message.referenceLength, message.knownPattern)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // réponse asynchrone
  }

  if (message.type === "SOLVE_PATTERN") {
    if (typeof message.pattern !== "string") {
      sendResponse({ ok: false, error: "Motif invalide." });
      return false;
    }
    const pattern = normalizeOcrConfusions(message.pattern);
    if (!isPatternPlausible(pattern)) {
      sendResponse({ ok: false, error: "Motif invalide." });
      return false;
    }
    solve(pattern)
      .then((candidates) => sendResponse({ ok: true, candidates }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  return false;
});
