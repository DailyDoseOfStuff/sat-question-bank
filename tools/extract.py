"""Re-extract stem / choices / correct answer / rationale from the SAT PDFs.

Writes JSONL, one row per question id. Nothing touches the database here -
load separately once the output has been eyeballed.

Metadata (section/domain/skill/difficulty) is NOT re-extracted; the existing
`questions` rows already have it correct.

Usage: python tools/extract.py <pdf> <out.jsonl>
"""
import io
import json
import os
import re
import sys

import pymupdf
from PIL import Image

sys.path.insert(0, "tools")
import glyphmap
import pdfcommon as P

PARA_GAP = 18.0          # vertical gap (pt) that starts a new paragraph
BULLET_MAX = 4.0         # filled squares this small to the left = list bullet
CHOICE = re.compile(r"^([A-D])\.\s+(.*)$", re.S)
CORRECT = re.compile(r"^Correct Answer:\s*(.*)$")


IMG_TOKEN = re.compile("\x00([\\w.]+)\x00")


def esc(s):
    """Escape text, then restore inline math images.

    fill_math marks stacked notation with a \\0name\\0 token rather than raw
    HTML so it survives escaping; the tag is rebuilt from the filename here.
    """
    s = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return IMG_TOKEN.sub(
        lambda m: f'<img class="minl" src="/qimg/{m.group(1)}" alt="">', s)


def bullet_xs(page):
    """x-ranges of bullet marks, so indented list items can be detected."""
    out = []
    for dr in page.get_drawings():
        r = dr["rect"]
        if r.width <= BULLET_MAX and r.height <= BULLET_MAX and r.width > 1:
            out.append((r.y0, r.y1, r.x1))
    return out


def collect(doc, pages):
    """Lines across every page of one question, tagged as bullet or not."""
    lines = []
    for n, pno in enumerate(pages):
        page = doc[pno]
        marks = bullet_xs(page)
        # only the first page carries the metadata banner
        for ln in P.lines_of(page, include_header=(n > 0)):
            # a mark sitting left of the line, vertically inside it, opens an item
            ln["bullet"] = any(
                ln["y"] <= (y0 + y1) / 2 <= ln["y1"] and mx <= ln["x0"]
                for y0, y1, mx in marks
            )
            ln["page"] = pno
            lines.append(ln)
    return lines


PROSE_X = 24.0           # body text starts at the left margin
PROSE_W = 300.0          # ...and runs long; short lines are figure labels
LABEL_X = 100.0          # nothing in the prose flow is indented this far;
                         # anything past it near a plot is a chart label


def is_prose(ln):
    width = max(r["bbox"][2] for r in ln["runs"]) - ln["x0"]
    return ln["x0"] <= PROSE_X and width > PROSE_W


def figure_blocks(page, lines):
    """Figure rects grown to include their own labels.

    A bare vector cluster is just the plot area - the title, axis numbers and
    category names sit in the text layer around it and are meaningless as
    prose. Absorb every neighbouring non-prose line, stopping at body text.
    """
    blocks = []
    for fig in P.figures(page):
        rect = pymupdf.Rect(fig)
        changed = True
        while changed:
            changed = False
            for ln in lines:
                if ln["page"] != page.number or ln["x0"] < LABEL_X:
                    continue
                box = pymupdf.Rect(ln["x0"], ln["y"],
                                   max(r["bbox"][2] for r in ln["runs"]), ln["y1"])
                if box in rect:
                    continue
                near = pymupdf.Rect(rect.x0 - 40, rect.y0 - 60, rect.x1 + 40, rect.y1 + 60)
                if near.intersects(box):
                    rect |= box
                    changed = True
        blocks.append(rect)
    # two clusters (plot + its legend) usually grow into the same region
    merged = []
    for b in sorted(blocks, key=lambda r: r.y0):
        if merged and merged[-1].intersects(b):
            merged[-1] |= b
        else:
            merged.append(pymupdf.Rect(b))
    return merged


def save_figure(page, rect, path, zoom=3, pad=4):
    box = pymupdf.Rect(rect.x0 - pad, rect.y0 - pad, rect.x1 + pad, rect.y1 + pad)
    pix = page.get_pixmap(clip=box, matrix=pymupdf.Matrix(zoom, zoom))
    Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB").save(
        path, "WEBP", quality=88, method=4)


BAR_MAX_H = 1.5          # a fraction bar is a thin wide fill
ROW_TOL = 2.0            # glyph centres this close share a baseline
SPACE_FRAC = 0.35        # glyph gap / font size above which a space is real
SPACE_GAP = 1.0          # pt between a run and its neighbour that reads as a space


