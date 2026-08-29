"""Read the notation on the Math PDF's raster pages.

Most of the dump draws notation as vector paths, which `glyphmap` decodes
exactly by hashing each path's shape. 434 of the 2,030 pages instead embed the
notation as a bitmap. A bitmap carries no path, so there is nothing to hash and
those expressions could only ever be cropped and shown as pictures.

The bitmaps are renderings of the same typeface, though, so the shapes are
already known: render each labelled vector glyph once, and every character in a
bitmap can be matched against that bank. What comes back is a list of
(character, rectangle) in page coordinates - exactly the shape `extract.fill_math`
already consumes - so a raster page decodes through the same fraction, exponent
and index logic as a vector one.

Matching is approximate where hashing is exact, so the whole image is refused
the moment one mark fails to match confidently: a picture is better than
plausible-looking wrong notation.

NOT WIRED INTO THE EXTRACTOR - it was measured and it does not work well enough.
The bitmaps are stored at 1.33 px/pt, which is about nine pixels to a digit, and
that is below what shape matching can separate. Two independent measurements:

  * tools/rastersweep.py renders the vector pages down to 1.33 px/pt, where the
    glyph hash still gives exact ground truth. Best precision at any threshold
    is 67%, and that is at 4% coverage; at 22% coverage it is 45%. Tightening
    the thresholds barely moves it, which says the errors are confident rather
    than marginal.
  * tools/rastercheck.py puts real embedded bitmaps beside what this reads.
    Loosened to 12% coverage, 34 sampled expressions were 32% correct - and the
    misreads are the dangerous kind: "a" as "c7", "7" as "f", "b" as "6",
    "(5,5)" as "(525)", a square root as "^{\circ}m". Tightened back to the
    thresholds set here it is ~96% right but reads 0.9% of the notation, all of
    it one or two characters.

Neither operating point is worth having, so those pages keep their crops. What
would actually move this is more pixels, not a better matcher: the resolution
is the ceiling. Kept, with its harness, so the next person can see the numbers
instead of rebuilding the experiment.

  build <glyphs.json> <labels.json> <pdf> <out.npz>    render the template bank
"""
import io
import json
import sys

import numpy as np
import pymupdf
from PIL import Image

GRID = 16                # every glyph is matched at this resolution
INK = 195                # 8-bit level below which a pixel counts as ink;
                         # high enough that an italic p's hairline join survives
ZOOM = 8                 # bitmap render scale; the embedded images are small
MATCH_MIN = 0.88         # profile agreement a match must reach...
ASPECT_W = 0.20          # weight on the width/height mismatch penalty
MARGIN = 0.02            # ...and beat the best other character by
BAR_RATIO = 0.16         # height/width below this is a rule, not a character
BAR_MIN_W = 5            # ...if it is also at least this wide, in pixels
MERGE_OVERLAP = 0.55     # x-overlap fraction that joins two marks into one
MERGE_TALL = 1.65        # ...but never into something this much taller than em


# --------------------------------------------------------------- templates --

NATIVE = 1.33            # px/pt the embedded bitmaps are actually stored at


def _ink(page, rect, zoom):
    pix = page.get_pixmap(clip=rect, matrix=pymupdf.Matrix(zoom, zoom))
    return np.array(Image.open(io.BytesIO(pix.tobytes("png"))).convert("L")) < INK


def _coarse_ink(page, rect, zoom):
    """A region rendered the way an embedded bitmap arrives.

    The templates have to be built through this same path. A glyph stored at
    1.33 px/pt is about nine pixels tall and the upscale that follows is pure
    interpolation; comparing that against a crisp vector render is comparing
    two different things, and it was rejecting correct matches.
    """
    pix = page.get_pixmap(clip=rect, matrix=pymupdf.Matrix(NATIVE, NATIVE))
    small = Image.open(io.BytesIO(pix.tobytes("png"))).convert("L")
    big = small.resize((max(1, int(rect.width * zoom)),
                        max(1, int(rect.height * zoom))), Image.BILINEAR)
    return np.asarray(big) < INK


