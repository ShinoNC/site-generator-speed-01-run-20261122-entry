// A faster drop-in for makefun-site 1.0.0.
//
// run(input) returns exactly what makefun-site's build returns for the same
// input — the whole output tree, byte for byte — while doing much less work
// than the reference. Nothing here changes observable behaviour; every
// shortcut below was checked against the reference on the practice set, on
// freshly drawn generator sets, and on hand-written edge cases.
//
// Where the time goes, and what this file does about it:
// - HTML escaping dominates the reference (it escapes character by character
//   inside the inline renderer), so escaping is one test plus one regex
//   replace, and plain runs are copied in bulk instead of per character.
// - The Markdown lexer never builds token objects: blocks render straight
//   into the output array.
// - Front matter finds its closing line with indexOf and slices the body out
//   instead of splitting the whole file and joining it back.
// - Slugs are memoized, and pure-ASCII strings skip Unicode normalisation.
// - Templates render through a scope chain, so the shared site/tags/recent
//   values are never copied per page; one scope object is reused across the
//   iterations of a for loop.

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ------------------------------------------------------------------ text

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_ALL = /[&<>"']/g;

// Escape HTML: untouched text comes back as-is, otherwise a single regex pass.
function escHtml(text) {
  return ESC_TEST.test(text) ? text.replace(ESC_ALL, (c) => ESC_MAP[c]) : text;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// "2026-11-09" -> "9 November 2026", parsed from the digits alone.
function longDate(date) {
  const y = date.slice(0, 4);
  const m = (date.charCodeAt(5) - 48) * 10 + (date.charCodeAt(6) - 48);
  const d = (date.charCodeAt(8) - 48) * 10 + (date.charCodeAt(9) - 48);
  return `${d} ${MONTH_NAMES[m - 1]} ${y}`;
}

const slugMemo = new Map();

// The slug rule: NFKD, combining marks stripped, capitals lowered, every run
// of other characters becomes one "-", none at either end, at most 64 chars,
// and an empty result reads "untitled".
function slugify(text) {
  const hit = slugMemo.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  let asciiOnly = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { asciiOnly = false; break; }
  }
  if (!asciiOnly) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let pendingGap = false;
  for (let i = 0; i < plain.length; i++) {
    const code = plain.charCodeAt(i);
    let keep = -1;
    if (code >= 65 && code <= 90) keep = code + 32;
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = code;
    if (keep === -1) {
      pendingGap = out.length > 0;
      continue;
    }
    if (pendingGap) out += '-';
    pendingGap = false;
    out += String.fromCharCode(keep);
  }
  if (out.length > 64) out = out.slice(0, 64);
  let end = out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  if (end !== out.length) out = out.slice(0, end);
  if (out === '') out = 'untitled';
  slugMemo.set(text, out);
  return out;
}

// A slug made unique inside `taken` (and recorded there): "-2", "-3", ...
function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  let n = 2;
  let out = `${slug}-2`;
  while (taken.has(out)) {
    n++;
    out = `${slug}-${n}`;
  }
  taken.add(out);
  return out;
}

// The words of a body: its runs of non-whitespace characters.
function countWords(text) {
  const m = text.match(/\S+/g);
  return m === null ? 0 : m.length;
}

// ------------------------------------------------------------ front matter

const KNOWN_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

function daysInMonth(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

// A quoted string's value: only \" and \\ escapes are allowed inside.
function parseQuoted(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

// Validate one key's raw value; { value } or { error } with the reference's
// exact refusal wording.
function parseValue(key, raw) {
  if (key === 'title' || key === 'summary') {
    const s = parseQuoted(raw);
    return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
  }
  if (key === 'date') {
    let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
    let y = 0;
    let mo = 0;
    let d = 0;
    if (ok) {
      for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) continue;
        const c = raw.charCodeAt(i);
        if (c < 48 || c > 57) { ok = false; break; }
      }
    }
    if (ok) {
      y = (raw.charCodeAt(0) - 48) * 1000 + (raw.charCodeAt(1) - 48) * 100 + (raw.charCodeAt(2) - 48) * 10 + (raw.charCodeAt(3) - 48);
      mo = (raw.charCodeAt(5) - 48) * 10 + (raw.charCodeAt(6) - 48);
      d = (raw.charCodeAt(8) - 48) * 10 + (raw.charCodeAt(9) - 48);
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) ok = false;
    }
    if (!ok) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    return { value: raw };
  }
  if (key === 'tags') {
    if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const tags = inner.split(',');
    for (let i = 0; i < tags.length; i++) {
      const t = tags[i].trim();
      if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      for (let j = 0; j < t.length; j++) {
        const c = t.charCodeAt(j);
        if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      tags[i] = t;
    }
    return { value: tags };
  }
  if (key === 'draft') {
    return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    let ok = raw.length > 0;
    for (let i = 0; ok && i < raw.length; i++) {
      const c = raw.charCodeAt(i);
      ok = (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45;
    }
    return ok ? { value: raw } : { error: 'key "layout": not a template name' };
  }
  // slug: [a-z0-9]+(-[a-z0-9]+)*, at most 64 characters.
  let ok = raw.length > 0 && raw.length <= 64;
  let prevDash = true;
  for (let i = 0; ok && i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 45) {
      if (prevDash) ok = false;
      prevDash = true;
    } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
    else ok = false;
  }
  if (prevDash) ok = false;
  return ok ? { value: raw } : { error: 'key "slug": not a slug' };
}

