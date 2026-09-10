/**
 * Operative portrait loading (§25).
 *
 * There are 470 portraits under assets/portraits/, roughly 25MB. Loading them
 * with the app would multiply first paint by two orders of magnitude for art
 * that is only ever seen inside a character sheet — so nothing here touches the
 * network until an operative's sheet is actually opened.
 *
 * Two levels of laziness, and both matter:
 *
 *   1. No <img> exists until renderOperativeDetail() asks for one. The roster
 *      panels, which are on screen for the whole battle, deliberately show no
 *      art at all.
 *   2. The manifest — the index of which operatives have art — is fetched once,
 *      on the FIRST sheet opened, and shared by every sheet after it. Without
 *      it the app would have to probe each URL and eat a 404 per operative that
 *      hasn't been drawn yet.
 *
 * The manifest is written by the art pipeline
 * (image_gen_pipeline/generate_killteam_art.py manifest). If it is missing the
 * app still works: hasPortrait() falls back to optimistic, and a portrait that
 * doesn't exist simply removes itself on error.
 */

const PORTRAIT_BASE = './assets/portraits';
const MANIFEST_URL = `${PORTRAIT_BASE}/manifest.json`;

/** null until the first sheet is opened; then the parsed manifest, or false. */
let manifest = null;
/** In-flight fetch, so ten fast clicks share one request. */
let pending = null;

/**
 * Fetch the index, at most once per session.
 *
 * A failure is cached as `false` rather than retried: the file either ships
 * with the build or it doesn't, and retrying on every sheet would turn one
 * missing file into a request per click.
 */
export function loadManifest() {
  if (manifest !== null) return Promise.resolve(manifest);
  if (pending) return pending;
  pending = fetch(MANIFEST_URL, { cache: 'force-cache' })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
    .then((data) => {
      manifest = data && typeof data.teams === 'object' ? data : false;
      return manifest;
    })
    .catch(() => {
      manifest = false;
      return manifest;
    })
    .finally(() => { pending = null; });
  return pending;
}

/** The URL for one operative's portrait. Does not check that it exists. */
export function portraitUrl(teamId, profileId) {
  const ext = (manifest && manifest.ext) || '.webp';
  return `${PORTRAIT_BASE}/${encodeURIComponent(teamId)}/${encodeURIComponent(profileId)}${ext}`;
}

/**
 * Is this operative drawn? Optimistic when the manifest hasn't loaded or is
 * absent — a wrong "yes" costs one hidden broken image, a wrong "no" costs art
 * the player paid to generate.
 */
export function hasPortrait(teamId, profileId) {
  if (!manifest) return true;
  return (manifest.teams[teamId] || []).includes(profileId);
}

/**
 * Build the portrait element for one operative, or null if it has no art.
 *
 * Returns synchronously so the sheet renders in one pass with no layout jump:
 * the figure is created immediately at a fixed aspect ratio and reveals itself
 * on load. The manifest fetch it kicks off only affects LATER sheets.
 */
export function createPortrait(pack, profile) {
  loadManifest();
  if (!profile || !hasPortrait(pack.id, profile.id)) return null;

  const figure = document.createElement('figure');
  figure.className = 'portrait';

  const img = document.createElement('img');
  img.src = portraitUrl(pack.id, profile.id);
  // Native lazy loading covers the case where a sheet is opened and scrolled
  // before the image is in view; decoding off-thread keeps the modal snappy.
  img.loading = 'lazy';
  img.decoding = 'async';
  img.alt = `${profile.name} — illustration`;
  img.addEventListener('load', () => figure.classList.add('loaded'));
  // A portrait that 404s (art not generated yet, or a stale manifest) takes
  // itself off screen rather than showing a broken-image glyph.
  img.addEventListener('error', () => figure.remove());
  figure.append(img);

  const caption = document.createElement('figcaption');
  caption.textContent = 'Generated illustration · not official artwork';
  figure.append(caption);
  return figure;
}
