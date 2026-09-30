# Devine le Mot — Assistant OCR (extension Chrome MV3)

Résout en local (aucun appel réseau) le jeu "mot mystère" affiché en image,
en lisant la zone à l'écran par OCR (Tesseract.js) et en proposant les mots
candidats compatibles avec le pattern détecté.

## Installation (mode développeur)

1. Décompresse le dossier de l'extension quelque part sur ton disque.
2. Ouvre `chrome://extensions`.
3. Active le **Mode développeur** (interrupteur en haut à droite).
4. Clique **Charger l'extension non empaquetée** et sélectionne le dossier.
5. L'icône de l'extension apparaît dans la barre d'outils.

## Utilisation

1. Va sur la page du jeu, clique sur l'icône de l'extension → **Recalibrer
   la zone**.
2. Un cadre violet apparaît au centre de l'écran : déplace-le et
   redimensionne-le (poignées aux coins) pour l'ajuster précisément sur la
   zone où le mot mystère s'affiche.
3. (Optionnel mais recommandé) Renseigne le **nombre de lettres** du mot —
   utile dès la première frame (toutes les cases sont vides à "_") pour
   rejeter les lectures OCR de longueur incohérente.
4. Clique **Valider**. La calibration est sauvegardée (par nom de domaine)
   dans `chrome.storage.local` : pas besoin de la refaire à chaque partie.
5. Une petite fenêtre flottante apparaît en haut à droite avec :
  - une case modifiable par lettre pour corriger l'OCR ; les propositions sont recalculées automatiquement ;
  - tous les candidats compatibles, affichés par lots dans une grille ; clique un mot pour le copier en minuscules ;
  - le score de confiance OCR et le nombre total de candidats ;
  - ↻ pour commencer un nouveau mot, ⏸ pour mettre en pause et ⚙️ pour recalibrer.

## Comment ça marche (pipeline)

1. **Capture** : `chrome.tabs.captureVisibleTab()` depuis le service worker,
  avec une pause minimale de 550 ms entre deux captures.
2. **Crop + prétraitement**, dans un **document offscreen** (`offscreen.html`)
   qui a accès au DOM/canvas (contrairement au service worker) :
   - niveaux de gris + binarisation (seuil réglable, `BIN_THRESHOLD` dans
     `ocr.js`) — le fond très sombre / lettres très claires du jeu rend ce
     seuillage simple très fiable ;
  - binarisation et segmentation à la résolution native, puis upscale x4 des seules cases envoyées à l'OCR ;
   - **segmentation en cases individuelles** par projection sur les colonnes
     (une case = un bloc de pixels "premier plan" séparé des voisins par du
    fond) ; si le compte de cases diffère de la longueur connue, un découpage
    en positions fixes est utilisé en secours.
3. **Classification heuristique par case** : une case dont le bloc est bas et
   fin (trait horizontal en bas de case) est directement classée `_` sans
  passer par l'OCR. Les autres cases sont envoyées en parallèle à Tesseract
  (`PSM 10`, whitelist `A-Z`) ; les images identiques sont mises en cache.
4. **Debounce** (`content.js`) : un pattern doit être lu identique 2 captures
   de suite avant d'être affiché/validé, pour absorber une lecture foireuse
   isolée.
5. **Résolution** (`solver.js`) : un index par longueur et position filtre
  `wordlist.json`. Les correspondances exactes précèdent les alternatives
  aux confusions OCR, dont R/I/L/O, triées par proximité.
6. **Classement IA local** : un modèle compact de trigrammes de caractères,
  généré depuis le dictionnaire, réordonne les petits groupes de candidats.
  Il fonctionne hors ligne, sans envoyer les captures ni le motif à un service.

## Fichiers

| Fichier | Rôle |
|---|---|
| `manifest.json` | Config MV3 (permissions, offscreen, content script) |
| `background.js` | Service worker : capture d'écran, orchestration, cache |
| `offscreen.html/.js` | Document offscreen : pont vers `ocr.js` |
| `ocr.js` | Crop, seuillage, upscale, segmentation, OCR Tesseract |
| `content.js` | Overlay de calibration + overlay de résultats + boucle de scan |
| `content.css` | Styles des deux overlays |
| `popup.html/.js` | Bouton recalibrer / pause depuis la barre d'outils |
| `solver.js` | Normalisation OCR + regex + filtrage du dictionnaire |
| `wordlist.json` | Dictionnaire français et gaming embarqué, utilisé hors ligne |
| `word_model.json` | Modèle linguistique compact, embarqué et hors ligne |
| `build_wordlist.py` | Génère le dictionnaire et son modèle local |
| `lib/` | Tesseract.js bundlé en local (`tesseract.min.js`, `worker.min.js`, cœur wasm SIMD+LSTM) |
| `tessdata/fra.traineddata.gz` | Modèle de langue français, compressé |

Tout est 100% local : `lib/` et `tessdata/` sont déjà présents dans ce
livrable (téléchargés depuis les paquets npm officiels `tesseract.js` /
`tesseract.js-core`, et depuis le dépôt `tessdata` de la communauté
Tesseract), rien n'est chargé depuis un CDN externe au runtime — conforme
à la CSP des extensions Chrome.

## Étendre le dictionnaire

Pour enrichir le dictionnaire, lance `build_wordlist.py`. Le script télécharge
des listes publiques, les normalise, les déduplique et ajoute un lexique de
termes anglais de jeu vidéo (dont les abréviations usuelles de deux lettres)
avant de produire `wordlist.json` :

```powershell
py build_wordlist.py
```

Le téléchargement se fait uniquement pendant la construction. L'extension
continue ensuite à fonctionner sans Internet et ne fait aucun appel réseau
pendant le scan. Le format produit est :

  ```json
  { "6": [{"word": "ARBRE", "freq": 842}, ...], "7": [...] }
  ```

`solver.js` n'a rien à changer après la régénération.

Sources du dictionnaire : [FrequencyWords](https://github.com/hermitdave/FrequencyWords)
(MIT, Copyright 2016 Hermit Dave) et [an-array-of-french-words](https://github.com/words/an-array-of-french-words)
(MIT, Zeke Sikelianos et contributeurs).

## Réglages à ajuster selon le jeu réel

Tout est en haut de `ocr.js` :

- `BIN_THRESHOLD` (défaut 150) — seuil de luminance niveaux de gris pour
  la binarisation. Si des lettres claires sont ratées ou si du bruit de
  fond passe en "premier plan", ajuste ce seuil.
- `UPSCALE` (défaut 4) — augmente si la police du jeu est petite.
- `UNDERSCORE_HEIGHT_RATIO` (défaut 0.33) — ratio hauteur-de-bloc /
  hauteur-de-case en dessous duquel un bloc est classé "_" plutôt que
  lettre. A ajuster si le trait "_" du jeu est plus épais/haut.
- `MIN_FG_PIXELS_PER_COL` — nombre minimal de pixels "premier plan" par
  colonne pour ne pas la considérer comme un espace entre deux cases.

## Limites connues

- Le pipeline suppose un fort contraste fond/lettres (c'est le cas dans
  les captures fournies). Sur un jeu à fond clair, inverse la condition
  de binarisation dans `ocr.js` (`lum > BIN_THRESHOLD` → `lum < ...`).
- La segmentation par colonnes suppose des cases nettement séparées par
  un espace de fond. Si deux lettres se touchent visuellement, augmente
  `UPSCALE` ou ajuste le seuil de binarisation plutôt que la segmentation.
- Les listes distantes peuvent évoluer ou devenir indisponibles ; les mots
  de secours intégrés permettent malgré tout de générer un fichier valide.
