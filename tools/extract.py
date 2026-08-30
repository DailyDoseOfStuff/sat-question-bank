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


def raster_figures(page):
    """Bitmap illustrations embedded in the page.

    Some pages carry no vector art at all - the diagram is a bitmap, and
    P.figures() (which clusters drawings) sees nothing. Left alone they fall
    through to fill_math as unidentifiable notation and get cropped inline, so
    a whole triangle printed at x-height in the middle of the sentence. Size
    tells them apart: notation crops here are never more than ~25pt tall.
    """
    return [pymupdf.Rect(i["bbox"]) for i in page.get_image_info()
            if i["bbox"][1] >= P.BANNER_BOTTOM
            and i["bbox"][2] - i["bbox"][0] >= P.FIG_MIN_W
            and i["bbox"][3] - i["bbox"][1] >= P.FIG_MIN_H]


def figure_blocks(page, lines):
    """Figure rects grown to include their own labels.

    A bare vector cluster is just the plot area - the title, axis numbers and
    category names sit in the text layer around it and are meaningless as
    prose. Absorb every neighbouring non-prose line, stopping at body text.
    """
    blocks = []
    for fig in list(P.figures(page)) + raster_figures(page):
        rect = pymupdf.Rect(fig)
        changed = True
        while changed:
            changed = False
            for ln in lines:
                if ln["page"] != page.number or ln["x0"] < LABEL_X:
                    continue
                if ln["y1"] <= P.BANNER_BOTTOM:
                    continue          # a metadata banner cell, not a caption
                box = pymupdf.Rect(ln["x0"], ln["y"],
                                   max(r["bbox"][2] for r in ln["runs"]), ln["y1"])
                if box in rect:
                    continue
                near = pymupdf.Rect(rect.x0 - 40, rect.y0 - 60, rect.x1 + 40, rect.y1 + 60)
                if near.intersects(box):
                    rect |= box
                    changed = True
        # never let a block reach up into the banner: cropping one printed the
        # question's own metadata across the top of the figure
        rect.y0 = max(rect.y0, P.BANNER_BOTTOM)
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
FIG_PAD = 22.0           # a chart's own labels sit this far outside its box
RULE_MIN_L = 30.0        # a stroke this long is a table rule, not a dash
CELL_GAP = 4.0           # glyphs this far apart in a cell are separate runs
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


TEX = {
    "%": r"\%", "$": r"\$", "&": r"\&", "#": r"\#",
    "°": r"^{\circ}", "π": r"\pi ", "×": r"\times ", "÷": r"\div ",
    "±": r"\pm ", "≥": r"\ge ", "≤": r"\le ", "≠": r"\neq ",
    "∞": r"\infty ", "△": r"\triangle ", "−": "-",
    "√": r"\sqrt ", "∛": r"\sqrt[3] ",
}

# A comma sits below the baseline and a degree sign above it; neither is a
# script. Without this list every "f(x), where" turned into "f(x)_{,}".
NOSCRIPT = set(",.;:'\"-−+=<>≤≥≠×÷±/()[]|°%$")

SUP_GAP = 0.25           # glyph bottom this far above the baseline = exponent
SUB_GAP = 0.18           # glyph top this far below it = index
SCRIPT_H = 0.85          # ...and a script is never full height
STACK_TOL = 0.35         # a baseline glyph never sits further off than this


def tex_escape(s):
    """LaTeX for a decoded run, leaving any command already in it alone."""
    out, i = [], 0
    while i < len(s):
        if s[i] == "\\":
            j = i + 1
            while j < len(s) and (s[j].isalpha() or s[j] in "[]"):
                j += 1
            out.append(s[i:j])
            i = j
            continue
        out.append(TEX.get(s[i], s[i]))
        i += 1
    return "".join(out)


def as_math(raw):
    """Wrap a decoded run in math delimiters, or leave it as prose.

    A bare quantity ("210", "3.5") reads better as text and keeps the sentence
    searchable; anything with a variable or structure is real notation.
    """
    if raw is None:
        return None
    if not re.search(r"[A-Za-z^_\\]", raw):
        return raw
    return r"\(" + tex_escape(raw) + r"\)"


def _box(items):
    b = pymupdf.Rect(items[0][1])
    for _, r in items:
        b |= r
    return b


def _midy(r):
    return (r.y0 + r.y1) / 2


