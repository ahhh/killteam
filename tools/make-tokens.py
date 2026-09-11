#!/usr/bin/env python3
"""Crop the operative portraits down to head tokens, in two sizes.

    python3 tools/make-tokens.py              # write assets/tokens/ and assets/pips/
    python3 tools/make-tokens.py --contact-sheet out.png   # eyeball the result

One crop, two outputs. The square 128px TOKEN goes next to a name in the roster
panel; the round 64px PIP goes on the operative's base on the battlefield, where
it is drawn about 40px across and there are twenty of them on screen at once.
The pip carries its circle in its own alpha channel rather than being clipped by
the renderer, so the battlefield draws it as a plain <image> and the team-colour
ring around the base is the only edge.

The portraits under assets/portraits/ are 512x768 full-body sketches, ~79KB
each and ~38MB for the set — far too much to put a face next to every name in
a roster panel. A token is the same art cropped to the head and shrunk to
TOKEN_PX, which lands around 4KB, so the whole set costs less than two
portraits.

Finding the head is the whole job, and two signals do it:

  1. YuNet face detection. Excellent on the bare human, ork and ratling faces,
     which is a little over half the set. It knows nothing about helmets, and
     it cheerfully reports the skull on a shoulder pad as a face.
  2. Silhouette geometry. The figure is ink on pale paper, so the head is the
     first blob below the crown that is wide enough not to be a raised weapon,
     ending where the shoulders flare out.

Neither is used alone. The silhouette runs first and gives a region; a face is
believed only if it lands inside that region, which is what rejects the
shoulder-pad skulls. Where a face IS confirmed it wins, because it frames the
features far better than a silhouette ever could.

Roughly 2% of the set still crops badly — a banner held high reads as a head,
and a drone or a swarm has no head to find. Those are pinned by name in
tools/token-overrides.json rather than being chased with more heuristics.
"""
import argparse, json, os, sys, urllib.request
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
PORTRAITS = ROOT / "assets" / "portraits"
TOKENS = ROOT / "assets" / "tokens"
PIPS = ROOT / "assets" / "pips"
OVERRIDES = Path(__file__).resolve().parent / "token-overrides.json"

TOKEN_PX = 128          # 2x the ~56px the roster draws
PIP_PX = 64             # ~1.5x what a base is drawn at, and a fifth of the bytes
QUALITY = 82

MODEL_URL = ("https://media.githubusercontent.com/media/opencv/opencv_zoo/main/"
             "models/face_detection_yunet/face_detection_yunet_2023mar.onnx")
MODEL_PATH = Path(
    os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "killteam" / "yunet.onnx"


# --------------------------------------------------------------------------
# Finding the head
# --------------------------------------------------------------------------

def load_bgr(path):
    return cv2.cvtColor(np.array(Image.open(path).convert("RGB")), cv2.COLOR_RGB2BGR)


def foreground_mask(bgr):
    """Ink-and-figure vs paper. The paper colour is read from the border."""
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    h, w = lab.shape[:2]
    b = max(4, int(min(h, w) * 0.02))
    border = np.concatenate([lab[:b].reshape(-1, 3), lab[-b:].reshape(-1, 3),
                             lab[:, :b].reshape(-1, 3), lab[:, -b:].reshape(-1, 3)])
    paper = np.median(border, axis=0)
    # Weight lightness over hue: these sketches vary in tint, not in tone.
    d = lab - paper
    dist = np.sqrt((d[..., 0]) ** 2 + (d[..., 1] * 0.7) ** 2 + (d[..., 2] * 0.7) ** 2)
    dist = cv2.GaussianBlur(dist, (0, 0), 3)
    norm = np.clip(dist / max(dist.max(), 1e-6) * 255, 0, 255).astype(np.uint8)
    _, m = cv2.threshold(norm, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    # Background hatching survives Otsu as speckle; the figure does not.
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN,
                         cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))
    return cv2.morphologyEx(m, cv2.MORPH_CLOSE,
                            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15)))


def largest_component(mask):
    n, lab, stats, _ = cv2.connectedComponentsWithStats((mask > 0).astype(np.uint8), 8)
    if n <= 1:
        return None
    return (lab == 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))).astype(np.uint8)


