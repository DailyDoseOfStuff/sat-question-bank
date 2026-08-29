"""Precision/coverage curve for the raster decoder, over the vector pages.

Accuracy is the whole question here: a crop is fine, a confidently wrong
expression is not. This sweeps the accept thresholds and prints, for each, how
much of the notation it reads and how much of what it reads is right.

  python tools/rastersweep.py <pdf> <n_pages>
"""
import json
import sys

import pymupdf

sys.path.insert(0, "tools")
import extract as E
import rastermath as R


def main(pdf, n_pages):
    doc = pymupdf.open(pdf)
    labels = dict(json.load(open("tools/glyph_labels.json", encoding="utf-8")))
    bank = R.load("tools/templates.npz")
    labels.update(R.label_map(bank))

    cases = []
    for pno in range(min(int(n_pages), doc.page_count)):
        page = doc[pno]
        glyphs, bars = E.math_page(page)
        glyphs = [(s, r) for s, r in glyphs if s is not None]
        if not glyphs:
            continue
        for row in E._rows(glyphs):
            truth = E.decode_slot(row, bars, labels)
            if not truth or len(truth) < 2:
                continue
            box = E._box(row)
            rect = pymupdf.Rect(box.x0 - 1, box.y0 - 1, box.x1 + 1, box.y1 + 1)
            cases.append((R._coarse_ink(page, rect, R.ZOOM), rect, truth))
    print(f"{len(cases)} expressions with exact ground truth\n")
    print(f"{'min':>6} {'margin':>7} {'read':>7} {'correct':>8} {'precision':>10}")
    for mn in (0.88, 0.90, 0.92, 0.94, 0.96):
        for mg in (0.02, 0.05, 0.10):
            R.MATCH_MIN, R.MARGIN = mn, mg
            right = wrong = 0
            for mask, rect, truth in cases:
                got = R.decode_mask(mask, rect, bank)
                if got is None:
                    continue
                out = E.decode_slot(got[0], got[1], labels)
                if out == truth:
                    right += 1
                else:
                    wrong += 1
            acc = right + wrong
            prec = 100 * right / acc if acc else 0.0
            print(f"{mn:>6} {mg:>7} {100*acc/len(cases):>6.1f}% "
                  f"{100*right/len(cases):>7.1f}% {prec:>9.1f}%")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
