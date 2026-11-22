// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// the V4A patch format, JSON tool calls), finds the lines each edit names
// even when their whitespace or indentation drifted, and changes every file
// or none. Node 22, standard library only. Run as:
//   node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// See SPEC.md for the whole contract. When MAKEFUN_ENV_URL is set, the
// trial runner takes over (last lines of this file); keep that hand-over
// and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** Thrown to end the run with exit 2 and one output line. */
class UsageOrParse {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** Thrown by one edit to report its failure; the edit changes nothing. */
class EditFailure {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function isSafePath(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines plus its line break and whether it ends with one. */
interface FileState {
  lines: string[];
  br: '\n' | '\r\n';
  finalBreak: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const finalBreak = text.endsWith(br);
  const parts = text.split(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function renderFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

/** Remove trailing spaces and tabs. */
const stripTrailing = (s: string): string => s.replace(/[ \t]+$/, '');
/** Remove leading and trailing spaces and tabs. */
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
/** The leading spaces and tabs of a line. */
const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function linesEqual(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailing(a) === stripTrailing(b);
  return stripBoth(a) === stripBoth(b);
}

/** All 0-based positions where `needle` occurs in `hay` at `tier`. */
function findOccurrences(needle: string[], hay: string[], tier: number): number[] {
  const out: number[] = [];
  const k = needle.length;
  if (k === 0) return out;
  for (let i = 0; i + k <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (!linesEqual(needle[j], hay[i + j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/**
 * The first tier at which `needle` occurs in `hay` (only positions >= `from`
 * count), with its occurrences. Null when it occurs at no tier.
 */
function findAtTier(
  needle: string[],
  hay: string[],
  from: number,
  strict: boolean,
): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occ = findOccurrences(needle, hay, tier).filter((p) => p >= from);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/**
 * Re-indent one new line at tier 2: replace the leading whitespace P of the
 * old block's first line with F, the leading whitespace of the file's first
 * matched line. Lines that are empty, only whitespace, or do not start with
 * P are written as they are. At tiers 0 and 1 lines are written as they are.
 */
function reindent(line: string, tier: number, f: string, p: string): string {
  if (tier !== 2) return line;
  if (line === '' || /^[ \t]*$/.test(line)) return line;
  if (!line.startsWith(p)) return line;
  return f + line.slice(p.length);
}

/** One output line of a hunk or chunk: a context line, or an added line. */
interface NewLine {
  text: string;
  /** True for a context line (written as the file's own matched line). */
  context: boolean;
  /** For a context line, its index inside O. */
  oIndex: number;
}

/** What a hunk or chunk body says: the old lines, the new lines, and whether a `\` line follows its last context or `+` line. */
interface BodyParts {
  oldLines: string[];
  newLines: NewLine[];
  backslashAfterLastOutput: boolean;
}

/** Split a hunk or chunk body into its old and new lines. */
function splitBody(body: string[]): BodyParts {
  const oldLines: string[] = [];
  const newLines: NewLine[] = [];
  let lastOutput = -1;
  body.forEach((line, bi) => {
    if (line.startsWith(' ')) {
      const t = line.slice(1);
      oldLines.push(t);
      newLines.push({ text: t, context: true, oIndex: oldLines.length - 1 });
      lastOutput = bi;
    } else if (line.startsWith('-')) {
      oldLines.push(line.slice(1));
    } else if (line.startsWith('+')) {
      newLines.push({ text: line.slice(1), context: false, oIndex: -1 });
      lastOutput = bi;
    } else if (line === '') {
      oldLines.push('');
      newLines.push({ text: '', context: true, oIndex: oldLines.length - 1 });
      lastOutput = bi;
    }
    // A `\` line contributes no line of its own.
  });
  const backslashAfterLastOutput =
    lastOutput >= 0 && lastOutput + 1 < body.length && body[lastOutput + 1]!.startsWith('\\');
  return { oldLines, newLines, backslashAfterLastOutput };
}

/**
 * Replace the `oldLines.length` lines at `pos` with the new lines: context
 * lines come from the file, added lines are re-indented at tier 2.
 */
function spliceReplacement(
  fileLines: string[],
  pos: number,
  oldLines: string[],
  newLines: NewLine[],
  tier: number,
): string[] {
  const f = leadingWs(fileLines[pos] ?? '');
  const p = leadingWs(oldLines[0] ?? '');
  const repl = newLines.map((item) =>
    item.context ? fileLines[pos + item.oIndex]! : reindent(item.text, tier, f, p),
  );
  return [...fileLines.slice(0, pos), ...repl, ...fileLines.slice(pos + oldLines.length)];
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
}

/** One edit: applies itself to the tree or throws EditFailure, changing nothing. `moves` collects the successful moves, for the output. */
type Edit = (tree: Tree, moves: Array<[string, string]>) => void;

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9)                                      */
/* ------------------------------------------------------------------ */

/** One JSON edit object, or null when the value is not one. */
function jsonEditObject(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!isSafePath(p)) throw new EditFailure('unsafe', p);
      if (tree.get(p) !== null) throw new EditFailure('exists', p);
      tree.now.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!isSafePath(p)) throw new EditFailure('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFailure('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFailure('no-match', p);
      if (count > 1) throw new EditFailure('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      if (!isSafePath(p)) throw new EditFailure('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFailure('missing', p);
      const state = parseFile(before);
      if (line < 0 || line > state.lines.length) throw new EditFailure('no-match', p);
      state.lines.splice(line, 0, ...add);
      tree.now.set(p, renderFile(state));
    };
  }
  return null;
}

function parseJsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new UsageOrParse('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new UsageOrParse(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new UsageOrParse(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEditObject(x);
      if (e === null) throw new UsageOrParse(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEditObject(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new UsageOrParse(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface UnifiedHunk {
  /** Old start line, 1-based (A in `@@ -A[,B] +C[,D] @@`). */
  a: number;
  body: string[];
}

interface UnifiedSection {
  /** Null means /dev/null: no file. */
  oldPath: string | null;
  newPath: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: UnifiedHunk[];
}

/** The path of a `--- ` or `+++ ` line: text after the four characters, up to the first tab, spaces removed, a leading a/ or b/ removed. Null for /dev/null. */
function unifiedHeaderPath(line: string): string | null {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  if (p === '/dev/null') return null;
  return p;
}

/** Parse a `diff --git a/<X> b/<Y>` line, or null when it is not of that form. */
function parseDiffGit(line: string): { x: string; y: string } | null {
  if (!line.startsWith('diff --git ')) return null;
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const at = rest.lastIndexOf(' b/');
  if (at < 0) return null;
  const x = rest.slice(2, at);
  const y = rest.slice(at + 3);
  if (x === '' || y === '') return null;
  return { x, y };
}

/**
 * A section's header: the lines before its first hunk. Returns the index of
 * the first line after the header. `pairSeen` says a `---`/`+++` pair already
 * named the paths, so `rename from`/`rename to` lines do not.
 */
function parseUnifiedHeader(lines: string[], i: number, sec: UnifiedSection, pairSeen: boolean): number {
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('@@')) break;
    if (line.startsWith('diff --git')) break;
    if (line.startsWith('--- ')) {
      if (i + 1 >= n || !lines[i + 1]!.startsWith('+++ ')) {
        throw new UsageOrParse(`error: parse ${i + 2}`);
      }
      sec.oldPath = unifiedHeaderPath(line);
      sec.newPath = unifiedHeaderPath(lines[i + 1]!);
      pairSeen = true;
      i += 2;
      continue;
    }
    if (line.startsWith('rename from ')) {
      if (!pairSeen) sec.oldPath = line.slice('rename from '.length).trim();
      i += 1;
      continue;
    }
    if (line.startsWith('rename to ')) {
      if (!pairSeen) sec.newPath = line.slice('rename to '.length).trim();
      i += 1;
      continue;
    }
    if (line.startsWith('new file mode')) {
      sec.creation = true;
      i += 1;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      sec.deletion = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return i;
}

/** The hunks starting at `i`: consecutive `@@` headers with their bodies. Returns the index of the first line after them. */
function parseUnifiedHunks(lines: string[], i: number, sec: UnifiedSection): number {
  const n = lines.length;
  while (i < n && lines[i]!.startsWith('@@')) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: |$)/.exec(lines[i]!);
    if (m === null) throw new UsageOrParse(`error: parse ${i + 1}`);
    const a = Number.parseInt(m[1]!, 10);
    i += 1;
    const body: string[] = [];
    while (i < n) {
      const l = lines[i]!;
      // A `--- ` line followed by a `+++ ` line ends the body: it starts a
      // new section, even though it begins with `-`.
      if (l.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ ')) break;
      if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
        body.push(l);
        i += 1;
      } else break;
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    sec.hunks.push({ a, body });
  }
  return i;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let current: UnifiedSection | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git')) {
      const dg = parseDiffGit(line);
      if (dg === null) throw new UsageOrParse(`error: parse ${i + 1}`);
      const sec: UnifiedSection = { oldPath: dg.x, newPath: dg.y, creation: false, deletion: false, hunks: [] };
      sections.push(sec);
      current = sec;
      i += 1;
      i = parseUnifiedHeader(lines, i, sec, false);
      i = parseUnifiedHunks(lines, i, sec);
    } else if (line.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ ')) {
      const sec: UnifiedSection = {
        oldPath: unifiedHeaderPath(line),
        newPath: unifiedHeaderPath(lines[i + 1]!),
        creation: false,
        deletion: false,
        hunks: [],
      };
      sections.push(sec);
      current = sec;
      i += 2;
      i = parseUnifiedHeader(lines, i, sec, true);
      i = parseUnifiedHunks(lines, i, sec);
    } else if (line.startsWith('@@')) {
      if (current === null) throw new UsageOrParse(`error: parse ${i + 1}`);
      i = parseUnifiedHunks(lines, i, current);
    } else {
      i += 1;
    }
  }
  return sections.map((sec) => makeUnifiedEdit(sec, strict));
}

/** Apply one unified section's hunks to a file's lines, in order. */
function applyUnifiedHunks(state: FileState, hunks: UnifiedHunk[], path: string, strict: boolean): void {
  let drift = 0;
  for (const hunk of hunks) {
    const { oldLines, newLines, backslashAfterLastOutput } = splitBody(hunk.body);
    if (oldLines.length === 0) {
      const idx = Math.max(0, Math.min(hunk.a + drift, state.lines.length));
      const atEnd = idx === state.lines.length;
      const repl = newLines.map((item) => item.text);
      state.lines = [...state.lines.slice(0, idx), ...repl, ...state.lines.slice(idx)];
      if (atEnd) state.finalBreak = !backslashAfterLastOutput;
      drift += newLines.length;
      continue;
    }
    const found = findAtTier(oldLines, state.lines, 0, strict);
    if (found === null) throw new EditFailure('no-match', path);
    const target = hunk.a - 1 + drift;
    let pos = found.occ[0]!;
    let best = Math.abs(pos - target);
    for (const p of found.occ) {
      const d = Math.abs(p - target);
      if (d < best) {
        best = d;
        pos = p;
      }
    }
    const touchesEnd = pos + oldLines.length === state.lines.length;
    state.lines = spliceReplacement(state.lines, pos, oldLines, newLines, found.tier);
    if (touchesEnd) state.finalBreak = !backslashAfterLastOutput;
    drift += newLines.length - oldLines.length;
  }
}

function makeUnifiedEdit(sec: UnifiedSection, strict: boolean): Edit {
  return (tree, moves) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    const isCreation = oldP === null || sec.creation;
    const isDeletion = !isCreation && (newP === null || sec.deletion);
    const isMove = !isCreation && !isDeletion && oldP !== null && newP !== null && oldP !== newP;
    const paths: string[] = [];
    if (oldP !== null) paths.push(oldP);
    if (newP !== null && newP !== oldP) paths.push(newP);
    for (const p of paths) {
      if (!isSafePath(p)) throw new EditFailure('unsafe', p);
    }
    if (isCreation) {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new EditFailure('exists', newP);
      const plus: string[] = [];
      let lastPlusBackslash = false;
      for (const hunk of sec.hunks) {
        let lastPlus = -1;
        hunk.body.forEach((line, bi) => {
          if (line.startsWith('+')) {
            plus.push(line.slice(1));
            lastPlus = bi;
          }
        });
        if (lastPlus >= 0) {
          lastPlusBackslash =
            lastPlus + 1 < hunk.body.length && hunk.body[lastPlus + 1]!.startsWith('\\');
        }
      }
      const state: FileState = {
        lines: plus,
        br: '\n',
        finalBreak: plus.length > 0 && !lastPlusBackslash,
      };
      tree.now.set(newP, renderFile(state));
      return;
    }
    if (isDeletion) {
      if (oldP === null) return;
      if (tree.get(oldP) === null) throw new EditFailure('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (isMove) {
      const from = oldP!;
      const to = newP!;
      if (tree.get(from) === null) throw new EditFailure('missing', from);
      if (tree.get(to) !== null) throw new EditFailure('exists', to);
      const state = parseFile(tree.get(from)!);
      applyUnifiedHunks(state, sec.hunks, from, strict);
      tree.now.set(from, null);
      tree.now.set(to, renderFile(state));
      moves.push([from, to]);
      return;
    }
    const p = oldP!;
    if (tree.get(p) === null) throw new EditFailure('missing', p);
    const state = parseFile(tree.get(p)!);
    applyUnifiedHunks(state, sec.hunks, p, strict);
    tree.now.set(p, renderFile(state));
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

/** Parse SEARCH/REPLACE blocks into edits. */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new UsageOrParse(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let eq = -1;
    let k = searchLine + 1;
    for (; k < n; k++) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        eq = k;
        break;
      }
      if (t === '>>>>>>> REPLACE') throw new UsageOrParse(`error: parse ${searchLine + 1}`);
    }
    if (eq === -1) throw new UsageOrParse(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (k = eq + 1; k < n; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep === -1) throw new UsageOrParse(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(makeSearchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/** A SEARCH/REPLACE edit that honours --strict (tier 0 only). */
function makeSearchReplaceEdit(
  path: string,
  oldLines: string[],
  newLines: string[],
  strict: boolean,
): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFailure('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new EditFailure('exists', path);
      const state: FileState = { lines: [...newLines], br: '\n', finalBreak: newLines.length > 0 };
      tree.now.set(path, renderFile(state));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new EditFailure('missing', path);
    const state = parseFile(before);
    const found = findAtTier(oldLines, state.lines, 0, strict);
    if (found === null) throw new EditFailure('no-match', path);
    if (found.occ.length > 1) throw new EditFailure('ambiguous', path);
    const pos = found.occ[0]!;
    const items: NewLine[] = newLines.map((text) => ({ text, context: false, oIndex: -1 }));
    state.lines = spliceReplacement(state.lines, pos, oldLines, items, found.tier);
    tree.now.set(path, renderFile(state));
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  /** Null means no anchor. */
  anchor: string | null;
  body: string[];
  /** True when a `*** End of File` line ended this chunk. */
  eof: boolean;
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  /** Update only: null means no move. */
  moveTo: string | null;
  /** Add only. */
  addLines: string[];
  /** Update only. */
  chunks: V4aChunk[];
}

const V4A_SECTION_START = (l: string): boolean =>
  l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');

function makeV4aEdit(sec: V4aSection, strict: boolean): Edit {
  return (tree, moves) => {
    if (!isSafePath(sec.path)) throw new EditFailure('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new EditFailure('exists', sec.path);
      const state: FileState = { lines: [...sec.addLines], br: '\n', finalBreak: sec.addLines.length > 0 };
      tree.now.set(sec.path, renderFile(state));
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new EditFailure('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (sec.moveTo !== null && !isSafePath(sec.moveTo)) throw new EditFailure('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new EditFailure('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new EditFailure('exists', sec.moveTo);
    const state = parseFile(before);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        const found = findAtTier([chunk.anchor], state.lines, cursor, strict);
        if (found === null) throw new EditFailure('no-match', sec.path);
        cursor = found.occ[0]! + 1;
      }
      const { oldLines, newLines } = splitBody(chunk.body);
      if (oldLines.length === 0) {
        const idx = chunk.eof ? state.lines.length : cursor;
        const repl = newLines.map((item) => item.text);
        state.lines = [...state.lines.slice(0, idx), ...repl, ...state.lines.slice(idx)];
        cursor = idx + repl.length;
        continue;
      }
      const found = findAtTier(oldLines, state.lines, cursor, strict);
      if (found === null) throw new EditFailure('no-match', sec.path);
      let pos: number;
      if (chunk.eof) {
        const ends = found.occ.filter((p) => p + oldLines.length === state.lines.length);
        if (ends.length === 0) throw new EditFailure('no-match', sec.path);
        pos = ends[0]!;
      } else {
        pos = found.occ[0]!;
      }
      state.lines = spliceReplacement(state.lines, pos, oldLines, newLines, found.tier);
      cursor = pos + newLines.length;
    }
    const out = renderFile(state);
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, out);
      moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, out);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  let first = -1;
  for (let i = 0; i < n; i++) {
    if (!isBlank(lines[i]!)) {
      first = i;
      break;
    }
  }
  if (first < 0) throw new UsageOrParse('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new UsageOrParse(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (!isBlank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new UsageOrParse(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File:')) {
      const path = line.slice('*** Add File:'.length).trim();
      i += 1;
      // Keep the raw lines: a `+` line is never a blank line, so a trailing
      // `+` line (an empty line of the file) survives the strip below while
      // a trailing truly empty line does not.
      const raw: string[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (V4A_SECTION_START(l)) break;
        if (l === '') {
          raw.push('');
          i += 1;
          continue;
        }
        if (l.startsWith('+')) {
          raw.push(l);
          i += 1;
          continue;
        }
        throw new UsageOrParse(`error: parse ${i + 1}`);
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      const addLines = raw.map((l) => (l === '' ? '' : l.slice(1)));
      edits.push(makeV4aEdit({ kind: 'add', path, moveTo: null, addLines, chunks: [] }, strict));
      continue;
    }
    if (line.startsWith('*** Delete File:')) {
      const path = line.slice('*** Delete File:'.length).trim();
      i += 1;
      edits.push(makeV4aEdit({ kind: 'delete', path, moveTo: null, addLines: [], chunks: [] }, strict));
      continue;
    }
    if (line.startsWith('*** Update File:')) {
      const path = line.slice('*** Update File:'.length).trim();
      const updateLine = i + 1;
      i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to:')) {
        moveTo = lines[i]!.slice('*** Move to:'.length).trim();
        i += 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let firstChunk = true;
      const closeChunk = (stripTrailing: boolean): void => {
        if (cur === null) return;
        if (stripTrailing) {
          while (cur.body.length > 0 && cur.body[cur.body.length - 1]!.trim() === '') cur.body.pop();
        }
        chunks.push(cur);
        cur = null;
      };
      while (i < last) {
        const l = lines[i]!;
        if (V4A_SECTION_START(l)) break;
        if (l.startsWith('@@')) {
          closeChunk(false);
          const anchorText = l.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, body: [], eof: false };
          firstChunk = false;
          i += 1;
          continue;
        }
        if (l === '*** End of File') {
          if (cur === null) throw new UsageOrParse(`error: parse ${i + 1}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          i += 1;
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          // A whitespace-only line between chunks is a blank line, ignored;
          // inside a chunk it is a context line (its text keeps the spaces).
          if (cur === null && isBlank(l)) {
            i += 1;
            continue;
          }
          if (cur === null) {
            if (firstChunk && chunks.length === 0) {
              cur = { anchor: null, body: [], eof: false };
              firstChunk = false;
            } else {
              throw new UsageOrParse(`error: parse ${i + 1}`);
            }
          }
          cur.body.push(l);
          i += 1;
          continue;
        }
        if (l === '') {
          if (cur !== null) cur.body.push('');
          i += 1;
          continue;
        }
        throw new UsageOrParse(`error: parse ${i + 1}`);
      }
      closeChunk(true);
      if (chunks.length === 0 && moveTo === null) {
        throw new UsageOrParse(`error: parse ${updateLine}`);
      }
      edits.push(makeV4aEdit({ kind: 'update', path, moveTo, addLines: [], chunks }, strict));
      continue;
    }
    throw new UsageOrParse(`error: parse ${i + 1}`);
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Command line, output, exit codes (SPEC.md sections 1, 2 and 10)     */
/* ------------------------------------------------------------------ */

interface Args {
  format: string;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

function parseArgs(args: string[]): Args {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (format !== null) throw new UsageOrParse('error: usage');
        const v = a.slice('--format='.length);
        if (!FORMATS.includes(v)) throw new UsageOrParse('error: usage');
        format = v;
      } else if (a === '--check') {
        if (check) throw new UsageOrParse('error: usage');
        check = true;
      } else if (a === '--strict') {
        if (strict) throw new UsageOrParse('error: usage');
        strict = true;
      } else {
        throw new UsageOrParse('error: usage');
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) throw new UsageOrParse('error: usage');
  return { format: format ?? 'auto', check, strict, patch: pos.length === 0 ? null : pos[0]! };
}

/** Compare two paths in UTF-8 byte order. */
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * The output rows for a successful run: one line per path whose state
 * changed, in byte order of the paths; a move that still holds in the final
 * tree is one `R <old> -> <new>` line sorting by <new>.
 */
function computeRows(tree: Tree, moves: Array<[string, string]>): string[] {
  const rows: Array<{ key: string; text: string }> = [];
  const consumed = new Set<string>();
  for (const [oldP, newP] of moves) {
    if (
      tree.original(oldP) !== null &&
      tree.get(oldP) === null &&
      tree.original(newP) === null &&
      tree.get(newP) !== null
    ) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      consumed.add(oldP);
      consumed.add(newP);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCompare(a.key, b.key));
  return rows.map((r) => r.text);
}

function run(args: string[]): { code: number; out: string[] } {
  let parsed: Args;
  try {
    parsed = parseArgs(args);
  } catch (e) {
    if (e instanceof UsageOrParse) return { code: 2, out: [e.line] };
    throw e;
  }
  const file = parsed.patch === null || parsed.patch === '-' ? null : parsed.patch;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = parsed.format === 'auto' ? detectFormat(lines) : parsed.format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, parsed.strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, parsed.strict);
    else edits = parseV4a(lines, parsed.strict);
    if (edits.length === 0) throw new UsageOrParse('error: parse 1');
  } catch (e) {
    if (e instanceof UsageOrParse) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const moves: Array<[string, string]> = [];
  const fails: EditFailure[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = moves.length;
    try {
      edit(tree, moves);
    } catch (e) {
      if (!(e instanceof EditFailure)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  const rows = computeRows(tree, moves);
  if (!parsed.check) {
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