def decode_slot(group, bars, labels):
    """LaTeX for one run of drawn glyphs, or None if a shape is unknown.

    Stacked notation is not refused any more: a bar with ink above and below is
    a fraction, a bar with a radical to its left is a root, and anything sitting
    off the baseline is an exponent or an index. Only an unlabelled shape still
    forces the caller to crop a picture.
    """
    if not group:
        return ""
    if any(labels.get(s) is None for s, _ in group):
        return None
    box = _box(group)
    # A fraction bar is drawn a little wider than the digits it separates, so
    # containment is the wrong test - overlap is.
    mine = [b for b in bars
            if b.x1 > box.x0 and b.x0 < box.x1 and b.width <= box.width + 8
            and box.y0 - 1 <= _midy(b) <= box.y1 + 1]
    return _tex(sorted(group, key=lambda g: g[1].x0), mine, labels)


def _split_at(items, bar):
    """items left of the bar, under/over it, and right of it."""
    left = [g for g in items if g[1].x1 <= bar.x0 + 0.5]
    right = [g for g in items if g[1].x0 >= bar.x1 - 0.5]
    seen = {id(g[1]) for g in left} | {id(g[1]) for g in right}
    return left, [g for g in items if id(g[1]) not in seen], right


def _tex(items, bars, labels):
    if not items:
        return ""
    box = _box(items)
    best = None
    for b in bars:
        _, inner, _ = _split_at(items, b)
        num = [g for g in inner if _midy(g[1]) < _midy(b)]
        den = [g for g in inner if _midy(g[1]) > _midy(b)]
        if num and den and (best is None or b.width > best[0].width):
            best = (b, num, den)
    if best:
        bar, num, den = best
        rest = [b for b in bars if b is not bar]
        left, _, right = _split_at(items, bar)
        # a radical sign printed flush against the bar owns what is under it
        rad = [g for g in left if labels[g[0]] in ("√", "∛")
               and bar.x0 - g[1].x1 < 3]
        head = _tex([g for g in left if g not in rad], rest, labels)
        tail = _tex(right, rest, labels)
        if rad:
            body = _tex(num + den, rest, labels)
            cmd = r"\sqrt[3]" if labels[rad[-1][0]] == "∛" else r"\sqrt"
            mid = None if body is None else cmd + "{" + body + "}"
        else:
            top, bot = _tex(num, rest, labels), _tex(den, rest, labels)
            mid = (None if top is None or bot is None
                   else r"\frac{" + top + "}{" + bot + "}")
        if head is None or mid is None or tail is None:
            return None
        return head + mid + tail
    # a bar with ink on one side only is the overline of a root
    for b in bars:
        left, inner, right = _split_at(items, b)
        rad = [g for g in left if labels[g[0]] in ("√", "∛") and b.x0 - g[1].x1 < 3]
        if rad and inner:
            rest = [x for x in bars if x is not b]
            cmd = r"\sqrt[3]" if labels[rad[-1][0]] == "∛" else r"\sqrt"
            head = _tex([g for g in left if g not in rad], rest, labels)
            body = _tex(inner, rest, labels)
            tail = _tex(right, rest, labels)
            if None in (head, body, tail):
                return None
            return head + cmd + "{" + body + "}" + tail
    return _linear(items, labels)


