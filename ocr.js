// ocr.js — s'exécute dans le document offscreen (accès DOM/canvas complet).
// Pipeline : crop -> niveaux de gris -> binarisation et segmentation à la
// résolution native -> upscale des seules cases de lettres -> OCR Tesseract.

const UPSCALE = 4;
const BIN_THRESHOLD = 150; // luminance 0-255 ; fond sombre / lettres claires
const MIN_FG_PIXELS_PER_COL = 1; // colonne considérée "vide" en dessous
const UNDERSCORE_HEIGHT_RATIO = 0.33; // hauteur de blob / hauteur totale
const OCR_CACHE_LIMIT = 256;
// En dessous de ce score, une lecture est trop incertaine pour être imposée
// comme lettre "dure" dans le pattern : une lettre mal lue mais acceptée
// élimine silencieusement le bon mot du filtrage par regex. On préfère
// afficher "_" (modifiable à la main) plutôt qu'une lettre probablement
// fausse — moins spectaculaire mais beaucoup plus fiable.
const LETTER_CONFIDENCE_THRESHOLD = 55;

let tesseractScheduler = null;
let schedulerPromise = null;
let additionalWorkerPromise = null;
const ocrCache = new Map();

function segmentFingerprint(fg, imageWidth, seg, totalHeight) {
  const segmentWidth = seg.x1 - seg.x0 + 1;
  let firstHash = 2166136261;
  let secondHash = 5381;

  for (let y = 0; y < totalHeight; y++) {
    for (let x = seg.x0; x <= seg.x1; x++) {
      const pixel = fg[y * imageWidth + x];
      firstHash = Math.imul(firstHash ^ pixel, 16777619);
      secondHash = Math.imul(secondHash, 33) ^ pixel;
    }
  }

  return `${segmentWidth}x${totalHeight}:${firstHash >>> 0}:${secondHash >>> 0}`;
}

async function createTesseractWorker() {
  const worker = await Tesseract.createWorker("fra", 1, {
    workerPath: chrome.runtime.getURL("lib/worker.min.js"),
    corePath: chrome.runtime.getURL("lib/tesseract-core-simd-lstm.wasm.js"),
    langPath: chrome.runtime.getURL("tessdata"),
    cacheMethod: "none",
    // Indispensable dans une extension Chrome : par défaut tesseract.js
    // instancie son worker via un Blob ("blob:" origin), qui n'a pas le
    // droit d'importScripts() une ressource chrome-extension://... même
    // listée en web_accessible_resources. En désactivant workerBlobURL,
    // le worker est instancié directement depuis workerPath (même
    // origine que l'extension) et peut importScripts ses dépendances
    // normalement.
    workerBlobURL: false,
    logger: () => { },
  });

  await worker.setParameters({
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    tessedit_pageseg_mode: "10", // PSM 10 = caractère unique
  });
  return worker;
}

function getScheduler() {
  if (tesseractScheduler) return Promise.resolve(tesseractScheduler);
  if (schedulerPromise) return schedulerPromise;

  const scheduler = Tesseract.createScheduler();
  schedulerPromise = createTesseractWorker()
    .then((worker) => {
      scheduler.addWorker(worker);
      tesseractScheduler = scheduler;
      // Préchauffe un 2e worker tout de suite (pendant que l'utilisateur
      // calibre, avant la première vraie lettre à lire) plutôt que
      // d'attendre réactivement d'avoir plusieurs cases en attente : la
      // toute première salve de reconnaissance de la partie profite déjà
      // du parallélisme au lieu de tourner sur un seul worker.
      warmAdditionalWorker();
      return scheduler;
    })
    .catch((error) => {
      schedulerPromise = null;
      throw error;
    });

  return schedulerPromise;
}

function warmAdditionalWorker() {
  if (!tesseractScheduler || additionalWorkerPromise) return;

  additionalWorkerPromise = createTesseractWorker()
    .then((worker) => tesseractScheduler.addWorker(worker))
    .catch(() => { });

}

