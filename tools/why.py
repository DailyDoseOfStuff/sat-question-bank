"""Report why a question's notation stayed a picture: which shape is unknown,
or which geometry refused. Prints one line per undecoded slot."""
import json
import sys

sys.path.insert(0, "tools")
import pymupdf
import extract as E
import glyphmap
import pdfcommon as P


def main(pdf, qid):
    doc = pymupdf.open(pdf)
    labels = json.load(open("tools/glyph_labels.json", encoding="utf-8"))
    pages = dict(P.page_index(doc))[qid]
    for pno in pages:
        page = doc[pno]
        glyphs, bars = E.math_page(page)
        lines = E.collect(doc, [pno])
        figs = E.figure_blocks(page, lines)
        print(f"page {pno}: {len(glyphs)} glyphs, {len(bars)} bars, "
              f"{len(figs)} figure blocks")
        for f in figs:
            print(f"   fig {f}  table={E.is_table(page, f)}")
        for row in E._rows(glyphs):
            box = E._box(row)
            unknown = [s for s, _ in row if labels.get(s) is None]
            got = E.decode_slot(row, bars, labels)
            print(f"  row y={box.y0:.0f} n={len(row)} -> {got!r}"
                  + (f"  UNKNOWN={unknown}" if unknown else ""))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