def _head_band(comp, h, w, cols=None):
    """The head band at the top of the figure, within an optional column window."""
    sub = comp if cols is None else comp[:, cols[0]:cols[1]]
    rows = cv2.GaussianBlur(
        sub.sum(axis=1).astype(np.float32).reshape(-1, 1), (0, 0), 3).ravel()
    body = float(rows.max())                       # shoulders, or the widest torso row
    if body < w * 0.05:
        return None
    # The crown is the first row thick enough to be a head rather than a raised
    # scythe, banner pole or antenna.
    thick = np.flatnonzero(rows > max(w * 0.06, body * 0.22))
    if len(thick) == 0:
        return None
    top = int(thick[0])
    if top > h * 0.45:
        return None
    # The neck is where the profile widens past anything a head could be.
    y = top
    while y < min(h - 1, top + int(h * 0.30)) and rows[y] < body * 0.62:
        y += 1
    height = int(np.clip(y - top, int(h * 0.08), int(h * 0.30)))
    band = sub[top:max(top + height, top + 2)]
    colw = band.sum(axis=0)
    cc = np.flatnonzero(colw > max(2, height * 0.12))
    if len(cc) == 0:
        cc = np.flatnonzero(colw > 0)
    if len(cc) == 0:
        return None
    off = cols[0] if cols else 0
    return (float(cc[0] + off), float(top), float(cc[-1] - cc[0]), float(height))


def head_from_silhouette(bgr):
    """Head box from the figure's width profile."""
    h, w = bgr.shape[:2]
    comp = largest_component(foreground_mask(bgr))
    if comp is None:
        return None
    box = _head_band(comp, h, w)
    if box is None:
        return None
    # A banner or spear held high IS wide enough to pass for a head, so a band
    # sitting well to the side of the torso is retried down the middle.
    mid = comp[int(h * 0.35):int(h * 0.75)]
    widths = mid.sum(axis=0).astype(int)
    if widths.sum():
        torso_cx = float(np.median(np.repeat(np.arange(mid.shape[1]), widths)))
        if abs((box[0] + box[2] / 2) - torso_cx) > w * 0.20:
            window = (int(max(0, torso_cx - w * 0.26)), int(min(w, torso_cx + w * 0.26)))
            box = _head_band(comp, h, w, window) or box
    return box


_det = None

def head_from_face(bgr, band=None):
    """YuNet's face box grown to a head box, vetted against the silhouette.

    These sketches put skulls on shoulder pads and faces on gun casings, and
    YuNet reports those as confidently as a real one — so a detection counts
    only where the silhouette already says the head is.
    """
    global _det
    if _det is None:
        _det = cv2.FaceDetectorYN.create(str(MODEL_PATH), "", (320, 320), 0.6, 0.3, 5000)
    h, w = bgr.shape[:2]
    best = None
    for s in (1.0, 2.0):                           # the upscaled pass catches small heads
        im = cv2.resize(bgr, (int(w * s), int(h * s))) if s != 1.0 else bgr
        _det.setInputSize((im.shape[1], im.shape[0]))
        _, faces = _det.detect(im)
        if faces is None:
            continue
        for f in faces:
            x, y, fw, fh, score = f[0] / s, f[1] / s, f[2] / s, f[3] / s, float(f[-1])
            cx, cy = x + fw / 2, y + fh / 2
            if cy > h * 0.5:                       # a "face" on the torso is a texture hit
                continue
            if band is not None:
                bx, by, bw, bh = band
                if not (bx - bw * 0.5 <= cx <= bx + bw * 1.5):
                    continue
                if not (by - bh * 0.5 <= cy <= by + bh * 1.6):
                    continue
            if best is None or score > best[4]:
                best = (x, y, fw, fh, score)
    if best is None:
        return None
    x, y, fw, fh, _ = best
    # A face box is the features alone: grow out for the skull, up for the crown.
    cx, cy = x + fw / 2, y + fh / 2
    return (cx - fw * 1.75 / 2, cy - fh * 1.75 / 2 - fh * 0.22, fw * 1.75, fh * 1.75)


def head_box(bgr):
    """(x, y, w, h, source) for the head.

    Silhouette first — not because it is more precise, but because it is the
    sanity check the face detector needs.
    """
    sil = head_from_silhouette(bgr)
    face = head_from_face(bgr, band=sil)
    if face:
        return (*face, "face")
    if sil:
        return (*sil, "silhouette")
    h, w = bgr.shape[:2]                           # last resort: where heads usually are
    return (w / 2 - w * 0.21, h * 0.06, w * 0.42, w * 0.42, "fallback")


def token_rect(bgr, pad=1.34, bias_down=0.10):
    """The square crop, clamped inside the image."""
    h, w = bgr.shape[:2]
    x, y, bw, bh, src = head_box(bgr)
    # Horned and crested helmets push the box top well above the face, so the
    # square sits a little low: face centred, shoulders in, horns still inside.
    cx, cy = x + bw / 2, y + bh / 2 + bh * bias_down
    # Heads in this art run 13-22% of image height. A crop far outside that
    # range means the finder drifted, and a clamp beats a full-body shot.
    side = float(np.clip(max(bw, bh) * pad, h * 0.20, h * 0.42))
    side = min(side, float(min(h, w)))
    cx = float(np.clip(cx, side / 2, w - side / 2))
    cy = float(np.clip(cy, side / 2, h - side / 2))
    return int(round(cx - side / 2)), int(round(cy - side / 2)), int(round(side)), src


