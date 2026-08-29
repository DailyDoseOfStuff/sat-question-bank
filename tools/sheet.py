"""Contact sheet of unlabelled glyph shapes, big enough to read off."""
import io, json, os, sys
import pymupdf
from PIL import Image, ImageDraw, ImageFont

def main(index_path, pdf, labels_path, out_png, start=0, n=96):
    idx = json.load(open(index_path))
    labels = json.load(open(labels_path, encoding="utf-8"))
    first = {}
    for pno, glyphs in idx["pages"].items():
        for sig, rect in glyphs:
            first.setdefault(sig, (int(pno), rect))
    todo = [s for s, _ in sorted(idx["counts"].items(), key=lambda kv: -kv[1])
            if s not in labels][start:start + n]
    doc = pymupdf.open(pdf)
    cols, cell, lab = 8, 150, 26
    rows = (len(todo) + cols - 1) // cols
    img = Image.new("RGB", (cols * cell, rows * (cell + lab)), "white")
    d = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("arial.ttf", 18)
    except OSError:
        font = ImageFont.load_default()
    for i, sig in enumerate(todo):
        pno, r = first[sig]
        rect = pymupdf.Rect(r[0] - 0.5, r[1] - 0.5, r[2] + 0.5, r[3] + 0.5)
        pix = doc[pno].get_pixmap(clip=rect, matrix=pymupdf.Matrix(20, 20))
        im = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
        im.thumbnail((cell - 16, cell - 16))
        c, rw = i % cols, i // cols
        x0, y0 = c * cell, rw * (cell + lab)
        img.paste(im, (x0 + (cell - im.width) // 2, y0 + (cell - im.height) // 2))
        d.rectangle([x0, y0, x0 + cell - 1, y0 + cell + lab - 1], outline="#bbb")
        d.text((x0 + 6, y0 + cell + 2), f"{start + i}  n={idx['counts'][sig]}",
               fill="red", font=font)
    img.save(out_png)
    print(json.dumps(todo))

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4],
         int(sys.argv[5]), int(sys.argv[6]))
