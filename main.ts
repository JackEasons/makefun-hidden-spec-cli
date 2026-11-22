// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  /** Successful moves, as [old, new], for the R lines of section 2. */
  readonly moves: Array<[string, string]> = [];
}

/** A file's text as lines: its break, its lines, whether it ends with a break (section 3). */
interface FileState {
  br: string;
  lines: string[];
  final: boolean;
}
function splitFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}
function joinFile(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.final ? st.br : '');
}

/** One line as a tier of section 5 sees it. */
function tierOf(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
/** 0-based positions where o occurs in fileLines at a tier; occurrences may overlap. */
function occurrences(fileLines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  const ot = o.map((l) => tierOf(l, tier));
  for (let i = 0; i + o.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (tierOf(fileLines[i + j]!, tier) !== ot[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}
/** The first tier at which o occurs, with its positions; null when it occurs at none. */
function findTier(fileLines: string[], o: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(fileLines, o, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}
/** Like findTier, but only occurrences at or after `from`, the first of them; eofOnly keeps only ones ending at the last line. */
function findTierFrom(fileLines: string[], o: string[], from: number, strict: boolean, eofOnly = false): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(fileLines, o, t).filter((p) => p >= from && (!eofOnly || p + o.length === fileLines.length));
    if (occ.length > 0) return { tier: t, pos: occ[0]! };
  }
  return null;
}
function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}
/** One line of N: a context line (written as the file's own matched line) or a new line. */
interface NItem {
  text: string;
  ctx: boolean;
  oIndex: number;
}
/** N as written over the matched lines at pos (section 5): context lines from the file, tier-2 re-indent for the rest. */
function buildReplacement(fileLines: string[], o: string[], n: NItem[], pos: number, tier: number): string[] {
  const f = leadingWs(fileLines[pos] ?? '');
  const p = leadingWs(o[0] ?? '');
  const out: string[] = [];
  for (const item of n) {
    if (item.ctx) {
      out.push(fileLines[pos + item.oIndex]!);
      continue;
    }
    const t = item.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) out.push(f + t.slice(p.length));
    else out.push(t);
  }
  return out;
}
/** A body item of a hunk or chunk: context, old, new, or a backslash line (which marks the item before it). */
interface BodyItem {
  type: 'ctx' | 'old' | 'new';
  text: string;
  noNl?: boolean;
}
/** O and N of a hunk or chunk body, in body order. */
function bodyON(items: BodyItem[]): { o: string[]; n: NItem[] } {
  const o: string[] = [];
  const n: NItem[] = [];
  let oCount = 0;
  for (const it of items) {
    if (it.type === 'ctx') {
      o.push(it.text);
      n.push({ text: it.text, ctx: true, oIndex: oCount });
      oCount++;
    } else if (it.type === 'old') {
      o.push(it.text);
      oCount++;
    } else {
      n.push({ text: it.text, ctx: false, oIndex: -1 });
    }
  }
  return { o, n };
}
/** Whether a backslash line follows the body's last context or new line. */
function lastCtxOrNewNoNl(items: BodyItem[]): boolean {
  for (let k = items.length - 1; k >= 0; k--) {
    const it = items[k]!;
    if (it.type === 'ctx' || it.type === 'new') return !!it.noNl;
  }
  return false;
}

type Edit = (tree: Tree) => void;

/** One unified hunk: its -A start and its body items. */
interface Hunk {
  a: number;
  items: BodyItem[];
}
/** One unified section, as its header names it. */
interface Section {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  lonePlus: string | null;
  renFrom: string | null;
  renTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}
/** A `--- ` or `+++ ` path: text after the four characters, up to the first tab, trimmed, one leading a/ or b/ removed. */
function cleanUnifiedPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}
/** Parse one unified section's header and hunks from index i; returns the index after the section. */
function parseUnifiedSection(lines: string[], i: number, sec: Section): number {
  const n = lines.length;
  let inHeader = true;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: parseInt(m[1]!, 10), items: [] };
      i++;
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          if (b.startsWith('\\')) {
            const prev = hunk.items[hunk.items.length - 1];
            if (prev) prev.noNl = true;
          } else if (b === '') hunk.items.push({ type: 'ctx', text: '' });
          else if (b.startsWith(' ')) hunk.items.push({ type: 'ctx', text: b.slice(1) });
          else if (b.startsWith('-')) hunk.items.push({ type: 'old', text: b.slice(1) });
          else hunk.items.push({ type: 'new', text: b.slice(1) });
          i++;
        } else break;
      }
      while (hunk.items.length > 0) {
        const last = hunk.items[hunk.items.length - 1]!;
        if (last.type === 'ctx' && last.text === '') hunk.items.pop();
        else break;
      }
      sec.hunks.push(hunk);
      inHeader = false;
      continue;
    }
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (inHeader) {
        sec.pairOld = cleanUnifiedPath(line);
        sec.pairNew = cleanUnifiedPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      break;
    }
    if (inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        sec.lonePlus = cleanUnifiedPath(line);
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        sec.renFrom = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        sec.renTo = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec.newFile = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec.delFile = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  return i;
}
/** One unified section's edit (section 6). */
function makeUnifiedEdit(sec: Section, strict: boolean): Edit {
  const oldP = sec.pairOld ?? sec.renFrom ?? sec.gitOld ?? '';
  const newP = sec.pairNew ?? sec.renTo ?? sec.lonePlus ?? sec.gitNew ?? '';
  const isCreate = oldP === '/dev/null' || sec.newFile;
  const isDelete = newP === '/dev/null' || sec.delFile;
  return (tree) => {
    const paths = isCreate ? [newP] : isDelete ? [oldP] : oldP !== newP ? [oldP, newP] : [oldP];
    for (const p of paths) if (!safe(p)) throw new Fail('unsafe', p);
    if (isCreate) {
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let lastNoNl = false;
      for (const h of sec.hunks) {
        for (const it of h.items) {
          if (it.type === 'new') {
            plus.push(it.text);
            lastNoNl = !!it.noNl;
          }
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (lastNoNl ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (oldP !== newP && tree.get(newP) !== null) throw new Fail('exists', newP);
    const st = splitFile(before);
    let lines = st.lines;
    let final = st.final;
    let d = 0;
    for (const h of sec.hunks) {
      const { o, n } = bodyON(h.items);
      if (o.length === 0) {
        const idx = Math.min(Math.max(h.a + d, 0), lines.length);
        const ins = n.map((it) => it.text);
        const atEnd = idx === lines.length;
        lines = [...lines.slice(0, idx), ...ins, ...lines.slice(idx)];
        if (atEnd) final = !lastCtxOrNewNoNl(h.items);
        d += n.length;
        continue;
      }
      const found = findTier(lines, o, strict);
      if (!found) throw new Fail('no-match', oldP);
      const target = h.a - 1 + d;
      let pos = found.pos[0]!;
      let best = Math.abs(pos - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < best) {
          pos = p;
          best = dist;
        }
      }
      const repl = buildReplacement(lines, o, n, pos, found.tier);
      const toEnd = pos + o.length === lines.length;
      lines = [...lines.slice(0, pos), ...repl, ...lines.slice(pos + o.length)];
      if (toEnd) final = !lastCtxOrNewNoNl(h.items);
      d += n.length - o.length;
    }
    const out = joinFile({ br: st.br, lines, final });
    if (oldP !== newP) {
      tree.now.set(newP, out);
      tree.now.set(oldP, null);
      tree.moves.push([oldP, newP]);
    } else {
      tree.now.set(oldP, out);
    }
  };
}
/** All unified sections of a patch (section 6). */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const sec: Section = { gitOld: m[1]!, gitNew: m[2]!, pairOld: null, pairNew: null, lonePlus: null, renFrom: null, renTo: null, newFile: false, delFile: false, hunks: [] };
      i = parseUnifiedSection(lines, i + 1, sec);
      edits.push(makeUnifiedEdit(sec, strict));
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: Section = { gitOld: null, gitNew: null, pairOld: null, pairNew: null, lonePlus: null, renFrom: null, renTo: null, newFile: false, delFile: false, hunks: [] };
      i = parseUnifiedSection(lines, i, sec);
      edits.push(makeUnifiedEdit(sec, strict));
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i++;
    }
  }
  return edits;
}