def math_page(page):
    """Notation on the page, plus the fraction bars that mark it as stacked.

    The Math dump is not consistent: most pages draw notation as vector paths,
    but some embed it as raster images instead. Images carry no glyph identity,
    so they enter the list with a None signature and always end up cropped.
    """
    glyphs = [(sig, pymupdf.Rect(r)) for sig, r in glyphmap.glyphs_on(page)]
    for info in page.get_image_info():
        rect = pymupdf.Rect(info["bbox"])
        if rect.y0 >= P.BANNER_BOTTOM and rect.width > 1 and rect.height > 1:
            glyphs.append((None, rect))
    bars = [d["rect"] for d in page.get_drawings()
            if d["rect"].height <= BAR_MAX_H and d["rect"].width > 3
            and d["rect"].y0 >= P.BANNER_BOTTOM]
    return glyphs, bars


def decode_slot(group, bars, labels):
    """Text for one run of drawn glyphs, or None if it must stay an image.

    Anything stacked - a fraction, a radical, a matrix - is refused and cropped
    by the caller; a single row of labelled glyphs decodes exactly.
    """
    box = pymupdf.Rect(group[0][1])
    for _, r in group:
        box |= r
    if any(box.intersects(b) for b in bars):
        return None
    rows = []
    for s, r in group:
        mid = (r.y0 + r.y1) / 2
        for row in rows:
            if abs(row[0] - mid) <= ROW_TOL:
                row[1].append((s, r))
                break
        else:
            rows.append((mid, [(s, r)]))
    if len(rows) > 1:
        return None                # stacked notation
    ordered = sorted(group, key=lambda g: g[1].x0)
    if any(labels.get(s) is None for s, _ in ordered):
        return None                # unlabelled shape - keep the picture
    # Normalise by the tallest glyph, not the previous one: "=" and "-" are
    # only a point or two high and would make every following gap look huge.
    em = max(r.y1 - r.y0 for _, r in ordered) or 1.0
    out = labels[ordered[0][0]]
    for (s, r), (_, prev) in zip(ordered[1:], ordered):
        # digits of one number sit flush; operands are spaced further apart
        if r.x0 - prev.x1 > SPACE_FRAC * em:
            out += " "
        out += labels[s]
    return out


def fill_math(page, lines, labels, img_dir, qid, out_imgs, skip=()):
    """Rewrite each line's text with its drawn notation put back in place.

    Every glyph is assigned to a slot on its line - before the first run,
    between two runs, or after the last - so notation that lands at a line
    break is not lost. Simple runs become real characters; stacked notation
    becomes a small inline image, so nothing is silently dropped.
    """
    glyphs, bars = math_page(page)
    glyphs = [(s, r) for s, r in glyphs if not any(r in f for f in skip)]
    used = set()
    for ln in lines:
        if ln["page"] != page.number or not ln["runs"]:
            continue
        mine = [(s, r) for s, r in glyphs
                if ln["y"] - 3 <= (r.y0 + r.y1) / 2 <= ln["y1"] + 3]
        if not mine:
            continue
        ends = [r["bbox"][2] for r in ln["runs"]]
        slots = {}
        for s, r in mine:
            mid = (r.x0 + r.x1) / 2
            i = 0
            while i < len(ends) and mid > ends[i]:
                i += 1
            slots.setdefault(i, []).append((s, r))
        # (x0, x1, text) so the join below can put a space back wherever the
        # page actually drew one. The runs' own spaces are not enough: a word
        # break next to notation is a narrow glyph that _runs() drops as a
        # kerning artifact, which is where "wsquare feet" and "Iff(x)" came from.
        parts = []

        def _slot(group):
            box = pymupdf.Rect(group[0][1])
            for _, r in group:
                box |= r
            return (box.x0, box.x1, _slot_html(page, group, bars, labels,
                                               img_dir, qid, out_imgs))

        for i, run in enumerate(ln["runs"]):
            if i in slots:
                parts.append(_slot(slots.pop(i)))
            parts.append((run["bbox"][0], run["bbox"][2], run["text"]))
        for i in sorted(slots):
            parts.append(_slot(slots[i]))
        parts.sort(key=lambda p: p[0])
        text = parts[0][2] if parts else ""
        for prev, cur in zip(parts, parts[1:]):
            if cur[0] - prev[1] > SPACE_GAP:
                text += " "
            text += cur[2]
        ln["text"] = re.sub(r"\s+", " ", text).strip()
        used.update(id(r) for _, r in mine)

    # Display equations are drawn with no text at all, so no line exists for
    # them and they would vanish. Emit each leftover row as its own block.
    extra = []
    for row in _rows([(s, r) for s, r in glyphs if id(r) not in used]):
        box = pymupdf.Rect(row[0][1])
        for _, r in row:
            box |= r
        text = _slot_html(page, row, bars, labels, img_dir, qid, out_imgs)
        extra.append({
            "y": box.y0, "y1": box.y1, "x0": box.x0, "bullet": False,
            "page": page.number, "text": text,
            "runs": [{"text": text, "bbox": (box.x0, box.y0, box.x1, box.y1),
                      "font": ""}],
        })
    return extra