def _linear(items, labels):
    """One baseline run, with exponents and indices lifted into ^{} and _{}."""
    em = max(r.y1 - r.y0 for _, r in items) or 1.0
    base = sorted(r.y1 for _, r in items)[len(items) // 2]
    out, mode, prev = "", "", None
    for s, r in items:
        ch = labels[s]
        kind = ""
        if ch not in NOSCRIPT and (r.y1 - r.y0) < SCRIPT_H * em:
            if r.y1 <= base - SUP_GAP * em:
                kind = "^"
            elif r.y0 >= base - SUB_GAP * em:
                kind = "_"
        if kind == "" and ch not in NOSCRIPT and abs(r.y1 - base) > STACK_TOL * em:
            # full height and well off the baseline: a numerator or a radicand
            # whose structure was not recognised. Reading it left to right
            # turned "1 over 71" into "171", so refuse and keep the picture.
            return None
        if kind != mode:
            out += "}" if mode else ""
            out += kind + "{" if kind else ""
            mode = kind
        elif prev is not None and not kind and r.x0 - prev.x1 > SPACE_FRAC * em:
            out += " "
        out += ch
        prev = r
    return out + ("}" if mode else "")


def fill_math(page, lines, labels, img_dir, qid, out_imgs, skip=(), near=()):
    """Rewrite each line's text with its drawn notation put back in place.

    Every glyph is assigned to a slot on its line - before the first run,
    between two runs, or after the last - so notation that lands at a line
    break is not lost. Simple runs become real characters; stacked notation
    becomes a small inline image, so nothing is silently dropped.

    `skip` is the figure rects on this page, whose notation belongs to the
    picture. `near` is those rects with a margin: a chart's rotated axis title
    is drawn just outside its own box, and cropping each of its letters was
    what put a column of one-letter pictures under every graph.
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
    pad = [pymupdf.Rect(f.x0 - FIG_PAD, f.y0 - FIG_PAD,
                        f.x1 + FIG_PAD, f.y1 + FIG_PAD) for f in near]
    for row in _rows([(s, r) for s, r in glyphs if id(r) not in used]):
        box = pymupdf.Rect(row[0][1])
        for _, r in row:
            box |= r
        if any(box in f for f in pad):
            continue
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
    text = as_math(decode_slot(group, bars, labels))
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


def _grid_lines(page, rect):
    """Thin horizontal and vertical strokes inside a block - a table's ruling.

    Measured against the strokes themselves, never against the block: figure
    blocks grow to swallow their own captions, so "spans most of the block" is
    not a test a real table rule can pass. The metadata banner is ruled like a
    table too, so it is excluded the same way it is everywhere else.
    """
    hs, vs = [], []
    for d in page.get_drawings():
        r = d["rect"]
        if r.y0 < P.BANNER_BOTTOM:
            continue
        if not (rect.y0 - 2 <= r.y0 and r.y1 <= rect.y1 + 2
                and rect.x0 - 4 <= r.x0 and r.x1 <= rect.x1 + 4):
            continue
        if glyphmap.signature(d):
            continue
        if r.height <= BAR_MAX_H and r.width >= RULE_MIN_L:
            hs.append(r)
        elif r.width <= BAR_MAX_H and r.height >= 8:
            vs.append(r)
    return hs, vs


def _merge(values, tol=2.5):
    """Sorted coordinates with near-duplicates collapsed."""
    out = []
    for v in sorted(values):
        if out and v - out[-1] <= tol:
            continue
        out.append(v)
    return out


def _uniform(vals):
    gaps = [b - a for a, b in zip(vals, vals[1:])]
    return len(gaps) > 2 and max(gaps) - min(gaps) <= 1.5


def _is_art(page, box):
    """True if anything in the box is drawn rather than printed.

    A bar, a pie slice, a plotted curve or an axis all leave a mark that is
    wide and tall at once; a table is only rules and characters. Getting this
    wrong the safe way means a picture, not an invented grid.
    """
    for d in page.get_drawings():
        r = d["rect"]
        if not (box.y0 - 2 <= r.y0 and r.y1 <= box.y1 + 2
                and box.x0 - 2 <= r.x0 and r.x1 <= box.x1 + 2):
            continue
        if glyphmap.signature(d):
            continue
        if r.width > 3 and r.height > 3:
            return True
    return False


def _band(cuts, lines, pos, across):
    """Index of the band `pos` falls in, counting only the rules that reach it.

    A header cell spanning two rows has no rule under it, so the rule that
    splits its neighbours must not split it: the band is the last cut actually
    drawn across this column, which puts "Hours" and "practiced" in one cell.
    """
    best = None
    for r, cut in zip(lines, cuts):
        if r[0] - 2 <= across <= r[1] + 2 and cut <= pos + 1:
            if best is None or cut > best:
                best = cut
    if best is None:
        return None
    for i, c in enumerate(cuts):
        if abs(c - best) <= 0.01:
            return i
    return None


def table_of(page, rect, labels):
    """(rect, html) for a ruled data table inside a block, or None.

    The ruling defines the cells, so the table's own bounds are returned too:
    they are far tighter than the block, which keeps the sentence printed above
    the table in the prose instead of swallowing it into a picture.
    """
    if not labels:
        return None
    hs, vs = _grid_lines(page, rect)
    ycuts, xcuts = [], []
    yspan, xspan = [], []
    for y in _merge([_midy(r) for r in hs]):
        reach = [r for r in hs if abs(_midy(r) - y) <= 2.5]
        ycuts.append(y)
        yspan.append((min(r.x0 for r in reach), max(r.x1 for r in reach)))
    for x in _merge([(r.x0 + r.x1) / 2 for r in vs]):
        reach = [r for r in vs if abs((r.x0 + r.x1) / 2 - x) <= 2.5]
        xcuts.append(x)
        xspan.append((min(r.y0 for r in reach), max(r.y1 for r in reach)))
    if len(ycuts) < 3 or len(xcuts) < 3:
        return None
    box = pymupdf.Rect(xcuts[0], ycuts[0], xcuts[-1], ycuts[-1])
    if box.width < 60 or box.height < 20:
        return None
    if _is_art(page, box):
        return None
    if _uniform(ycuts) and _uniform(xcuts):
        return None                     # evenly ruled both ways: a plot grid

    def cell_of(b):
        cx, cy = (b.x0 + b.x1) / 2, _midy(b)
        if not (box.x0 - 2 <= cx <= box.x1 + 2 and box.y0 - 2 <= cy <= box.y1 + 2):
            return None, None
        row = _band(ycuts, yspan, cy, cx)
        col = _band(xcuts, xspan, cx, cy)
        if row is None or row >= len(ycuts) - 1:
            return None, None
        if col is None or col >= len(xcuts) - 1:
            return None, None
        return row, col

    grid = [[[] for _ in xcuts[:-1]] for _ in ycuts[:-1]]
    for run in P._runs(page):
        if not run["text"].strip():
            continue
        b = pymupdf.Rect(run["bbox"])
        row, col = cell_of(b)
        if row is not None:
            grid[row][col].append((b.y0, b.y1, b.x0, b.x1, run["text"]))
    inner = [d["rect"] for d in page.get_drawings()
             if d["rect"].height <= BAR_MAX_H and 3 < d["rect"].width < RULE_MIN_L
             and box.x0 - 2 <= d["rect"].x0 and d["rect"].x1 <= box.x1 + 2
             and box.y0 - 2 <= d["rect"].y0 and d["rect"].y1 <= box.y1 + 2]
    cells = {}
    for sig, g in glyphmap.glyphs_on(page):
        gr = pymupdf.Rect(g)
        row, col = cell_of(gr)
        if row is not None:
            cells.setdefault((row, col), []).append((sig, gr))
    for (row, col), gs in cells.items():
        for line in _rows(gs):
            for group in _cell_runs(line):
                text = as_math(decode_slot(group, inner, labels))
                if text is None:
                    return None         # an unknown shape: keep the picture
                b = _box(group)
                grid[row][col].append((b.y0, b.y1, b.x0, b.x1, text))
    grid = _trim(grid)
    if not grid or len(grid) < 2 or len(grid[0]) < 2:
        return None
    html = ""
    for i, row in enumerate(grid):
        tag = "th" if i == 0 else "td"
        html += "<tr>" + "".join(f"<{tag}>{esc(_cell(c))}</{tag}>"
                                 for c in row) + "</tr>"
    return (pymupdf.Rect(box.x0 - 3, box.y0 - 3, box.x1 + 3, box.y1 + 3),
            '<div class="qtable"><table>' + html + "</table></div>")


def _cell_runs(line):
    """One row of a cell's glyphs, split where a word-sized gap sits.

    Left whole, "50%" and "80%" decode as a single piece spanning the words
    printed between them, and the cell reads "50% 80%to".
    """
    out, group = [], []
    for g in line:
        if group and g[1].x0 - group[-1][1].x1 > CELL_GAP:
            out.append(group)
            group = []
        group.append(g)
    if group:
        out.append(group)
    return out


def _cell(pieces):
    """One cell's text: pieces banded into lines, then read left to right.

    Sorting on y alone scrambled cells that mix prose with drawn notation -
    "Less than 50%" came out "50% Less than" because the glyphs sat a fraction
    of a point higher than the words beside them.
    """
    bands = []
    for y0, y1, x0, x1, text in sorted(pieces):
        mid = (y0 + y1) / 2
        for b in bands:
            if b[0] - 1 <= mid <= b[1] + 1:
                b[0], b[1] = min(b[0], y0), max(b[1], y1)
                b[2].append((x0, x1, text))
                break
        else:
            bands.append([y0, y1, [(x0, x1, text)]])
    out = ""
    for i, band in enumerate(sorted(bands, key=lambda b: b[0])):
        if i:
            out += " "
        prev = None
        for x0, x1, text in sorted(band[2]):
            if prev is not None and x0 - prev > 1.0:
                out += " "
            out += text
            prev = x1
    return re.sub(r"\s+", " ", out).strip()


def _trim(grid):
    """Drop the empty rows and columns the outer border adds."""
    grid = [r for r in grid if any(c for c in r)]
    if not grid:
        return grid
    keep = [i for i in range(len(grid[0])) if any(r[i] for r in grid)]
    return [[r[i] for i in keep] for r in grid]


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
            tab = table_of(doc[pno], rect, labels)
            if tab:
                bucket.append((tab[0], pno, tab[1]))
                continue
            name = f"{qid}_fig{len(figs) + len(tail_figs)}.webp"
            save_figure(doc[pno], rect, os.path.join(img_dir, name))
            bucket.append((rect, pno, f'<div class="qfig"><img src="/qimg/{name}" alt="Figure"></div>'))
    if labels:
        imgs = []
        for pno in pages:
            # notation inside a figure belongs to the picture, not the prose
            skip = [rect for rect, p, _ in figs if p == pno]
            near = [rect for rect, p, _ in figs + tail_figs if p == pno]
            lines += fill_math(doc[pno], lines, labels, img_dir, qid, imgs,
                               skip, near)
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