/**
 * N'accepte une lettre reconnue que si l'OCR est assez confiant ; sinon
 * renvoie "_" pour ne pas fausser le filtrage par regex avec une lettre
 * probablement incorrecte.
 */
function acceptLetter(char, confidence) {
  return confidence >= LETTER_CONFIDENCE_THRESHOLD ? char : "_";
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

/**
 * Croppe la zone calibrée à la résolution native. L'upscale est reporté sur
 * les seules cases envoyées à Tesseract.
 */
function cropRegion(img, rect) {
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, rect.x, rect.y, w, h, 0, 0, w, h);
  return { canvas, ctx, width: w, height: h };
}

/**
 * Convertit en niveaux de gris + binarise (noir/blanc) in-place.
 * Retourne aussi un tableau Uint8Array "foreground" (1 = lettre/trait).
 */
function binarize(ctx, width, height) {
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  const fg = new Uint8Array(width * height);

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const isFg = lum > BIN_THRESHOLD ? 1 : 0;
    fg[p] = isFg;
    const v = isFg ? 255 : 0;
    data[i] = data[i + 1] = data[i + 2] = v;
    data[i + 3] = 255;
  }

  ctx.putImageData(imageData, 0, 0);
  return fg;
}

/**
 * Segmente l'image binaire en "cases" (blobs) via projection sur les
 * colonnes : une case = plage de colonnes contenant du premier plan,
 * séparée des voisines par un espace de fond.
 */
function segmentColumns(fg, width, height) {
  const columnPixelCounts = new Uint32Array(width);
  const columnMinY = new Uint32Array(width);
  const columnMaxY = new Int32Array(width);
  columnMinY.fill(height);
  columnMaxY.fill(-1);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      if (!fg[rowOffset + x]) continue;
      columnPixelCounts[x]++;
      if (columnMinY[x] === height) columnMinY[x] = y;
      columnMaxY[x] = y;
    }
  }

  const segments = [];
  function addSegment(x0, x1) {
    let minY = height;
    let maxY = -1;
    for (let x = x0; x <= x1; x++) {
      minY = Math.min(minY, columnMinY[x]);
      maxY = Math.max(maxY, columnMaxY[x]);
    }
    segments.push({ x0, x1, y0: minY, y1: maxY });
  }

  let start = -1;
  for (let x = 0; x < width; x++) {
    const hasForeground = columnPixelCounts[x] >= MIN_FG_PIXELS_PER_COL;
    if (hasForeground && start === -1) {
      start = x;
    } else if (!hasForeground && start !== -1) {
      addSegment(start, x - 1);
      start = -1;
    }
  }
  if (start !== -1) addSegment(start, width - 1);
  return segments;
}

function segmentFixedSlots(fg, width, height, slotCount) {
  const segments = [];
  for (let slot = 0; slot < slotCount; slot++) {
    const slotStart = Math.floor((slot * width) / slotCount);
    const slotEnd = Math.max(slotStart, Math.floor(((slot + 1) * width) / slotCount) - 1);
    let x0 = slotEnd + 1;
    let x1 = -1;
    let y0 = height;
    let y1 = -1;

    for (let y = 0; y < height; y++) {
      const rowOffset = y * width;
      for (let x = slotStart; x <= slotEnd; x++) {
        if (!fg[rowOffset + x]) continue;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    }

    segments.push(
      x1 < 0
        ? { x0: slotStart, x1: slotEnd, y0: height, y1: -1, empty: true }
        : { x0, x1, y0, y1 }
    );
  }
  return segments;
}

/**
 * Heuristique : un "_" est un blob bas et fin, positionné dans la moitié
 * inférieure de la case. Une vraie lettre occupe une hauteur bien plus
 * grande. Evite de demander à l'OCR de reconnaître "_" (peu fiable).
 */
function isUnderscoreSegment(seg, totalHeight) {
  const blobHeight = seg.y1 - seg.y0 + 1;
  const heightRatio = blobHeight / totalHeight;
  const verticalCenter = (seg.y0 + seg.y1) / 2 / totalHeight;
  return heightRatio < UNDERSCORE_HEIGHT_RATIO && verticalCenter > 0.5;
}

function extractSegmentCanvas(sourceCanvas, seg, totalHeight, padding = 6) {
  const segmentWidth = seg.x1 - seg.x0 + 1;
  const scaledWidth = segmentWidth * UPSCALE;
  const scaledHeight = totalHeight * UPSCALE;
  const w = scaledWidth + padding * 2;
  const h = scaledHeight + padding * 2;
  const out = new OffscreenCanvas(w, h);
  const ctx = out.getContext("2d");
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    sourceCanvas,
    seg.x0,
    0,
    segmentWidth,
    totalHeight,
    padding,
    padding,
    scaledWidth,
    scaledHeight
  );
  return out;
}

