#!/usr/bin/env python3
"""Collect all comment segments containing foreign (non-ASCII) characters from TS/CSS files,
excluding i18n locale data files. Output unique comment texts as JSON for translation mapping."""
import re, json, sys

FOREIGN = re.compile(r'[^\x00-\x7f]')

def split_comments(text):
    i, n = 0, len(text)
    parts = []
    while i < n:
        c = text[i]
        if c in ('"', "'", '`'):
            q = c; i += 1
            while i < n:
                if text[i] == '\\': i += 2; continue
                if text[i] == q: i += 1; break
                i += 1
        elif c == '/' and i+1 < n and text[i+1] == '/':
            s = i
            e = text.find('\n', i)
            if e == -1: e = n
            parts.append(('//', text[s:e])); i = e
        elif c == '/' and i+1 < n and text[i+1] == '*':
            s = i
            e = text.find('*/', i+2)
            e = n if e == -1 else e+2
            parts.append(('/*', text[s:e])); i = e
        else:
            i += 1
    return parts

result = {}
for path in sys.argv[1:]:
    with open(path, encoding='utf-8') as f:
        text = f.read()
    for kind, seg in split_comments(text):
        if not FOREIGN.search(seg):
            continue
        if kind == '//':
            inner = seg[2:].strip()
            if inner:
                result.setdefault(inner, None)
        else:
            body = seg[2:]
            if body.endswith('*/'): body = body[:-2]
            for ln in body.split('\n'):
                t = ln.strip().lstrip('*').strip()
                if t and FOREIGN.search(t):
                    result.setdefault(t, None)
print(json.dumps(list(result.keys()), ensure_ascii=False, indent=0))
