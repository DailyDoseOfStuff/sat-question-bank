"""Restore the underline the Reading & Writing questions ask about.

100 RW stems say "the underlined sentence" / "the underlined portion" and more
still (Words in Context, mostly) underline the word being asked about, but the
extractor never carried the mark: an underline in these PDFs is a filled rect
0.8pt tall drawn under the glyphs, not a font attribute, so it lives in
page.get_drawings() and nothing looked for it there.

This finds those rects inside a question's stem band, reads off which
characters sit above them, and wraps the same text in <u> in the stored
stem_html. A table's ruling is the same shape as an underline, so any rect
inside a figure cluster is dropped - that is what the "underlines" on the data
questions were.

  python tools/underline.py --selftest   # the html-splicing rules
  python tools/underline.py              # what would change, nothing written
  python tools/underline.py --write      # local D1, then migrations/0009
  python tools/underline.py --emit       # migrations/0009 alone, off the local D1
"""
import os
import re
import sys
import glob
import html
import json
import sqlite3

import pymupdf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pdfcommon as P          # noqa: E402
import extract as E            # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PDF = os.path.expanduser("~/Downloads/OfficialSatReading.pdf")
MIGRATION = os.path.join(ROOT, "migrations", "0009_rw_underline.sql")

RULE_H = 2.0        # an underline is a hairline fill; anything taller is art
RULE_W = 2.0        # ...and at least this wide, else it is a bullet or a dot
DROP = 4.0          # how far below a glyph's foot the rule may sit
LIFT = 3.0          # ...and how far into it, for a descender
LINE_TOL = 3.0      # y change over this much means a new visual line
CTX = 40            # chars of preceding text used to place a repeated span


def rules(page, y0, y1, figs):
    """Underline rects in the band, minus the ones that are table rules."""
    out = []
    for d in page.get_drawings():
        r = d["rect"]
        if r.height > RULE_H or r.width < RULE_W or not (y0 <= r.y0 <= y1):
            continue
        if any(r.x0 >= f.x0 - 2 and r.x1 <= f.x1 + 2
               and r.y0 >= f.y0 - 2 and r.y1 <= f.y1 + 2 for f in figs):
            continue           # a table's ruling, not an underline
        out.append(r)
    return out


def chars(page, y0, y1):
    """(char, bbox) in reading order, spurious spaces dropped as pdfcommon does."""
    out = []
    for b in page.get_text("rawdict")["blocks"]:
        if b["type"] != 0:
            continue
        for line in b["lines"]:
            for span in line["spans"]:
                fs = span["size"] or 1.0
                for ch in span["chars"]:
                    bb = ch["bbox"]
                    if not (y0 <= bb[1] <= y1):
                        continue
                    if ch["c"] == " " and (bb[2] - bb[0]) / fs < P.SPACE_RATIO:
                        continue
                    out.append((ch["c"], bb))
    return out


def spans_on(page, y0, y1, figs):
    """[(text, context_before)] for each run of underlined characters."""
    marks = rules(page, y0, y1, figs)
    if not marks:
        return []
    out, cur, before, prev_y = [], [], [], None
    for c, bb in chars(page, y0, y1):
        hit = any(m.x0 - 1 <= (bb[0] + bb[2]) / 2 <= m.x1 + 1
                  and bb[3] - LIFT <= m.y0 <= bb[3] + DROP for m in marks)
        gap = "\n" if prev_y is not None and abs(bb[1] - prev_y) > LINE_TOL else ""
        prev_y = bb[1]
        if hit:
            cur.append(gap + c)
        else:
            if cur:
                out.append(("".join(cur), "".join(before[-CTX:])))
                before += cur
                cur = []
            before.append(gap + c)
    if cur:
        out.append(("".join(cur), "".join(before[-CTX:])))
    return [(t.strip(), re.sub(r"\s+", " ", c)) for t, c in out if t.strip()]


