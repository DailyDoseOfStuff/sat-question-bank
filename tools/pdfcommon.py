"""Shared PDF parsing for the College Board SAT question dumps.

Both PDFs put one question per page, keyed by a `Question ID:` line. Pages
without that line are continuations of the previous question.

Prose is real text. Two quirks handled here:
  * Spurious spaces: the dumps emit a narrow space glyph (~0.24x fontsize)
    mid-word ("ar tifacts"). Real spaces are ~2.48x. Threshold at 1.0.
  * Math notation is not text at all - it is raw vector paths with no font.
    Those are located as horizontal gaps between text runs and handled by
    the caller.
"""
import re
import pymupdf

SPACE_RATIO = 1.0        # space width / fontsize below this = kerning artifact
HEADER_Y = 75            # everything above is the metadata banner
GAP_MIN = 4.0            # min horizontal gap (pt) to consider a notation slot


def _runs(page):
    """Text runs with bboxes, spurious spaces dropped."""
    out = []
    for block in page.get_text("rawdict")["blocks"]:
        if block["type"] != 0:
            continue
        for line in block["lines"]:
            for span in line["spans"]:
                fs = span["size"] or 1.0
                text = ""
                for ch in span["chars"]:
                    if ch["c"] == " ":
                        w = (ch["bbox"][2] - ch["bbox"][0]) / fs
                        if w < SPACE_RATIO:
                            continue      # kerning artifact, not a word break
                        text += " "
                    else:
                        text += ch["c"]
                if text.strip():
                    out.append({"text": text, "bbox": span["bbox"], "font": span["font"]})
    return out


def lines_of(page, include_header=False):
    """Runs grouped into visual lines, sorted top-to-bottom, left-to-right.

    Each line is {"y", "runs", "text"}. `runs` keeps bboxes so callers can
    find the gaps where math notation was drawn.
    """
    runs = [r for r in _runs(page) if include_header or r["bbox"][1] >= HEADER_Y]
    # Group by vertical overlap, not fixed bands: superscripts and accented
    # glyphs sit a fraction of a point off their baseline and a banded split
    # would tear "C." away from its own choice text.
    rows = []
    for r in sorted(runs, key=lambda r: (r["bbox"][1], r["bbox"][0])):
        mid = (r["bbox"][1] + r["bbox"][3]) / 2
        for g in rows:
            if g["y0"] - 1 <= mid <= g["y1"] + 1:
                g["runs"].append(r)
                g["y0"] = min(g["y0"], r["bbox"][1])
                g["y1"] = max(g["y1"], r["bbox"][3])
                break
        else:
            rows.append({"y0": r["bbox"][1], "y1": r["bbox"][3], "runs": [r]})
    lines = []
    for group in [g["runs"] for g in rows]:
        group.sort(key=lambda r: r["bbox"][0])
        # Runs split on font changes (italics, quote marks). Only insert a
        # space where the geometry actually shows one, else "basket 's".
        text = ""
        for i, r in enumerate(group):
            if i and group[i]["bbox"][0] - group[i - 1]["bbox"][2] > 1.0:
                text += " "
            text += r["text"]
        lines.append({
            "y": min(r["bbox"][1] for r in group),
            "y1": max(r["bbox"][3] for r in group),
            "x0": min(r["bbox"][0] for r in group),
            "runs": group,
            "text": re.sub(r"\s+", " ", text).strip(),
        })
    return lines


def gaps_in(line):
    """Horizontal gaps between consecutive runs on a line.

    Returns (index_after, rect) so a caller can splice recovered notation back
    into the right position. Whether a gap actually holds ink is the caller's
    problem - table columns produce empty gaps too.
    """
    out = []
    runs = line["runs"]
    for i, (a, b) in enumerate(zip(runs, runs[1:])):
        if b["bbox"][0] - a["bbox"][2] > GAP_MIN:
            out.append((i + 1, pymupdf.Rect(
                a["bbox"][2] + 0.5,
                min(a["bbox"][1], b["bbox"][1]),
                b["bbox"][0] - 0.5,
                max(a["bbox"][3], b["bbox"][3]),
            )))
    return out


BANNER_BOTTOM = 115      # metadata banner occupies the top of page 1
FIG_MIN_W = 80           # a figure cluster must be at least this wide...
FIG_MIN_H = 40           # ...and this tall, else it is a rule or a bullet


def figures(page):
    """Bounding boxes of charts and tables drawn on the page.

    Vector art is clustered by overlap; anything large enough to be a real
    figure is returned. Chart axis labels live in the text layer but read as
    noise ("2.52.01.51.00.5"), so callers crop these regions to an image and
    drop the text inside them.
    """
    rects = []
    for d in page.get_drawings():
        r = d["rect"]
        if r.y0 < BANNER_BOTTOM:            # metadata banner and its rules
            continue
        if r.width <= 1 and r.height <= 1:  # bullets, dots
            continue
        # axis lines are zero-thickness, and empty rects never intersect
        rects.append(pymupdf.Rect(r.x0, r.y0, max(r.x1, r.x0 + 0.5),
                                  max(r.y1, r.y0 + 0.5)))
    clusters = []
    for r in rects:
        grown = pymupdf.Rect(r.x0 - 12, r.y0 - 12, r.x1 + 12, r.y1 + 12)
        hit = [c for c in clusters if c.intersects(grown)]
        for c in hit:
            clusters.remove(c)
            r = pymupdf.Rect(min(r.x0, c.x0), min(r.y0, c.y0),
                             max(r.x1, c.x1), max(r.y1, c.y1))
        clusters.append(pymupdf.Rect(r))
    return [c for c in clusters if c.width >= FIG_MIN_W and c.height >= FIG_MIN_H]


QID = re.compile(r"Question ID:\s*([0-9a-f]+)")


def page_index(doc):
    """[(question_id, [page_no, ...])] - continuation pages folded in."""
    out = []
    for i in range(doc.page_count):
        m = QID.search(doc[i].get_text())
        if m:
            out.append((m.group(1), [i]))
        elif out:
            out[-1][1].append(i)
    return out