def _normalise(mask):
    """A glyph's ink as a GRID x GRID density profile, plus its aspect ratio.

    Density, not a binary stencil. The templates come off crisp vector paths and
    the bitmaps are blurry, so comparing ink on/off cell by cell punishes a
    correct match for a half-pixel of stroke weight; averaged coverage does not.
    """
    ys, xs = np.nonzero(mask)
    if not len(ys):
        return None, 0.0
    box = mask[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    ar = box.shape[1] / box.shape[0]
    img = Image.fromarray((box * 255).astype(np.uint8)).resize(
        (GRID, GRID), Image.BOX)
    return _blur(np.asarray(img, dtype=np.float32) / 255.0), ar


BLUR = np.array([[1., 2., 1.], [2., 4., 2.], [1., 2., 1.]]) / 16.0


def _blur(a):
    """One 3x3 pass, so a match survives being half a cell out of register."""
    pad = np.pad(a, 1)
    out = np.zeros_like(a)
    for dy in range(3):
        for dx in range(3):
            out += BLUR[dy, dx] * pad[dy:dy + a.shape[0], dx:dx + a.shape[1]]
    return out


def build(glyph_index, labels_path, pdf, out_path):
    """Render one example of every labelled shape into a template bank."""
    idx = json.load(open(glyph_index))
    labels = json.load(open(labels_path, encoding="utf-8"))
    first = {}
    for pno, glyphs in idx["pages"].items():
        for sig, rect in glyphs:
            if sig in labels:
                first.setdefault(sig, (int(pno), rect))
    doc = pymupdf.open(pdf)
    chars, grids, ars = [], [], []
    for sig, (pno, r) in first.items():
        rect = pymupdf.Rect(r[0] - 0.3, r[1] - 0.3, r[2] + 0.3, r[3] + 0.3)
        grid, ar = _normalise(_coarse_ink(doc[pno], rect, ZOOM))
        if grid is None:
            continue
        chars.append(labels[sig])
        grids.append(grid)
        ars.append(ar)
    np.savez_compressed(out_path, chars=np.array(chars), grids=np.array(grids),
                        ars=np.array(ars))
    print(f"{len(chars)} templates -> {out_path}")


def load(path):
    z = np.load(path, allow_pickle=False)
    flat = z["grids"].reshape(len(z["chars"]), -1).astype(np.float32)
    flat /= np.maximum(np.linalg.norm(flat, axis=1, keepdims=True), 1e-6)
    return {"chars": z["chars"], "flat": flat, "ars": z["ars"]}


# ------------------------------------------------------------- components --

def _runs(mask):
    """(row, x0, x1) for every horizontal run of ink."""
    out = []
    for y, row in enumerate(mask):
        xs = np.flatnonzero(row)
        if not len(xs):
            continue
        cuts = np.flatnonzero(np.diff(xs) > 1)
        start = 0
        for c in list(cuts) + [len(xs) - 1]:
            out.append((y, xs[start], xs[c] + 1))
            start = c + 1
    return out


def components(mask):
    """Bounding boxes of the connected ink blobs, left to right.

    Row-run labelling with union-find; there is no scipy here and a per-pixel
    flood fill over a page's worth of bitmaps is far too slow.
    """
    runs = _runs(mask)
    parent = list(range(len(runs)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    prev = []
    row_start = 0
    for i, (y, x0, x1) in enumerate(runs):
        if i and y != runs[i - 1][0]:
            prev = list(range(row_start, i)) if runs[row_start][0] == y - 1 else []
            row_start = i
        for j in prev:
            if runs[j][1] < x1 and x0 < runs[j][2]:
                union(i, j)
    boxes = {}
    for i, (y, x0, x1) in enumerate(runs):
        r = find(i)
        b = boxes.get(r)
        boxes[r] = (min(b[0], x0), min(b[1], y), max(b[2], x1), max(b[3], y + 1)) \
            if b else (x0, y, x1, y + 1)
    return sorted(boxes.values())


def _merge(boxes):
    """Join the marks that make up one character - i's dot, =, %, :, the divide.

    Capped by height so a fraction's numerator, bar and denominator are never
    welded into a single blob; that stack is two to three times a character tall.
    """
    tall = [b for b in boxes if b[3] - b[1] > 0.3 * max(x[3] - x[1] for x in boxes)]
    em = float(np.median([b[3] - b[1] for b in tall])) if tall else 1.0
    out = [list(b) for b in boxes]
    changed = True
    while changed:
        changed = False
        for i in range(len(out)):
            for j in range(i + 1, len(out)):
                a, b = out[i], out[j]
                lo, hi = max(a[0], b[0]), min(a[2], b[2])
                narrow = min(a[2] - a[0], b[2] - b[0])
                if hi - lo < MERGE_OVERLAP * narrow:
                    continue
                merged = [min(a[0], b[0]), min(a[1], b[1]),
                          max(a[2], b[2]), max(a[3], b[3])]
                if merged[3] - merged[1] > MERGE_TALL * em:
                    continue
                out[i] = merged
                del out[j]
                changed = True
                break
            if changed:
                break
    return sorted(tuple(b) for b in out), em


def _is_bar(box):
    w, h = box[2] - box[0], box[3] - box[1]
    return w >= BAR_MIN_W and h <= BAR_RATIO * w


def _spans(box, others):
    """True if some mark sits above the box and another below, within its width."""
    cx0, cx1 = box[0], box[2]
    above = below = False
    for o in others:
        if o is box or o[2] <= cx0 or o[0] >= cx1:
            continue
        if o[3] <= box[1] + 1:
            above = True
        elif o[1] >= box[3] - 1:
            below = True
    return above and below


def match(mask, bank):
    """(character, score) for one mark, or (None, score) if nothing fits.

    The runner-up matters as much as the winner: a mark that scores well against
    two different characters is exactly the case where guessing is dangerous.
    """
    grid, ar = _normalise(mask)
    if grid is None:
        return None, 0.0
    flat = grid.reshape(-1)
    flat = flat / (np.linalg.norm(flat) or 1.0)
    agree = bank["flat"] @ flat          # cosine: ink weight cancels out
    penalty = ASPECT_W * np.abs(np.log(np.maximum(ar, 1e-3) / bank["ars"]))
    score = agree - np.minimum(penalty, 0.4)
    order = np.argsort(-score)
    best = order[0]
    char = str(bank["chars"][best])
    if score[best] < MATCH_MIN:
        return None, float(score[best])
    for k in order[1:]:
        if str(bank["chars"][k]) != char:
            if score[best] - score[k] < MARGIN:
                return None, float(score[best])
            break
    return char, float(score[best])


def decode(page, rect, bank, zoom=ZOOM):
    """(glyphs, bars) in page coordinates for one embedded bitmap, or None.

    Glyph signatures are synthetic - "\\x01" plus the character - so the caller
    can drop them straight into the same label lookup the vector path uses.
    """
    return decode_mask(_ink(page, rect, zoom), rect, bank, zoom)


def decode_mask(mask, rect, bank, zoom=ZOOM):
    if not mask.any():
        return None
    boxes, em = _merge(components(mask))
    if not boxes or len(boxes) > 60:
        return None
    glyphs, bars = [], []

    def to_page(b):
        return pymupdf.Rect(rect.x0 + b[0] / zoom, rect.y0 + b[1] / zoom,
                            rect.x0 + b[2] / zoom, rect.y0 + b[3] / zoom)

    for b in boxes:
        if _is_bar(b) and _spans(b, boxes):
            bars.append(to_page(b))
            continue
        char, _ = match(mask[b[1]:b[3], b[0]:b[2]], bank)
        if char is None:
            return None          # one unreadable mark: keep the picture
        glyphs.append(("\x01" + char, to_page(b)))
    return (glyphs, bars) if glyphs else None


def label_map(bank):
    """The synthetic signatures decode() emits, ready to merge into labels."""
    return {"\x01" + str(c): str(c) for c in set(bank["chars"].tolist())}


if __name__ == "__main__":
    build(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5])