def _rows(glyphs):
    """Cluster loose glyphs into visual rows, left to right."""
    rows = []
    for s, r in sorted(glyphs, key=lambda g: (g[1].y0, g[1].x0)):
        mid = (r.y0 + r.y1) / 2
        for row in rows:
            if row[0].y0 - 4 <= mid <= row[0].y1 + 4:
                row[0] |= r
                row[1].append((s, r))
                break
        else:
            rows.append([pymupdf.Rect(r), [(s, r)]])
    return [sorted(g, key=lambda x: x[1].x0) for _, g in rows]


def _slot_html(page, group, bars, labels, img_dir, qid, out_imgs):
    text = decode_slot(group, bars, labels)
    if text:
        return text
    box = pymupdf.Rect(group[0][1])
    for _, r in group:
        box |= r
    name = f"{qid}_m{len(out_imgs)}.webp"
    # tight pad: inline notation sits close to its neighbours and a loose box
    # drags the adjacent letters into the crop
    save_figure(page, box, os.path.join(img_dir, name), zoom=5, pad=1)
    out_imgs.append(name)
    return "\x00" + name + "\x00"


CHOICE_CORRECT = re.compile(r"Choice\s+([A-D])\s+is\s+correct")
VALUE_CORRECT = re.compile(r"correct answer is\s*:?\s*(-?[0-9]+(?:\.[0-9]+)?(?:/[0-9]+)?)", re.I)


def answer_from_rationale(rationale, has_choices):
    """Answer for the pages that print no "Correct Answer:" line. The rationale
    always names it, either as a choice letter or as the value itself."""
    text = " ".join(l["text"] for l in rationale)
    if has_choices:
        m = CHOICE_CORRECT.search(text)
        if m:
            return m.group(1)
    m = VALUE_CORRECT.search(text)
    return m.group(1) if m else ""


def section_end(lines):
    """(page, y) of the first line after the stem - the "Answer" heading, or
    "Correct Answer:" on a grid-in. Past the end of the page if neither."""
    for ln in lines:
        if ln["text"] == "Answer" or CORRECT.match(ln["text"]):
            return (ln["page"], ln["y"])
    return (1 << 30, 0)


def rationale_top(rationale):
    return rationale[0]["y"] - 24 if rationale else 1 << 30


def sections(lines):
    """Split a question's lines into stem / choices / answer / rationale."""
    iq = ia = ir = None
    answer = ""
    for i, ln in enumerate(lines):
        t = ln["text"]
        if iq is None and t == "Question":
            iq = i
        elif t == "Answer" and ia is None and iq is not None:
            ia = i
        elif CORRECT.match(t):
            answer = CORRECT.match(t).group(1).strip()
            ic = i
        elif t == "Rationale" and ir is None:
            ir = i
    ic = next((i for i, l in enumerate(lines) if CORRECT.match(l["text"])), None)
    if iq is None:
        return None
    stem_end = ia if ia is not None else (ic if ic is not None else ir)
    stem = lines[iq + 1:stem_end]
    # Some pages omit the "Correct Answer:" line. The choices are still printed,
    # so run them to the Rationale rather than throwing the whole block away -
    # that is what turned 81 multiple-choice questions into answerless grid-ins.
    choice_end = ic if ic is not None else (ir if ir is not None else len(lines))
    choices = lines[ia + 1:choice_end] if ia is not None else []
    rationale = lines[ir + 1:] if ir is not None else []
    return stem, choices, answer, rationale


def paragraphs(lines):
    """Group lines into paragraphs on vertical gaps; keeps bullet runs apart."""
    out = []
    for ln in lines:
        new = (
            not out
            or ln["bullet"]                       # each mark opens its own item
            or ln["page"] != out[-1][-1]["page"]
            or ln["y"] - out[-1][-1]["y"] > PARA_GAP
        )
        if new:
            out.append([ln])
        else:
            out[-1].append(ln)
    return out


