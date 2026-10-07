"""E1: mechanical checks on each alias answer in out/e1-results.jsonl (the checks T15 adds to
extraction/checks.ts cleanAliases, proposed). A person still judges "would someone search by it".

    python3 e1_check.py out/e1-results.jsonl
"""

import json
import re
import sys

ARABIC = re.compile(r"^[؀-ۿݐ-ݿ\s\-٠-٩0-9]+$")
LATIN = re.compile(r"^[A-Za-z0-9\s\-'&./+]+$")
URL = re.compile(r"https?://|www\.|\.[a-z]{2,4}/", re.I)


def problems(name, lang, alias):
    out = []
    a = alias.strip()
    if not a:
        out.append("empty")
    if a.casefold() == name.casefold():
        out.append("repeats the name")
    if lang == "ar" and not ARABIC.match(a):
        out.append("not Arabic script")
    if lang == "en" and not LATIN.match(a):
        out.append("not Latin script")
    if len(a.split()) > 4:
        out.append("over 4 words")
    if URL.search(a):
        out.append("url")
    if re.fullmatch(r"[\d\s\-]+", a):
        out.append("digits only")
    return out


for line in open(sys.argv[1], encoding="utf-8"):
    r = json.loads(line)
    if "answer" not in r:
        print(f"-- {r['lang']} {r['from']}+{r['count']}: no answer ({r.get('error', {}).get('statusCode')})")
        continue
    items = r["answer"]["items"]
    idx = sorted(i["i"] for i in items)
    ok_idx = idx == list(range(1, r["count"] + 1))
    bad = 0
    total = 0
    for it in items:
        name = r["names"][it["i"] - 1]
        for lang, lst in it["aliases"].items():
            if len(lst) > r["perLang"]:
                print(f"   {name} [{lang}] {len(lst)} aliases > {r['perLang']}")
            for a in lst:
                total += 1
                p = problems(name, lang, a)
                if p:
                    bad += 1
                    print(f"   {name} [{lang}] {a!r}: {', '.join(p)}")
    u = r["usage"]
    print(
        f"-- {r['lang']} {r['from']}+{r['count']} reasoning={r.get('reasoningLevel', 'low')} per-lang={r['perLang']}"
        f" out={u['output']} reasoning_tokens={u.get('reasoning')} indexes={'ok' if ok_idx else idx}"
        f" flagged={bad}/{total}"
    )
