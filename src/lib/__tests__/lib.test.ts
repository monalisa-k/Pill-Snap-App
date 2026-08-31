import { base64ToBytes } from '../base64';
import { formatWhen } from '../history';

describe('base64ToBytes', () => {
  const encode = (bytes: number[]): string => Buffer.from(bytes).toString('base64');

  it('round-trips bytes at every padding length', () => {
    for (const source of [[0], [0, 255], [1, 2, 3], [1, 2, 3, 4], [72, 101, 108, 108, 111]]) {
      expect(Array.from(base64ToBytes(encode(source)))).toEqual(source);
    }
  });

  it('round-trips a large random buffer', () => {
    const source = Array.from({ length: 5000 }, (_, i) => (i * 97) % 256);
    expect(Array.from(base64ToBytes(encode(source)))).toEqual(source);
  });

  it('handles an empty string', () => {
    expect(base64ToBytes('').length).toBe(0);
  });

  it('ignores whitespace and newlines', () => {
    const clean = encode([10, 20, 30, 40, 50, 60]);
    const wrapped = `${clean.slice(0, 4)}\n  ${clean.slice(4)}`;
    expect(Array.from(base64ToBytes(wrapped))).toEqual([10, 20, 30, 40, 50, 60]);
  });

  it('accepts a full data URI as well as bare base64', () => {
    const clean = encode([1, 2, 3, 4]);
    expect(Array.from(base64ToBytes(`data:image/jpeg;base64,${clean}`))).toEqual([1, 2, 3, 4]);
  });
});

describe('formatWhen', () => {
  const at = (y: number, m: number, d: number, h: number, min: number) =>
    new Date(y, m - 1, d, h, min).getTime();

  it('labels today, yesterday and older by calendar day', () => {
    const now = at(2026, 3, 15, 10, 0);
    expect(formatWhen(at(2026, 3, 15, 9, 30), now)).toMatch(/^Today at /);
    expect(formatWhen(at(2026, 3, 15, 0, 1), now)).toMatch(/^Today at /);
    expect(formatWhen(at(2026, 3, 14, 23, 59), now)).toMatch(/^Yesterday at /);
    expect(formatWhen(at(2026, 3, 14, 0, 0), now)).toMatch(/^Yesterday at /);
    expect(formatWhen(at(2026, 3, 13, 23, 59), now)).not.toMatch(/Today|Yesterday/);
  });

  it('crosses a month boundary correctly', () => {
    // Plain millisecond arithmetic gets this right by luck; calendar rollback
    // gets it right by construction.
    const now = at(2026, 4, 1, 8, 0);
    expect(formatWhen(at(2026, 3, 31, 22, 0), now)).toMatch(/^Yesterday at /);
    expect(formatWhen(at(2026, 3, 30, 22, 0), now)).not.toMatch(/Yesterday/);
  });
});