def stem_marks(doc, pages):
    """[(text, context)] for every underline inside this question's stem."""
    sec = E.sections(E.collect(doc, pages))
    if not sec or not sec[0]:
        return []
    stem = sec[0]
    spans = []
    for pno in sorted({l["page"] for l in stem}):
        ys = [l for l in stem if l["page"] == pno]
        top = P.BANNER_BOTTOM if pno == pages[0] else 0
        spans += spans_on(doc[pno],
                          min(l["y"] for l in ys) - 4,
                          max(l["y1"] for l in ys) + 4,
                          P.figures(doc[pno], top=top))
    return spans


# --- splicing (--selftest covers this half) ---
ENT = re.compile(r"&(amp|lt|gt);")
SEP = "\x00"        # between text nodes, so a match can never cross a block


def flatten(doc_html):
    """(plain, offsets) - plain text of the html, with each character's offset."""
    plain, off, i = [], [], 0
    for part in re.split(r"(<[^>]+>)", doc_html):
        if not part:
            continue
        if part.startswith("<"):
            if plain and plain[-1] != SEP:
                plain.append(SEP)
                off.append(i)
        else:
            j = 0
            while j < len(part):
                m = ENT.match(part, j)
                plain.append(html.unescape(m.group(0)) if m else part[j])
                off.append(i + j)
                j = m.end() if m else j + 1
        i += len(part)
    return "".join(plain), off


def squash(plain, off):
    """Whitespace collapsed to a single space, offsets carried through."""
    out, o = [], []
    for ch, pos in zip(plain, off):
        if ch.isspace():
            if out and out[-1] == " ":
                continue
            ch = " "
        out.append(ch)
        o.append(pos)
    return "".join(out), o


def common_tail(a, b):
    n = 0
    while n < min(len(a), len(b)) and a[-1 - n] == b[-1 - n]:
        n += 1
    return n


def locate(doc_html, text, context):
    """(start, end) html offsets of `text`, or None. Repeats are placed by
    whichever occurrence's own lead-in best matches the PDF's."""
    flat, off = squash(*flatten(doc_html))
    want = re.sub(r"\s+", " ", text).strip()
    if not want or SEP in want:
        return None
    hits = [m.start() for m in re.finditer(re.escape(want), flat)]
    if not hits:
        return None
    if len(hits) > 1:
        ctx = re.sub(r"\s+", " ", context)   # not stripped: the trailing space counts
        hits.sort(key=lambda h: -common_tail(flat[:h], ctx))
    i = hits[0]
    return off[i], off[i + len(want) - 1] + 1


def pieces(text, context):
    """A mark and its lead-in, one entry per line of the pdf. A mark that runs
    over a block boundary - three lines of a poem, each its own <p> - matches
    nothing whole, but every line of it matches on its own."""
    out = []
    for line in text.split("\n"):
        if line.strip():
            out.append((line, context))
        context += line + " "
    return out


def underline(doc_html, spans):
    """Wrap each (text, context) in <u>. Returns (html, [texts not found])."""
    cuts, missed, queue = [], [], list(spans)
    while queue:
        text, context = queue.pop(0)
        at = locate(doc_html, text, context)
        if at is None and "\n" in text:
            queue = pieces(text, context) + queue
            continue
        if at is None:
            missed.append(re.sub(r"\s+", " ", text))
            continue
        if any(a < at[1] and at[0] < b for a, b in cuts):
            continue           # overlaps one already marked
        cuts.append(at)
    for a, b in sorted(cuts, reverse=True):
        doc_html = doc_html[:a] + "<u>" + doc_html[a:b] + "</u>" + doc_html[b:]
    return doc_html, missed
# --- end splicing ---


