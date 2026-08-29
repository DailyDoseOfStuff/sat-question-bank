"""Contact sheet of real embedded bitmaps beside what the decoder read.

The sweep measures the decoder against vector pages rendered down to the
bitmaps' resolution, which may be harsher than the real thing. This puts actual
embedded images next to the decoder's answer so the two can be compared by eye.

  python tools/rastercheck.py <pdf> <n> <out.png>
"""
import io
import json
import sys

import pymupdf
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, "tools")
import extract as E
import pdfcommon as P
import rastermath as R


def main(pdf, n, out_png, stride=1):
    doc = pymupdf.open(pdf)
    labels = dict(json.load(open("tools/glyph_labels.json", encoding="utf-8")))
    bank = R.load("tools/templates.npz")
    labels.update(R.label_map(bank))
    rows = []
    for pno in range(0, doc.page_count, int(stride)):
        page = doc[pno]
        for info in page.get_image_info():
            r = pymupdf.Rect(info["bbox"])
            if r.y0 < P.BANNER_BOTTOM or r.width <= 1 or r.height <= 1:
                continue
            if r.width >= P.FIG_MIN_W and r.height >= P.FIG_MIN_H:
                continue
            got = R.decode(page, r, bank)
            if got is None:
                continue
            text = E.as_math(E.decode_slot(got[0], got[1], labels))
            if not text:
                continue
            pix = page.get_pixmap(clip=r, matrix=pymupdf.Matrix(6, 6))
            rows.append((Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB"),
                         text))
            if len(rows) >= int(n):
                break
        if len(rows) >= int(n):
            break
    if not rows:
        print("nothing decoded")
        return
    pad, textw = 8, 360
    w = max(im.width for im, _ in rows) + textw + pad * 3
    h = sum(im.height + pad for im, _ in rows) + pad
    sheet = Image.new("RGB", (w, h), "white")
    d = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype("consola.ttf", 17)
    except OSError:
        font = ImageFont.load_default()
    y = pad
    for im, text in rows:
        sheet.paste(im, (pad, y))
        d.text((im.width + pad * 2, y + im.height // 3), text, fill="red", font=font)
        d.line([(0, y + im.height + pad // 2), (w, y + im.height + pad // 2)],
               fill="#cccccc")
        y += im.height + pad
    sheet.save(out_png)
    print(f"{len(rows)} decoded samples -> {out_png}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3],
         sys.argv[4] if len(sys.argv) > 4 else 1)
