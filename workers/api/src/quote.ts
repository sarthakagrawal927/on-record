export type QuoteAnchor = { start: number; end: number };

export function normalizeWs(text: string): string {
  return text.trim().replace(/\s+/gu, ' ');
}

function buildNormMap(text: string): { norm: string; map: number[] } {
  const map: number[] = [];
  let norm = '';
  let i = 0;
  const length = text.length;
  while (i < length && /\s/u.test(text[i] ?? '')) {
    i += 1;
  }
  while (i < length) {
    const ch = text[i] ?? '';
    if (/\s/u.test(ch)) {
      while (i < length && /\s/u.test(text[i] ?? '')) {
        i += 1;
      }
      if (i < length) {
        map.push(i);
        norm += ' ';
      }
      continue;
    }
    map.push(i);
    norm += ch;
    i += 1;
  }
  return { map, norm };
}

export function findVerbatimAnchor(
  segment: string,
  quote: string,
  minChars = 40
): QuoteAnchor | null {
  const needle = normalizeWs(quote);
  if (needle.length < minChars) {
    return null;
  }
  const { norm, map } = buildNormMap(segment);
  const at = norm.indexOf(needle);
  if (at < 0) {
    return null;
  }
  const start = map[at];
  const last = map[at + needle.length - 1];
  if (start === undefined || last === undefined) {
    return null;
  }
  return { end: last + 1, start };
}

export function quoteIsValid(segment: string, quote: string): boolean {
  return findVerbatimAnchor(segment, quote) !== null;
}