def to_html(lines, figs=()):
    """Paragraphs and bullet lists, with figure images spliced in by position.

    `figs` is [(rect, page_no, html)]; any line inside one of those rects is a
    chart label and is dropped rather than rendered as prose.
    """
    keep = [
        l for l in lines
        if not any(l["page"] == pno and pymupdf.Rect(
            l["x0"], l["y"], max(r["bbox"][2] for r in l["runs"]), l["y1"]
        ) in rect for rect, pno, _ in figs)
    ]
    items = [(pno, rect.y0, html) for rect, pno, html in figs]
    for para in paragraphs(keep):
        text = " ".join(l["text"] for l in para).strip()
        if not text:
            continue
        tag = f"<ul><li>{esc(text)}</li></ul>" if para[0]["bullet"] else f"<p>{esc(text)}</p>"
        items.append((para[0]["page"], para[0]["y"], tag))
    html = []
    for _, _, tag in sorted(items, key=lambda t: (t[0], t[1])):
        if tag.startswith("<ul>") and html and html[-1].endswith("</ul>"):
            html[-1] = html[-1][:-5] + tag[4:]
        else:
            html.append(tag)
    return "".join(html)


def split_prompt(stem_lines):
    """Passage vs the question sentence. Prompt is the trailing paragraph
    that asks something; if there is no passage before it, there is no split."""
    paras = paragraphs(stem_lines)
    if len(paras) >= 2 and " ".join(l["text"] for l in paras[-1]).rstrip().endswith("?"):
        return paras[:-1], paras[-1]
    return [], None


def parse_choices(lines):
    """Lines -> [{letter, content}]. A choice can wrap over several lines."""
    out = []
    for ln in lines:
        m = CHOICE.match(ln["text"])
        if m:
            out.append({"letter": m.group(1), "content": m.group(2).strip()})
        elif ln["bullet"] and out:
            # A few source pages mis-render a choice as a bullet instead of
            # "D." (e.g. e3bbf2bf). Treat it as the next choice, not a wrap.
            out.append({"letter": chr(ord(out[-1]["letter"]) + 1),
                        "content": ln["text"].strip()})
        elif out:
            out[-1]["content"] += " " + ln["text"].strip()
    for c in out:
        text = c["content"].replace("\xad", "").strip()
        c["content"] = f"<p>{esc(text)}</p>"
    return out


def build(doc, qid, pages, labels, img_dir, nfig_box):
    """One question -> row dict, or None if the page has no Question marker."""
    lines = collect(doc, pages)
    # A vector cluster in the choices or the rationale is not a stem figure.
    # Gluing it onto the stem both printed the wrong picture above the question
    # and made fill_math skip that region, so those choices lost their notation.
    stem_end = section_end(lines)
    figs, tail_figs = [], []
    for pno in pages:
        for rect in figure_blocks(doc[pno], lines):
            bucket = figs if (pno, (rect.y0 + rect.y1) / 2) < stem_end else tail_figs
            name = f"{qid}_fig{len(figs) + len(tail_figs)}.webp"
            save_figure(doc[pno], rect, os.path.join(img_dir, name))
            bucket.append((rect, pno, f'<div class="qfig"><img src="/qimg/{name}" alt="Figure"></div>'))
    if labels:
        imgs = []
        for pno in pages:
            # notation inside a figure belongs to the picture, not the prose
            skip = [rect for rect, p, _ in figs if p == pno]
            lines += fill_math(doc[pno], lines, labels, img_dir, qid, imgs, skip)
        order = {p: i for i, p in enumerate(pages)}
        lines.sort(key=lambda l: (order[l["page"]], l["y"]))
    parsed = sections(lines)
    if not parsed:
        return None
    stem, choice_lines, answer, rationale = parsed
    if not answer:
        answer = answer_from_rationale(rationale, bool(choice_lines))
    nfig_box[0] += len(figs)
    passage, prompt = split_prompt(stem)
    if prompt:
        stem_html = ("<h3>Passage</h3>" + to_html([l for p in passage for l in p], figs)
                     + "<h3>Prompt</h3>" + to_html(prompt))
    else:
        stem_html = to_html(stem, figs)
    return {
        "id": qid,
        "stem_html": stem_html,
        "choices_json": json.dumps(parse_choices(choice_lines)),
        "correct_answer": json.dumps([answer] if answer else []),
        "explanation_html": to_html(rationale, [f for f in tail_figs if f[0].y0 >= rationale_top(rationale)]),
    }


def main(pdf, out_path, labels_path="", img_dir="public/qimg"):
    doc = pymupdf.open(pdf)
    idx = P.page_index(doc)
    os.makedirs(img_dir, exist_ok=True)
    labels = json.load(open(labels_path, encoding="utf-8")) if labels_path else None
    rows = skipped = 0
    nfig_box = [0]
    with open(out_path, "w", encoding="utf-8") as fh:
        for qid, pages in idx:
            row = build(doc, qid, pages, labels, img_dir, nfig_box)
            if row is None:
                skipped += 1
                continue
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
            rows += 1
    print(f"wrote {rows} rows to {out_path} (skipped {skipped}, {nfig_box[0]} figures)")


if __name__ == "__main__":
    main(*sys.argv[1:])
