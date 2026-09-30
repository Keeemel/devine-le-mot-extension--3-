// offscreen.js — écoute les demandes du service worker et délègue à ocr.js

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "offscreen") return false;

  if (message.type === "RUN_OCR") {
    window.__ocrPipeline
      .runOcrPipeline(message.dataUrl, message.rect, message.referenceLength)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // réponse asynchrone
  }

  return false;
});
