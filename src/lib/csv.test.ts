import { describe, expect, it } from 'vitest';
import { toCsv } from './csv';

describe('toCsv', () => {
  it('escapes quotes, commas and newlines', () => {
    expect(toCsv(['a', 'b'], [['x,y', 'he said "hi"'], ['line\nbreak', null]])).toBe('a,b\r\n"x,y","he said ""hi"""\r\n"line\nbreak",');
  });
  it('neutralizes spreadsheet formulas', () => {
    expect(toCsv(['a'], [['=HYPERLINK("x")'], ['-5']])).toBe('a\r\n"\'=HYPERLINK(""x"")"\r\n\'-5');
  });
});
