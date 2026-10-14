#!/usr/bin/env python3
"""Apply translation map (JSON: source string -> English) to comment segments AND exact
string-literal occurrences in given files. Map keys are matched exactly."""
import json, sys, re

def split_segments(text):
    i, n = 0, len(text)
    parts = []
    while i < n:
        c = text[i]
        if c in ('"', "'", '`'):
            q = c; s = i; i += 1
            while i < n:
                if text[i] == '\\': i += 2; continue
                if text[i] == q: i += 1; break
                i += 1
            parts.append(('str', s, i))
        elif c == '/' and i+1 < n and text[i+1] == '/':
            s = i
            e = text.find('\n', i)
            if e == -1: e = n
            parts.append(('line', s, e)); i = e
        elif c == '/' and i+1 < n and text[i+1] == '*':
            s = i
            e = text.find('*/', i+2)
            e = n if e == -1 else e+2
            parts.append(('block', s, e)); i = e
        else:
            i += 1
    return parts

def esc(s, q):
    out = []
    for ch in s:
        if ch == '\\': out.append('\\\\')
        elif ch == q: out.append('\\' + q)
        elif ch == '`' and q == '`': out.append('\\`')
        else: out.append(ch)
    return ''.join(out)

def main():
    mapping = json.load(open(sys.argv[1], encoding='utf-8'))
    files = sys.argv[2:]
    missing = set()
    FOREIGN = re.compile(r'[^\x00-\x7f]')
    for path in files:
        text = open(path, encoding='utf-8').read()
        segs = split_segments(text)
        # first: whole-string-literal replacement for console/error strings
        def repl_str(m_start, m_end, seg):
            body = seg[1:-1]
            q = seg[0]
            raw = body.encode().decode('unicode_escape') if '\\' in body else body
            if body in mapping:
                return q + mapping[body] + q
            return None
        out = []
        last = 0
        for kind, s, e in segs:
            seg = text[s:e]
            out.append(text[last:s]); last = e
            if not FOREIGN.search(seg):
                out.append(seg); continue
            if kind == 'str':
                body = seg[1:-1]
                if body in mapping:
                    out.append(seg[0] + mapping[body] + seg[-1])
                else:
                    out.append(seg)
                    if FOREIGN.search(body): missing.add(body)
            elif kind == 'line':
                inner = seg[2:]
                key = inner.strip()
                if key in mapping:
                    lead = inner[:len(inner)-len(inner.lstrip())]
                    out.append('//' + lead + mapping[key])
                else:
                    out.append(seg); missing.add(key)
            else:  # block
                closed = seg.endswith('*/')
                body = seg[2:-2] if closed else seg[2]
                lines = body.split('\n')
                ok = True
                newlines = []
                for ln in lines:
                    if not FOREIGN.search(ln):
                        newlines.append(ln); continue
                    m = re.match(r'^(\s*\*?\s*)(.*\S?)\s*$', ln)
                    if not m:
                        ok = False; break
                    prefix, content = m.group(1), m.group(2)
                    if not content:
                        newlines.append(ln); continue
                    if content in mapping:
                        newln = prefix + mapping[content]
                        if closed and ln is lines[-1]:
                            newln += ' '
                        newlines.append(newln)
                    else:
                        ok = False; missing.add(content); break
                if ok:
                    out.append('/*' + '\n'.join(newlines) + ('*/' if closed else ''))
                else:
                    out.append(seg)
        out.append(text[last:])
        open(path, 'w', encoding='utf-8').write(''.join(out))
    if missing:
        print('MISSING KEYS:')
        for m in sorted(missing):
            print(repr(m))
main()
