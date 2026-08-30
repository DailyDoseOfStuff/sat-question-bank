"""How much of the real raster notation the decoder accepts, and how long the
accepted expressions are - a decoder that only reads single digits is not worth
the risk it carries.

  python tools/rastercover.py <pdf> [stride]
"""
import json
import sys

import pymupdf

sys.path.insert(0, "tools")
import extract as E
import pdfcommon as P
import rastermath as R


def main(pdf, stride=1):
    doc = pymupdf.open(pdf)
    labels = dict(json.load(open("tools/glyph_labels.json", encoding="utf-8")))
    bank = R.load("tools/templates.npz")
    labels.update(R.label_map(bank))
    total = read = 0
    by_len = {}
    for pno in range(0, doc.page_count, int(stride)):
        page = doc[pno]
        for info in page.get_image_info():
            r = pymupdf.Rect(info["bbox"])
            if r.y0 < P.BANNER_BOTTOM or r.width <= 1 or r.height <= 1:
                continue
            if r.width >= P.FIG_MIN_W and r.height >= P.FIG_MIN_H:
                continue
            total += 1
            got = R.decode(page, r, bank)
            if got is None:
                continue
            text = E.decode_slot(got[0], got[1], labels)
            if not text:
                continue
            read += 1
            n = len(text.replace(" ", ""))
            key = "1" if n == 1 else "2" if n == 2 else "3-4" if n <= 4 else "5+"
            by_len[key] = by_len.get(key, 0) + 1
        if pno % 400 == 0:
            print(f"  page {pno}/{doc.page_count}", flush=True)
    print(f"raster notation images: {total}, decoded {read} "
          f"({100 * read / max(total, 1):.1f}%)")
    print("accepted by length:", dict(sorted(by_len.items())))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else 1)