def local_db():
    d = os.path.join(ROOT, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject")
    f = [x for x in glob.glob(os.path.join(d, "*.sqlite")) if "metadata" not in x]
    return f[0]


def run(write):
    con = sqlite3.connect(local_db())
    rw = {i: h for i, h in con.execute(
        "select id, stem_html from questions where section like 'Reading%'")}
    doc = pymupdf.open(PDF)
    out, missed, nomatch = {}, {}, 0
    for qid, pages in P.page_index(doc):
        if qid not in rw or "<u>" in rw[qid]:
            continue
        spans = stem_marks(doc, pages)
        if not spans:
            continue
        marked, miss = underline(rw[qid], spans)
        if miss:
            missed[qid] = miss
        if marked != rw[qid]:
            out[qid] = marked
        else:
            nomatch += 1
    print("%d rows to underline, %d whose marks matched no stem text"
          % (len(out), nomatch))
    if missed:
        print("%d rows with a span that did not match:" % len(missed))
        for qid, m in list(missed.items())[:25]:
            print("  ", qid, json.dumps(m)[:140])
    if not write:
        return out
    con.executemany("update questions set stem_html=? where id=?",
                    [(h, q) for q, h in out.items()])
    con.commit()
    print("local sqlite updated, %d rows" % len(out))
    emit(con)
    return out


def emit(con=None):
    """The migration is written from the repaired table, not from the run's own
    diff, so it is still the whole change after --write has already been made."""
    con = con or sqlite3.connect(local_db())
    rows = [r for r in con.execute(
        "select id, stem_html from questions where section like 'Reading%'")
        if "<u>" in r[1]]
    os.makedirs(os.path.dirname(MIGRATION), exist_ok=True)
    with open(MIGRATION, "w", encoding="utf-8", newline="\n") as f:
        f.write("-- Reading & Writing: restore the underline the question asks about.\n")
        for qid, h in rows:
            f.write("UPDATE questions SET stem_html='%s' WHERE id='%s';\n"
                    % (h.replace("'", "''"), qid))
    print("%d statements in %s" % (len(rows), MIGRATION))


def _selftest():
    h = "<h3>Passage</h3><p>One two three. Four five six.</p>"
    got, miss = underline(h, [("Four five six.", "One two three. ")])
    assert not miss and got == \
        "<h3>Passage</h3><p>One two three. <u>Four five six.</u></p>", got
    # a repeated word is placed by its lead-in, not by first occurrence
    h2 = "<p>the cat sat. a dog and the cat ran.</p>"
    got, _ = underline(h2, [("cat", "a dog and the ")])
    assert got == "<p>the cat sat. a dog and the <u>cat</u> ran.</p>", got
    # a span the stem does not carry (a table rule's header) is reported, not forced
    got, miss = underline(h, [("Menus", "")])
    assert got == h and miss == ["Menus"], (got, miss)
    # entities keep their offsets
    h3 = "<p>Ben &amp; Jerry made it. Then they left.</p>"
    got, _ = underline(h3, [("Ben & Jerry made it.", "")])
    assert got == "<p><u>Ben &amp; Jerry made it.</u> Then they left.</p>", got
    # a mark may not run across a block boundary
    h4 = "<p>alpha beta</p><p>gamma delta</p>"
    got, miss = underline(h4, [("beta gamma", "alpha ")])
    assert got == h4 and miss == ["beta gamma"], (got, miss)
    # the line breaks the pdf reads off come through as single spaces
    got, _ = underline(h, [("Four  five\nsix.", "")])
    assert "<u>Four five six.</u>" in got, got
    # two marks on one stem, spliced back to front so the offsets hold
    got, _ = underline(h, [("One two", ""), ("five six", "Four ")])
    assert got == \
        "<h3>Passage</h3><p><u>One two</u> three. Four <u>five six</u>.</p>", got
    # a mark over a block boundary is spliced line by line
    h5 = "<p>and all commands. But in my soul</p><p>The billows roll</p>"
    got, miss = underline(h5, [("But in my soul\nThe billows roll", "and all commands. ")])
    assert not miss and got == \
        "<p>and all commands. <u>But in my soul</u></p><p><u>The billows roll</u></p>", got
    print("selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        _selftest()
    elif "--emit" in sys.argv:
        emit()
    else:
        run("--write" in sys.argv)