/**
 * Pipeline complet : capture (dataUrl) + rect calibré -> pattern texte
 * (ex: "_A__E_") + score de confiance moyen.
 */
async function runOcrPipeline(dataUrl, rect, referenceLength = null) {
  const img = await loadImage(dataUrl);
  const { canvas, ctx, width, height } = cropRegion(img, rect);
  const fg = binarize(ctx, width, height);
  let segments = segmentColumns(fg, width, height);
  if (
    Number.isInteger(referenceLength) &&
    referenceLength > 0 &&
    referenceLength <= 20 &&
    segments.length !== referenceLength
  ) {
    segments = segmentFixedSlots(fg, width, height, referenceLength);
  }

  if (segments.length === 0) {
    return { ok: false, error: "Aucune case détectée (zone vide ou mal calibrée)." };
  }

  const schedulerInitialization = getScheduler();
  const letters = new Array(segments.length);
  const confidences = [];
  const pendingByFingerprint = new Map();

  for (let index = 0; index < segments.length; index++) {
    const seg = segments[index];
    if (seg.empty || isUnderscoreSegment(seg, height)) {
      letters[index] = "_";
      continue;
    }

    const fingerprint = segmentFingerprint(fg, width, seg, height);
    const cached = ocrCache.get(fingerprint);
    if (cached) {
      ocrCache.delete(fingerprint);
      ocrCache.set(fingerprint, cached);
      letters[index] = acceptLetter(cached.char, cached.confidence);
      confidences.push(cached.confidence);
      continue;
    }

    let pendingItem = pendingByFingerprint.get(fingerprint);
    if (pendingItem) {
      pendingItem.indices.push(index);
      continue;
    }

    const segCanvas = extractSegmentCanvas(canvas, seg, height);
    pendingByFingerprint.set(fingerprint, {
      indices: [index],
      fingerprint,
      blobPromise: segCanvas.convertToBlob({ type: "image/png" }),
    });
  }

  const pending = [...pendingByFingerprint.values()];
  if (pending.length === 0) {
    schedulerInitialization
      .then(warmAdditionalWorker)
      .catch(() => { });
  } else {
    const scheduler = await schedulerInitialization;
    if (pending.length >= 3) warmAdditionalWorker();

    const results = await Promise.all(
      pending.map(async (item) => {
        const blob = await item.blobPromise;
        const { data } = await scheduler.addJob("recognize", blob);
        const raw = (data.text || "").trim().toUpperCase();
        return {
          ...item,
          char: raw.match(/[A-Z]/)?.[0] || "_",
          confidence: data.confidence ?? 0,
        };
      })
    );

    for (const result of results) {
      for (const index of result.indices) {
        letters[index] = acceptLetter(result.char, result.confidence);
        confidences.push(result.confidence);
      }
      ocrCache.set(result.fingerprint, {
        char: result.char,
        confidence: result.confidence,
      });
      if (ocrCache.size > OCR_CACHE_LIMIT) {
        ocrCache.delete(ocrCache.keys().next().value);
      }
    }
  }

  const avgConfidence =
    confidences.length > 0
      ? Math.round(confidences.reduce((a, b) => a + b, 0) / confidences.length)
      : 100;

  return {
    ok: true,
    pattern: letters.join(""),
    confidence: avgConfidence,
    segmentCount: segments.length,
  };
}

// Exposé pour offscreen.js
window.__ocrPipeline = { runOcrPipeline };