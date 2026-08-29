"""Run the extractor over a slice of a PDF and print the rows, to eyeball
decoding before committing to a full 20-minute pass."""
import json
import os
import sys

sys.path.insert(0, "tools")
import pymupdf
import extract as E
import pdfcommon as P


def main(pdf, start, n, img_dir, ids=""):
    doc = pymupdf.open(pdf)
    labels = json.load(open("tools/glyph_labels.json", encoding="utf-8"))
    os.makedirs(img_dir, exist_ok=True)
    idx = P.page_index(doc)
    want = set(ids.split(",")) if ids else None
    picked = [x for x in idx if x[0] in want] if want else idx[start:start + n]
    for qid, pages in picked:
        row = E.build(doc, qid, pages, labels, img_dir, [0])
        if row:
            print(json.dumps(row, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4],
         sys.argv[5] if len(sys.argv) > 5 else "")