// One line as "key: value" (the reference's LINE rule, checked by hand).
// Returns null when the line is not a pair.
function splitPair(line) {
  const colon = line.indexOf(':');
  if (colon <= 0) return null;
  for (let i = 0; i < colon; i++) {
    const c = line.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || c === 95)) return null;
  }
  const key = line.slice(0, colon);
  const rest = line.slice(colon + 1);
  if (rest === '') return { key, raw: '' };
  if (rest.charCodeAt(0) !== 32) return null;
  let raw = rest.slice(1);
  let end = raw.length;
  while (end > 0) {
    const c = raw.charCodeAt(end - 1);
    if (c !== 32 && c !== 9) break;
    end--;
  }
  if (end !== raw.length) raw = raw.slice(0, end);
  return { key, raw };
}

// A source's front matter and body: { data, body }, or { error }.
function parseFrontMatter(text) {
  // The first line must be exactly '---'.
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  // The closing line: the first '\n---\n', or a trailing '\n---'.
  let closeAt = text.indexOf('\n---\n', 3);
  let bodyStart;
  if (closeAt !== -1) {
    bodyStart = closeAt + 5;
  } else if (text.endsWith('\n---') && text.length > 4) {
    closeAt = text.length - 4;
    bodyStart = text.length;
  } else {
    return { error: 'the front matter is not closed' };
  }
  const fmText = text.slice(4, closeAt);
  const fmLines = fmText === '' ? [] : fmText.split('\n');
  const data = {};
  for (let j = 0; j < fmLines.length; j++) {
    const line = fmLines[j];
    let blank = true;
    for (let k = 0; k < line.length; k++) {
      const c = line.charCodeAt(k);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (blank || line.charCodeAt(0) === 35) continue;
    const kv = splitPair(line);
    if (kv === null) return { error: `line ${j + 2} is not "key: value"` };
    if (!KNOWN_KEYS.has(kv.key)) return { error: `unknown key "${kv.key}"` };
    if (Object.hasOwn(data, kv.key)) return { error: `key "${kv.key}" is given twice` };
    if (kv.raw === '') return { error: `key "${kv.key}" has no value` };
    const v = parseValue(kv.key, kv.raw);
    if ('error' in v) return v;
    data[kv.key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// --------------------------------------------------------------- markdown

// Characters a backslash may escape in inline text.
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

// A line holding only spaces and tabs.
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// A line with its leading and trailing spaces/tabs dropped.
function trimEnds(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return line.slice(a, b);
}

// A fence opener: ``` plus an optional language plus spaces/tabs only.
// Returns the language, or null when the line is not an opener.
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

// A fence closer: ``` plus spaces/tabs only.
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// A heading line's level and text, or null. The text starts after ALL of the
// spaces/tabs that follow the hashes.
function headingOf(line) {
  let hashes = 0;
  while (hashes < line.length && line.charCodeAt(hashes) === 35) hashes++;
  if (hashes === 0 || hashes > 6) return null;
  let start = hashes;
  while (start < line.length) {
    const c = line.charCodeAt(start);
    if (c !== 32 && c !== 9) break;
    start++;
  }
  if (start === hashes) return null;
  let end = line.length;
  while (end > start) {
    const c = line.charCodeAt(end - 1);
    if (c !== 32 && c !== 9) break;
    end--;
  }
  const text = line.slice(start, end);
  return text === '' ? null : { depth: hashes, text };
}

// A thematic break: --- or *** plus spaces/tabs only.
function isHr(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Whether a line ends a paragraph: blank, fence, heading or break.
function endsParagraph(line) {
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

// The first index at or after `from` where `s` holds `what` outside an
// escape, or -1.
function findUnescaped(s, what, from) {
  const wlen = what.length;
  for (let j = from; j <= s.length - wlen; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

// The first single * at or after `from` (one not followed by another *),
// outside an escape, or -1.
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

// Inline-special characters: backslash, backtick, star, open bracket.
const SPECIAL_RE = /[\\`*[]/g;
const SPECIAL_TEST = /[\\`*[]/;

// Render `s` inline into `out`; `linkFn(target)` turns a link target into
// its href. Plain runs between specials are copied and escaped in bulk.
function renderInline(s, linkFn, out) {
  let i = 0;
  const n = s.length;
  SPECIAL_RE.lastIndex = 0;
  while (i < n) {
    SPECIAL_RE.lastIndex = i;
    const m = SPECIAL_RE.exec(s);
    const next = m === null ? n : m.index;
    if (next > i) {
      out.push(escHtml(s.slice(i, next)));
      i = next;
      if (i >= n) break;
    }
    const c = s[i];
    if (c === '\\' && i + 1 < n && ESCAPABLE.has(s[i + 1])) {
      out.push(escHtml(s[i + 1]));
      i += 2;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out.push('<code>', escHtml(s.slice(i + 1, j)), '</code>');
        i = j + 1;
      } else {
        out.push('`');
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          out.push('<strong>');
          const save = SPECIAL_RE.lastIndex;
          renderInline(s.slice(i + 2, j), linkFn, out);
          SPECIAL_RE.lastIndex = save;
          out.push('</strong>');
          i = j + 2;
        } else {
          out.push('**');
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        out.push('<em>');
        const save = SPECIAL_RE.lastIndex;
        renderInline(s.slice(i + 1, j), linkFn, out);
        SPECIAL_RE.lastIndex = save;
        out.push('</em>');
        i = j + 1;
      } else {
        out.push('*');
        i++;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const m2 = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m2 === -1 ? '' : s.slice(k + 2, m2);
      if (target !== '' && !/\s/.test(target)) {
        out.push('<a href="', escHtml(linkFn(target)), '">');
        const save = SPECIAL_RE.lastIndex;
        renderInline(s.slice(i + 1, k), linkFn, out);
        SPECIAL_RE.lastIndex = save;
        out.push('</a>');
        i = m2 + 1;
        continue;
      }
      out.push('[');
      i++;
      continue;
    }
    // A lone backslash before a character it cannot escape: itself, escaped.
    out.push(escHtml(c));
    i++;
  }
}

// Render one inline string to HTML. Text with no inline-special character
// needs only escaping.
function inlineStr(s, linkFn) {
  if (!SPECIAL_TEST.test(s)) return escHtml(s);
  const parts = [];
  renderInline(s, linkFn, parts);
  return parts.join('');
}

// `src` rendered: its HTML, its table of contents (level 2/3 headings) and
// its excerpt (the first paragraph's inline HTML, or ""). Blocks render
// straight into the output array instead of being lexed into token objects.
function renderMarkdown(src, linkFn) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < lines.length && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${escHtml(lang)}"`;
      let code = '';
      for (const l of body) code += `${escHtml(l)}\n`;
      blocks.push(`<pre><code${cls}>${code}</code></pre>`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inlineStr(heading.text, linkFn);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++];
        l = l.slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        const t = trimEnds(l);
        if (t !== '') body.push(t);
      }
      blocks.push(body.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inlineStr(body.join('\n'), linkFn)}</p>\n</blockquote>`);
      continue;
    }
    // A list: "- " / "* " items, or "1. " items (at most 8 digits).
    let bullet = false;
    let ordered = false;
    let startNum = 1;
    let firstItem = null;
    const c0 = line.charCodeAt(0);
    if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) {
      bullet = true;
      firstItem = line.slice(2);
    } else if (c0 >= 48 && c0 <= 57) {
      let j = 1;
      while (j < line.length && j < 9 && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
      if (line.charCodeAt(j) === 46 && line.charCodeAt(j + 1) === 32) {
        ordered = true;
        startNum = Number(line.slice(0, j));
        firstItem = line.slice(j + 2);
      }
    }
    if (bullet || ordered) {
      const items = [[trimEnds(firstItem)]];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        let m = null;
        let isItem = false;
        if (ordered) {
          const d0 = l.charCodeAt(0);
          if (d0 >= 48 && d0 <= 57) {
            let j = 1;
            while (j < l.length && j < 9 && l.charCodeAt(j) >= 48 && l.charCodeAt(j) <= 57) j++;
            if (l.charCodeAt(j) === 46 && l.charCodeAt(j + 1) === 32) {
              m = l.slice(j + 2);
              isItem = true;
            }
          }
        } else if ((l.charCodeAt(0) === 45 || l.charCodeAt(0) === 42) && l.charCodeAt(1) === 32) {
          m = l.slice(2);
          isItem = true;
        }
        if (isItem) {
          items.push([trimEnds(m)]);
          i++;
        } else if (l.charCodeAt(0) === 32 && l.charCodeAt(1) === 32 && trimEnds(l) !== '') {
          items[items.length - 1].push(trimEnds(l));
          i++;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && startNum !== 1 ? `<ol start="${startNum}">` : `<${tag}>`;
      let lis = '';
      for (const parts of items) lis += `<li>${inlineStr(parts.join('\n'), linkFn)}</li>\n`;
      blocks.push(`${open}\n${lis}</${tag}>`);
      continue;
    }
    // A paragraph: lines until one that ends it.
    const body = [trimEnds(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimEnds(lines[i++]));
    const html = inlineStr(body.join('\n'), linkFn);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.map((b) => `${b}\n`).join(''), toc, excerpt: excerpt ?? '' };
}

// --------------------------------------------------------------- templates

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

// A dotted path, validated; throws TemplateError with the reference's wording.
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

// Split a template source into tokens. A {% %} tag alone on its line swallows
// that line (its leading spaces and the newline after it).
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    let standalone = true;
    for (let j = lineStart; j < open; j++) {
      const c = src.charCodeAt(j);
      if (c !== 32 && c !== 9) { standalone = false; break; }
    }
    if (standalone) {
      for (let j = end; j < lineEnd; j++) {
        const c = src.charCodeAt(j);
        if (c !== 32 && c !== 9) { standalone = false; break; }
      }
    }
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

// Parse a template source into a node tree; throws TemplateError on bad tags.
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// Look a dotted path up through the scope chain; undefined when missing.
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

// A value as template text: strings and numbers as-is, booleans as words,
// arrays joined with ", ", everything else empty.
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

// A value's truth in {% if %}: empty arrays are false, as are undefined,
// null, false, "" and 0.
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// Render nodes into `out`. Includes stop at depth 8; a for loop reuses one
// scope object across its iterations (rendering is synchronous, so no
// earlier iteration can still be reading it).
function renderNodes(nodes, scope, templates, depth, out) {
  for (const n of nodes) {
    if (n.kind === 'text') {
      out.push(n.text);
    } else if (n.kind === 'var') {
      out.push(escHtml(textOf(lookup(scope, n.path))));
    } else if (n.kind === 'raw') {
      out.push(textOf(lookup(scope, n.path)));
    } else if (n.kind === 'if') {
      const v = truthy(lookup(scope, n.path));
      const branch = v !== n.not ? n.then : n.else;
      if (branch !== null) renderNodes(branch, scope, templates, depth, out);
    } else if (n.kind === 'for') {
      const xs = lookup(scope, n.path);
      if (!Array.isArray(xs)) continue;
      const loop = { index: 0, first: false, last: false, length: xs.length };
      const vars = { [n.name]: null, loop };
      const child = { vars, parent: scope };
      for (let k = 0; k < xs.length; k++) {
        vars[n.name] = xs[k];
        vars.loop = loop; // the loop record wins when the element is also named "loop"
        loop.index = k + 1;
        loop.first = k === 0;
        loop.last = k === xs.length - 1;
        renderNodes(n.body, child, templates, depth, out);
      }
    } else {
      const t = templates.get(n.name);
      if (t !== undefined && depth < 8) renderNodes(t, scope, templates, depth + 1, out);
    }
  }
}

// ------------------------------------------------------------------- build

// Directories the generator owns at the site root.
const RESERVED = ['posts', 'tags', 'page'];

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

// Resolve a relative link target against a source's directory; null when it
// would climb above the root.
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let s = 0; s < segs.length; s++) {
    const seg = segs[s];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

// A neighbour post as a template link, or null.
function linkOf(s) {
  if (s === null) return null;
  return { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
}

// A post as a template card.
function cardOf(s, words) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

export function run(input) {
  // Templates, parsed in code-unit order of name; one that does not parse is
  // reported and left out.
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(cmpStr);
  for (const name of names) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');

  // Sources, sorted by path: .md is a source (line ends made \n), else static.
  const files = [...input.files].sort((x, y) => cmpStr(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }

  // Front matter and the drop checks, in order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: slugs unique within each directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, with links resolved against pages and static files.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const linkFn = (target) => {
      if (SCHEME_RE.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null) {
        const page = bySource.get(path);
        if (page !== undefined) return `${page.url}${frag}`;
        if (staticPaths.has(path)) return `${base}/${path}${frag}`;
      }
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, linkFn);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = countWords(s.body);
  }

  // Collections: posts newest first, then by slug; newer/older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => cmpStr(y.data.date, x.data.date) || cmpStr(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // Tags, grouped by slug and named as first met in collection order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags ?? [];
    for (const name of tags) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmpStr(x.slug, y.slug));

  // Layouts.
  const output = {};
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p, p.words));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const shared = { vars: { site, tags: allTags, recent }, parent: null };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars, parent: shared }, templates, 0, out);
    return out.join('');
  };
  for (const s of kept) {
    const card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page: card });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every refusal, draft and broken link, sorted, then the
  // summary line.
  const lines = [...report, ...broken].sort(cmpStr);
  let pageCount = 0;
  for (const s of kept) if (!s.post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
