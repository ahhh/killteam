/**
 * Operative art loading (§25).
 *
 * Three sizes of the same pictures, with very different budgets:
 *
 *   PORTRAIT  assets/portraits/<team>/<profile>.webp — 512x768, ~79KB, 38MB
 *             for the set. Only ever seen inside a character sheet, so no
 *             <img> exists until renderOperativeDetail() asks for one.
 *   TOKEN     assets/tokens/<team>/<profile>.webp — the same art cropped to
 *             the operative's head and shrunk to 128px, ~4.5KB. Cheap enough
 *             to put a face on every card in the roster panels, which is what
 *             the portraits were far too heavy to do.
 *   PIP       assets/pips/<team>/<profile>.webp — the same crop again at 64px
 *             and round, ~1.4KB, for the operative's base on the battlefield.
 *             The board redraws on every action with twenty of these on it, so
 *             it gets the cheapest size there is.
 *
 * Tokens and pips are generated from the portraits by tools/make-tokens.py and
 * exist for exactly the same operatives, so hasPortrait() answers for all three
 * and the manifest needs nothing new. Art that is missing because the pipeline
 * ran without the crop step simply removes itself on error.
 *
 * A team VARIANT has no art of its own and never will: it fields its base
 * team's datacards, so it is the same operatives drawn once. Everything here
 * therefore asks a PACK, not a team id, which operatives it is drawing — see
 * artTeamId().
 *
 * The manifest — the index of which operatives have art — is fetched once, on
 * the first card or sheet that needs it, and shared by everything after it.
 * Without it the app would have to probe each URL and eat a 404 per operative
 * that hasn't been drawn yet. It is written by the art pipeline
 * (image_gen_pipeline/generate_killteam_art.py manifest); if it is missing the
 * app still works, because hasPortrait() falls back to optimistic.
 */

const PORTRAIT_BASE = './assets/portraits';
const TOKEN_BASE = './assets/tokens';
const PIP_BASE = './assets/pips';
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
 *
 * `no-cache` — revalidate, not refetch — because this file names every
 * operative that has been drawn, so it changes on exactly the deploys that add
 * art. `force-cache` served whatever copy the browser already had, fresh or
 * stale, and never asked again: a returning player kept a manifest from before
 * a team was drawn and hasPortrait() then answered "no art" for a team whose
 * art was sitting on the server. The revalidation costs one 304 per session.
 * This matches how data/loader.js fetches the packs themselves.
 */
export function loadManifest() {
  if (manifest !== null) return Promise.resolve(manifest);
  if (pending) return pending;
  pending = fetch(MANIFEST_URL, { cache: 'no-cache' })
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

/** The URL for one operative's head token. Does not check that it exists. */
export function tokenUrl(teamId, profileId) {
  const ext = (manifest && manifest.ext) || '.webp';
  return `${TOKEN_BASE}/${encodeURIComponent(teamId)}/${encodeURIComponent(profileId)}${ext}`;
}

/** The URL for one operative's battlefield pip. Does not check that it exists. */
export function pipUrl(teamId, profileId) {
  const ext = (manifest && manifest.ext) || '.webp';
  return `${PIP_BASE}/${encodeURIComponent(teamId)}/${encodeURIComponent(profileId)}${ext}`;
}

/**
 * Which team's art a pack draws from.
 *
 * A variant is the same datacards fielded a different way (tools/make-variants.mjs),
 * so it borrows its base team's pictures rather than owning a second copy of
 * them under its own id — and the manifest lists only the teams that were
 * actually drawn.
 */
export function artTeamId(pack) {
  if (typeof pack === 'string') return pack;
  return (pack && (pack.variantOf || pack.id)) || '';
}

/**
 * Is this operative drawn? Optimistic when the manifest hasn't loaded or is
 * absent — a wrong "yes" costs one hidden broken image, a wrong "no" costs art
 * the player paid to generate.
 *
 * A team the manifest has never heard of gets the same benefit of the doubt.
 * Every bundled team is drawn, so an absent team id means the manifest in hand
 * is older than the team — a stale cache, or a pack imported against a build
 * that predates it — and answering "no art" there is the one failure the
 * player actually sees. An operative missing from a team the manifest DOES
 * list is a real gap in that team's art, and is still answered honestly.
 */
export function hasPortrait(teamId, profileId) {
  if (!manifest) return true;
  const drawn = manifest.teams[teamId];
  if (!drawn) return true;
  return drawn.includes(profileId);
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
  const team = artTeamId(pack);
  if (!profile || !hasPortrait(team, profile.id)) return null;

  const figure = document.createElement('figure');
  figure.className = 'portrait';

  const img = document.createElement('img');
  img.src = portraitUrl(team, profile.id);
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

/**
 * The roster card's head token for one operative, or null if it has no art.
 *
 * Cached by operative, and the SAME element is handed back every time. The
 * roster panel rebuilds itself with replaceChildren() on every action, so a
 * fresh <img> per render would restart the fade on each shot fired even though
 * the bytes were already in cache. Re-appending the existing node just moves
 * it. The key carries the profile as well as the operative id, because ids
 * repeat across battles while the team behind them does not.
 *
 * Note this is unrelated to `rules/tokens.js` — Poison, Blaze and the rest of
 * the token family are game state, not pictures.
 */
const tokenCache = new Map();

export function createOperativeToken(pack, profile, operativeId) {
  loadManifest();
  const teamId = artTeamId(pack);
  if (!profile || !hasPortrait(teamId, profile.id)) return null;

  const key = `${operativeId}|${teamId}/${profile.id}`;
  const cached = tokenCache.get(key);
  if (cached) return cached;

  const figure = document.createElement('figure');
  figure.className = 'op-token';

  const img = document.createElement('img');
  img.src = tokenUrl(teamId, profile.id);
  // A roster holds a dozen or so of these and the panel scrolls, so let the
  // browser skip the ones below the fold entirely.
  img.loading = 'lazy';
  img.decoding = 'async';
  img.width = 128;
  img.height = 128;
  // The card already says the name, so the token is decoration to a screen
  // reader rather than a second announcement of it.
  img.alt = '';
  img.addEventListener('load', () => figure.classList.add('loaded'));
  // A token that 404s (crops not generated, or a stale manifest) takes itself
  // off screen rather than showing a broken-image glyph.
  img.addEventListener('error', () => {
    figure.remove();
    tokenCache.delete(key);
  });
  figure.append(img);

  tokenCache.set(key, figure);
  return figure;
}

/**
 * The URL of the pip to draw on this operative's base, or null if the operative
 * has no art.
 *
 * The battlefield is SVG, where an <img> would be an <image> in another
 * namespace and `loading="lazy"` does not exist — so this hands back a URL and
 * lets ui/battlefield.js build its own node (and drop it on error, the way the
 * other two sizes do). Taking the profile ID rather than the profile keeps the
 * renderer from having to look a datacard up per operative per frame.
 */
export function operativePipUrl(pack, profileId) {
  loadManifest();
  const teamId = artTeamId(pack);
  if (!profileId || !hasPortrait(teamId, profileId)) return null;
  return pipUrl(teamId, profileId);
}
