"""Merge a {sheet index: character} map into glyph_labels.json."""
import json, sys
sigs = json.load(open(sys.argv[1]))
new = json.load(open(sys.argv[2], encoding="utf-8"))
L = json.load(open("tools/glyph_labels.json", encoding="utf-8"))
for i, ch in new.items():
    L[sigs[int(i)]] = ch
json.dump(L, open("tools/glyph_labels.json", "w", encoding="utf-8"),
          ensure_ascii=False, indent=0)
print("labels now", len(L))
