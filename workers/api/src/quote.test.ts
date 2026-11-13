import { describe, expect, it } from 'vitest';
import { findVerbatimAnchor, normalizeWs, quoteIsValid } from './quote';

const segment =
  'I think software development is shifting toward supervising coding agents, not writing every line.';

describe('normalizeWs', () => {
  it('trims and collapses every ECMAScript whitespace character', () => {
    const whitespace =
      '\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
    for (const character of whitespace) {
      expect(normalizeWs(`${character}Visual${character}${character}Studio${character}`)).toBe(
        'Visual Studio'
      );
    }
    expect(normalizeWs(whitespace)).toBe('');
    expect(normalizeWs('')).toBe('');
  });

  it('preserves non-whitespace characters and their Unicode representation', () => {
    const text = '名\u200b\u180e\u0000\ud800\udfff\u0301\u2060👋';
    expect(normalizeWs(` \t${text}\n `)).toBe(text);
  });

  it.each([null, undefined, 42, true, {}, [], Symbol('quote'), 1n])(
    'rejects non-string input %s',
    (value) => {
      expect(() => normalizeWs(value as unknown as string)).toThrow(TypeError);
    }
  );
});

describe('findVerbatimAnchor', () => {
  it('accepts a whitespace-normalized contiguous quote', () => {
    const quote = 'software   development is shifting toward supervising coding agents';
    const anchor = findVerbatimAnchor(segment, quote);
    expect(anchor).not.toBeNull();
    expect(segment.slice(anchor!.start, anchor!.end)).toContain('software development');
  });

  it('rejects paraphrases', () => {
    expect(
      quoteIsValid(segment, 'engineers will mostly babysit AI tools going forward forever')
    ).toBe(false);
  });

  it('rejects short quotes', () => {
    expect(findVerbatimAnchor(segment, 'I think software development')).toBeNull();
  });

  it('keeps exact segment offsets when the quote uses different Unicode whitespace', () => {
    const verbatim = 'a valid\u00a0and sufficiently\r\nlong quote appears here';
    const prefix = '\ufeffbefore\t';
    const source = `${prefix}${verbatim}\u3000after`;
    const anchor = findVerbatimAnchor(
      source,
      '\t a valid and sufficiently\u202flong quote appears here \n'
    );
    expect(anchor).toEqual({ end: prefix.length + verbatim.length, start: prefix.length });
    expect(source.slice(anchor!.start, anchor!.end)).toBe(verbatim);
  });

  it('does not treat a zero-width character as quote whitespace', () => {
    expect(
      findVerbatimAnchor(
        'a valid\u200band sufficiently long quote appears here',
        'a valid and sufficiently long quote appears here'
      )
    ).toBeNull();
  });
});
