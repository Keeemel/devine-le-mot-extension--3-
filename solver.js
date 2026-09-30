// solver.js — filtrage du dictionnaire à partir d'un pattern OCR nettoyé.
// Module ES, utilisé par le service worker (background.js).

let wordlistCache = null;
let wordIndexCache = null;
let localModelPromise = null;

const MAX_LOCAL_RANKING_CANDIDATES = 12000;

/**
 * Charge wordlist.json (une seule fois, mis en cache en mémoire).
 */
export async function loadWordlist() {
  if (wordlistCache) return wordlistCache;
  const url = chrome.runtime.getURL("wordlist.json");
  const res = await fetch(url);
  wordlistCache = await res.json();
  return wordlistCache;
}

async function loadLocalLanguageModel() {
  if (!localModelPromise) {
    const url = chrome.runtime.getURL("word_model.json");
    localModelPromise = fetch(url)
      .then((response) => response.ok ? response.json() : null)
      .catch(() => null);
  }
  return localModelPromise;
}

/**
 * Normalise les confusions fréquentes de l'OCR sur des caractères latins.
 * Ne touche pas au caractère "_" qui représente une lettre inconnue.
 */
export function normalizeOcrConfusions(raw) {
  return raw
    .toUpperCase()
    .replace(/[ÀÂÄ]/g, "A")
    .replace(/[ÉÈÊË]/g, "E")
    .replace(/[ÎÏ]/g, "I")
    .replace(/[ÔÖ]/g, "O")
    .replace(/[ÙÛÜ]/g, "U")
    .replace(/Ç/g, "C")
    .replace(/0/g, "O")
    .replace(/1/g, "I")
    .replace(/\|/g, "I")
    .replace(/8/g, "B")
    .replace(/[^A-Z_]/g, "_"); // tout caractère non reconnu -> lettre inconnue
}

/**
 * Construit une regex à partir d'un pattern type "_A__E_".
 * "_" (ou tout caractère hors A-Z) devient un "." (n'importe quelle lettre).
 */
export function patternToRegex(pattern) {
  const body = pattern
    .split("")
    .map((ch) => (/[A-Z]/.test(ch) ? ch : "."))
    .join("");
  return new RegExp(`^${body}$`);
}

/**
 * Étend un pattern OCR avec ses variantes ambiguës courantes.
 * Ex : "_L__T_" devient aussi "_T__L_" pour compenser les erreurs L/T.
 */
export function expandAmbiguousPatterns(pattern) {
  const ambiguous = {
    L: ["L", "T"],
    T: ["T", "L"],
    I: ["I", "L"],
    O: ["O", "0"],
    B: ["B", "8"],
    0: ["0", "O"],
    1: ["1", "I"],
    8: ["8", "B"],
  };

  const variants = [pattern];
  const expanded = [];

  while (variants.length) {
    const current = variants.pop();
    const chars = current.split("");
    let hasAmbiguity = false;

    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      const opts = ambiguous[ch];
      if (!opts) continue;
      hasAmbiguity = true;
      for (const opt of opts) {
        const next = chars.slice();
        next[i] = opt;
        variants.push(next.join(""));
      }
      break;
    }

    if (!hasAmbiguity) expanded.push(current);
  }

  return [...new Set(expanded)];
}

const AMBIGUOUS_CHARACTERS = {
  R: ["R", "I", "L", "O"],
  L: ["L", "I", "R", "O", "T"],
  I: ["I", "L", "R", "O"],
  O: ["O", "I", "L", "R", "Q"],
  T: ["T", "L", "I"],
  Q: ["Q", "O"],
  B: ["B", "8"],
};

async function loadWordIndex(length) {
  const key = String(length);
  if (wordIndexCache?.[key]) return wordIndexCache[key];

  const dictionary = await loadWordlist();
  const entries = dictionary[key] || [];
  if (entries.length === 0) return null;

  const positions = Array.from({ length }, () => new Map());
  for (const entry of entries) {
    for (let position = 0; position < entry.word.length; position++) {
      const letter = entry.word[position];
      let bucket = positions[position].get(letter);
      if (!bucket) {
        bucket = [];
        positions[position].set(letter, bucket);
      }
      bucket.push(entry);
    }
  }

  const index = { entries, positions };
  wordIndexCache ??= {};
  wordIndexCache[key] = index;
  return index;
}

