"""Recover math notation from the Math PDF, which draws it as raw vector paths.

The Math dump has no font for its notation - digits and operators are filled
outlines, so the text layer shows blank gaps ("a constant rate of __ posters").
Identical characters are drawn from identical path geometry, so normalising a
path to its own bounding box and hashing it gives a stable per-character key.
Label each key once and every occurrence decodes exactly, with no OCR.

  scan  <pdf> <out.json>          index every glyph occurrence
  sheet <index.json> <pdf> <n>    contact sheet of the n most common unlabelled
                                  shapes, to read off and add to LABELS
"""
import hashlib
import io
import json
import os
import sys

import pymupdf
from PIL import Image, ImageDraw

MIN_PTS = 8              # fewer points than this is a rule or bar, not a glyph
BANNER_BOTTOM = 115


def signature(drawing):
    """Scale-invariant key for one drawn glyph, or None if it is not one."""
    pts = []
    for item in drawing["items"]:
        for v in item[1:]:
            if isinstance(v, pymupdf.Point):
                pts.append((v.x, v.y))
            elif isinstance(v, pymupdf.Rect):
                pts += [(v.x0, v.y0), (v.x1, v.y1)]
    if len(pts) < MIN_PTS:
        return None
    xs = [a for a, _ in pts]
    ys = [b for _, b in pts]
    w, h = max(xs) - min(xs), max(ys) - min(ys)
    if w <= 0.05 or h <= 0.05:
        return None
    norm = tuple((round((a - min(xs)) / w, 1), round((b - min(ys)) / h, 1))
                 for a, b in pts)
    return hashlib.md5(str(norm).encode()).hexdigest()[:10]


def glyphs_on(page):
    """[(sig, rect)] for every glyph-like path below the banner."""
    out = []
    for d in page.get_drawings():
        r = d["rect"]
        if r.y0 < BANNER_BOTTOM:
            continue
        sig = signature(d)
        if sig:
            out.append((sig, [round(v, 2) for v in r]))
    return out


def scan(pdf, out_path):
    doc = pymupdf.open(pdf)
    pages = {}
    counts = {}
    for i in range(doc.page_count):
        g = glyphs_on(doc[i])
        if g:
            pages[str(i)] = g
            for sig, _ in g:
                counts[sig] = counts.get(sig, 0) + 1
        if i % 200 == 0:
            print(f"  page {i}/{doc.page_count}", flush=True)
    json.dump({"pages": pages, "counts": counts}, open(out_path, "w"))
    print(f"{len(counts)} distinct shapes, {sum(counts.values())} occurrences")


def sheet(index_path, pdf, n, out_png, labels_path):
    """Render the most common still-unlabelled shapes for a human to read."""
    idx = json.load(open(index_path))
    labels = json.load(open(labels_path)) if os.path.exists(labels_path) else {}
    first = {}
    for pno, glyphs in idx["pages"].items():
        for sig, rect in glyphs:
            first.setdefault(sig, (int(pno), rect))
    todo = [s for s, _ in sorted(idx["counts"].items(), key=lambda kv: -kv[1])
            if s not in labels][:n]
    doc = pymupdf.open(pdf)
    cols, cell = 8, 70
    rows = (len(todo) + cols - 1) // cols
    sheet_img = Image.new("RGB", (cols * cell, rows * (cell + 16)), "white")
    draw = ImageDraw.Draw(sheet_img)
    for i, sig in enumerate(todo):
        pno, r = first[sig]
        rect = pymupdf.Rect(r[0] - 0.4, r[1] - 0.4, r[2] + 0.4, r[3] + 0.4)
        pix = doc[pno].get_pixmap(clip=rect, matrix=pymupdf.Matrix(14, 14))
        im = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
        im.thumbnail((cell - 10, cell - 10))
        c, rw = i % cols, i // cols
        sheet_img.paste(im, (c * cell + (cell - im.width) // 2,
                             rw * (cell + 16) + (cell - im.height) // 2))
        draw.text((c * cell + 3, rw * (cell + 16) + cell + 2),
                  f"{i}:{idx['counts'][sig]}", fill="red")
    sheet_img.save(out_png)
    print(json.dumps(todo))
    print(f"saved {out_png} ({len(todo)} shapes)")


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "scan":
        scan(sys.argv[2], sys.argv[3])
    elif cmd == "sheet":
        sheet(sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5], sys.argv[6])