# --------------------------------------------------------------------------
# Writing the set
# --------------------------------------------------------------------------

def ensure_model():
    if MODEL_PATH.exists():
        return
    MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
    print(f"fetching face model -> {MODEL_PATH}")
    urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)


def load_overrides():
    """Hand corrections, as {"team/profile": [cx, cy, side]} in image fractions."""
    if not OVERRIDES.exists():
        return {}
    return {k: v for k, v in json.loads(OVERRIDES.read_text()).items()
            if not k.startswith("_")}


def override_rect(bgr, frac):
    """Resolve a fractional override against this image.

    Stored relative rather than in pixels because the art pipeline installs
    portraits at whatever --width it is given — the set is currently a mix of
    512x768 and 640x960 — and a pixel rectangle silently points somewhere else
    the moment its portrait is re-installed at another size.
    """
    h, w = bgr.shape[:2]
    cx, cy, side_f = float(frac[0]) * w, float(frac[1]) * h, float(frac[2]) * w
    side = int(round(min(side_f, w, h)))
    x = int(round(np.clip(cx - side / 2, 0, w - side)))
    y = int(round(np.clip(cy - side / 2, 0, h - side)))
    return x, y, side


def circular_pip(crop_bgr):
    """The square crop as a small RGBA circle, edges antialiased.

    The mask is drawn at 4x and shrunk, which is the cheapest way to get a
    clean edge out of cv2.circle — at 64px a hard-edged mask reads as a
    cog rather than a circle once the battlefield zooms in.
    """
    rgb = cv2.cvtColor(cv2.resize(crop_bgr, (PIP_PX, PIP_PX),
                                  interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB)
    big = PIP_PX * 4
    mask = np.zeros((big, big), np.uint8)
    cv2.circle(mask, (big // 2, big // 2), big // 2 - 2, 255, -1)
    alpha = cv2.resize(mask, (PIP_PX, PIP_PX), interpolation=cv2.INTER_AREA)
    return Image.fromarray(np.dstack([rgb, alpha]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--contact-sheet", metavar="PNG",
                    help="also write a grid of every token, for review")
    ap.add_argument("--only", help="limit to one team id")
    args = ap.parse_args()

    ensure_model()
    overrides = load_overrides()
    sources = sorted(PORTRAITS.glob("*/*.webp"))
    if args.only:
        sources = [p for p in sources if p.parent.name == args.only]
    if not sources:
        sys.exit("no portraits found")

    counts, written, pips, crops = {}, [], [], []
    for path in sources:
        team, name = path.parent.name, path.stem
        bgr = load_bgr(path)
        key = f"{team}/{name}"
        if key in overrides:
            x, y, side = override_rect(bgr, overrides[key])
            src = "override"
        else:
            x, y, side, src = token_rect(bgr)
        counts[src] = counts.get(src, 0) + 1
        crop = bgr[y:y + side, x:x + side]
        crop = cv2.resize(crop, (TOKEN_PX, TOKEN_PX), interpolation=cv2.INTER_AREA)
        crops.append((key, crop))

        out = TOKENS / team / f"{name}.webp"
        out.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)).save(
            out, "WEBP", quality=QUALITY, method=6)
        written.append(out)

        pip = PIPS / team / f"{name}.webp"
        pip.parent.mkdir(parents=True, exist_ok=True)
        circular_pip(crop).save(pip, "WEBP", quality=QUALITY, method=6)
        pips.append(pip)

    # Measured over what this run actually wrote, so --only reports its subset
    # rather than the whole directory divided by a handful of files.
    total = sum(f.stat().st_size for f in written)
    print(f"wrote {len(written)} tokens  ({total / 1024:.0f}KB, "
          f"{total / max(len(written), 1) / 1024:.1f}KB each)")
    pip_total = sum(f.stat().st_size for f in pips)
    print(f"wrote {len(pips)} pips    ({pip_total / 1024:.0f}KB, "
          f"{pip_total / max(len(pips), 1) / 1024:.1f}KB each)")
    print("  head found by: " + ", ".join(f"{k} {v}" for k, v in sorted(counts.items())))

    if args.contact_sheet:
        cols = 16
        rows = (len(crops) + cols - 1) // cols
        cell = 96
        sheet = Image.new("RGB", (cols * cell, rows * cell), (18, 18, 20))
        for i, (_, c) in enumerate(crops):
            im = Image.fromarray(cv2.cvtColor(
                cv2.resize(c, (cell, cell)), cv2.COLOR_BGR2RGB))
            sheet.paste(im, ((i % cols) * cell, (i // cols) * cell))
        sheet.save(args.contact_sheet)
        print(f"  contact sheet -> {args.contact_sheet}")


if __name__ == "__main__":
    main()