function findMatches(pattern, index, allowAmbiguous) {
  let seed = null;
  const constraints = [];

  for (let position = 0; position < pattern.length; position++) {
    const letter = pattern[position];
    if (letter === "_") continue;

    const acceptedLetters = allowAmbiguous
      ? AMBIGUOUS_CHARACTERS[letter] || [letter]
      : [letter];
    const matchingEntries = [];
    for (const acceptedLetter of acceptedLetters) {
      const bucket = index.positions[position].get(acceptedLetter);
      if (bucket) matchingEntries.push(...bucket);
    }
    if (matchingEntries.length === 0) return [];

    constraints.push({ position, acceptedLetters: new Set(acceptedLetters) });
    if (!seed || matchingEntries.length < seed.length) seed = matchingEntries;
  }

  const matches = (seed || index.entries).filter((entry) =>
    constraints.every(({ position, acceptedLetters }) =>
      acceptedLetters.has(entry.word[position])
    )
  );
  matches.sort((a, b) => b.freq - a.freq);
  return matches;
}

function scoreWordWithLocalModel(word, model) {
  const padded = `^^${word}$`;
  const smoothing = 0.1;
  let score = 0;

  for (let index = 0; index < padded.length - 2; index++) {
    const context = padded.slice(index, index + 2);
    const trigram = padded.slice(index, index + 3);
    const contextCount = model.contexts[context] || 0;
    const trigramCount = model.trigrams[trigram] || 0;
    score += Math.log(
      (trigramCount + smoothing) /
      (contextCount + smoothing * model.alphabetSize)
    );
  }

  return score;
}

function rankWithLocalModel(entries, model) {
  if (!model || entries.length < 2) return entries;

  const scored = entries.map((entry) => ({
    entry,
    languageScore: scoreWordWithLocalModel(entry.word, model),
    frequencyScore: Math.log1p(entry.freq),
  }));
  const minLanguage = Math.min(...scored.map((item) => item.languageScore));
  const maxLanguage = Math.max(...scored.map((item) => item.languageScore));
  const minFrequency = Math.min(...scored.map((item) => item.frequencyScore));
  const maxFrequency = Math.max(...scored.map((item) => item.frequencyScore));
  const normalize = (value, min, max) => max === min ? 0.5 : (value - min) / (max - min);

  scored.sort((left, right) => {
    const leftScore =
      0.65 * normalize(left.languageScore, minLanguage, maxLanguage) +
      0.35 * normalize(left.frequencyScore, minFrequency, maxFrequency);
    const rightScore =
      0.65 * normalize(right.languageScore, minLanguage, maxLanguage) +
      0.35 * normalize(right.frequencyScore, minFrequency, maxFrequency);
    return rightScore - leftScore || right.entry.freq - left.entry.freq;
  });
  return scored.map((item) => item.entry);
}

function countChangedLetters(pattern, word) {
  let count = 0;
  for (let index = 0; index < pattern.length; index++) {
    if (pattern[index] !== "_" && pattern[index] !== word[index]) count++;
  }
  return count;
}

/**
 * Filtre le dictionnaire par longueur et lettres connues via un index positionnel.
 * @param {string} pattern - ex: "_A__E_"
 * @returns {Array<{word:string, freq:number}>}
 */
export async function solve(pattern) {
  if (!pattern || !/^[A-Z_]+$/.test(pattern)) return [];

  const index = await loadWordIndex(pattern.length);
  if (!index) return [];

  const directMatches = findMatches(pattern, index, false);
  const exactWords = new Set(directMatches.map((entry) => entry.word));
  const ambiguousMatches = findMatches(pattern, index, true).filter(
    (entry) => !exactWords.has(entry.word)
  );
  const allMatches = directMatches.concat(ambiguousMatches);
  const localModel = allMatches.length <= MAX_LOCAL_RANKING_CANDIDATES
    ? await loadLocalLanguageModel()
    : null;
  const rankedDirect = rankWithLocalModel(directMatches, localModel);

  const ambiguousByDistance = new Map();
  for (const entry of ambiguousMatches) {
    const distance = countChangedLetters(pattern, entry.word);
    let group = ambiguousByDistance.get(distance);
    if (!group) {
      group = [];
      ambiguousByDistance.set(distance, group);
    }
    group.push(entry);
  }

  const rankedAmbiguous = [];
  for (const distance of [...ambiguousByDistance.keys()].sort((a, b) => a - b)) {
    rankedAmbiguous.push(
      ...rankWithLocalModel(ambiguousByDistance.get(distance), localModel)
    );
  }

  return rankedDirect.concat(rankedAmbiguous);
}

/**
 * Vérifie qu'un pattern OCR est plausible : longueur cohérente si une
 * longueur de référence est connue, et composé uniquement de A-Z / "_".
 */
export function isPatternPlausible(pattern, referenceLength = null) {
  if (!/^[A-Z_]+$/.test(pattern)) return false;
  if (referenceLength && pattern.length !== referenceLength) return false;
  return true;
}