/** One SEARCH/REPLACE block's edit (section 7). */
function makeSREdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const st = splitFile(before);
    const found = findTier(st.lines, oldLines, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const pos = found.pos[0]!;
    const nItems: NItem[] = newLines.map((t) => ({ text: t, ctx: false, oIndex: -1 }));
    const repl = buildReplacement(st.lines, oldLines, nItems, pos, found.tier);
    const lines = [...st.lines.slice(0, pos), ...repl, ...st.lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinFile({ br: st.br, lines, final: st.final }));
  };
}
/** All SEARCH/REPLACE blocks of a patch (section 7). */
function parseSR(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplaceEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchIdx + 1}`);
    }
    const nextSearch = lines.findIndex((l, k) => k > searchIdx && l.trimEnd() === '<<<<<<< SEARCH');
    const bound = nextSearch < 0 ? lines.length : nextSearch;
    let eq = -1;
    for (let j = searchIdx + 1; j < bound; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < bound; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(makeSREdit(path, lines.slice(searchIdx + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  return edits;
}

/** One V4A chunk: its anchor (null: none), its body items, whether `*** End of File` ended it. */
interface VChunk {
  anchor: string | null;
  items: BodyItem[];
  eof: boolean;
}
function makeV4AAdd(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}
function makeV4ADelete(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}
/** One V4A Update File section's edit (section 8). */
function makeV4AUpdate(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const st = splitFile(before);
    let lines = st.lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const a = findTierFrom(lines, [ch.anchor], cursor, strict);
        if (!a) throw new Fail('no-match', path);
        cursor = a.pos + 1;
      }
      const { o, n } = bodyON(ch.items);
      if (o.length === 0) {
        const idx = ch.eof ? lines.length : cursor;
        const ins = n.map((it) => it.text);
        lines = [...lines.slice(0, idx), ...ins, ...lines.slice(idx)];
        cursor = idx + ins.length;
        continue;
      }
      const found = findTierFrom(lines, o, cursor, strict, ch.eof);
      if (!found) throw new Fail('no-match', path);
      const repl = buildReplacement(lines, o, n, found.pos, found.tier);
      lines = [...lines.slice(0, found.pos), ...repl, ...lines.slice(found.pos + o.length)];
      cursor = found.pos + repl.length;
    }
    const out = joinFile({ br: st.br, lines, final: st.final });
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}
/** All V4A sections of a patch (section 8). */
function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (!isSectionStart(line)) throw new Exit2(`error: parse ${i + 1}`);
    const start = i;
    i++;
    const raw: string[] = [];
    while (i < last && !isSectionStart(lines[i]!)) {
      raw.push(lines[i]!);
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File:'.length).trim();
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const l = raw[k]!;
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${start + k + 2}`);
      }
      edits.push(makeV4AAdd(path, fileLines));
    } else if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File:'.length).trim();
      for (let k = 0; k < raw.length; k++) {
        if (!blank(raw[k]!)) throw new Exit2(`error: parse ${start + k + 2}`);
      }
      edits.push(makeV4ADelete(path));
    } else {
      const path = line.slice('*** Update File:'.length).trim();
      let k = 0;
      let moveTo: string | null = null;
      if (k < raw.length && raw[k]!.startsWith('*** Move to: ')) {
        moveTo = raw[k]!.slice('*** Move to:'.length).trim();
        k++;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const endChunk = (): void => {
        if (cur) {
          chunks.push(cur);
          cur = null;
        }
      };
      for (; k < raw.length; k++) {
        const l = raw[k]!;
        const ln = start + k + 2;
        if (l.startsWith('@@')) {
          endChunk();
          cur = { anchor: l.slice(2).trim(), items: [], eof: false };
          continue;
        }
        if (l === '*** End of File') {
          if (!cur) throw new Exit2(`error: parse ${ln}`);
          cur.eof = true;
          endChunk();
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (!cur) cur = { anchor: null, items: [], eof: false };
          if (l === '') cur.items.push({ type: 'ctx', text: '' });
          else if (l.startsWith(' ')) cur.items.push({ type: 'ctx', text: l.slice(1) });
          else if (l.startsWith('-')) cur.items.push({ type: 'old', text: l.slice(1) });
          else cur.items.push({ type: 'new', text: l.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${ln}`);
      }
      endChunk();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${start + 1}`);
      edits.push(makeV4AUpdate(path, moveTo, chunks, strict));
    }
  }
  return edits;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSR(lines, strict);
    else edits = parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changes: { key: string; line: string }[] = [];
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const wasOld = tree.original(oldP);
    const nowOld = tree.now.get(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.now.get(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      movedOld.add(oldP);
      movedNew.add(newP);
      changes.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (movedOld.has(p) || movedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changes.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  changes.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = changes.map((c) => c.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
