import { describe, expect, it } from 'vitest';
import {
  parseTrackerDescription,
  buildTrackerDescription,
  routeLinkMarkdown,
} from './route-tracker.js';
import type { ExtractedRoute } from '../../comma.js';

const SAMPLE_LINE = '\uD83C\uDF0E \uD83D\uDCDC [Route](https://connect.comma.ai/abc/00000001--1234567890) \u2014 `abc/00000001--1234567890` \u2014 ||`https://connect.comma.ai/abc/00000001--1234567890`||';

describe('parseTrackerDescription', () => {
  it('returns empty for null/undefined/empty', () => {
    expect(parseTrackerDescription(null)).toEqual({ primaryLine: null, additionalLines: [] });
    expect(parseTrackerDescription(undefined)).toEqual({ primaryLine: null, additionalLines: [] });
    expect(parseTrackerDescription('')).toEqual({ primaryLine: null, additionalLines: [] });
  });

  it('parses a primary-only description', () => {
    const desc = `**Route**\n${SAMPLE_LINE}`;
    const r = parseTrackerDescription(desc);
    expect(r.primaryLine).toBe(SAMPLE_LINE);
    expect(r.additionalLines).toEqual([]);
  });

  it('parses primary + single additional section', () => {
    const desc = `**Route**\n${SAMPLE_LINE}\n**Additional Routes**\n${SAMPLE_LINE}`;
    const r = parseTrackerDescription(desc);
    expect(r.primaryLine).toBe(SAMPLE_LINE);
    expect(r.additionalLines).toEqual([SAMPLE_LINE]);
  });

  it('collapses legacy multi-header format into flat list', () => {
    const desc = [
      '**Route**',
      SAMPLE_LINE,
      '**Additional Routes**',
      SAMPLE_LINE,
      '**Additional Routes**',
      SAMPLE_LINE,
      '**Additional Routes**',
      SAMPLE_LINE,
    ].join('\n');
    const r = parseTrackerDescription(desc);
    expect(r.primaryLine).toBe(SAMPLE_LINE);
    expect(r.additionalLines).toHaveLength(3);
  });
});

describe('buildTrackerDescription', () => {
  it('returns empty string when nothing provided', () => {
    expect(buildTrackerDescription(null, [])).toBe('');
  });

  it('builds primary-only', () => {
    const out = buildTrackerDescription(SAMPLE_LINE, []);
    expect(out).toBe(`**Route**\n${SAMPLE_LINE}`);
  });

  it('builds primary + additional with single header', () => {
    const out = buildTrackerDescription(SAMPLE_LINE, [SAMPLE_LINE]);
    expect(out).toContain('**Route**');
    expect(out).toBe(`**Route**\n${SAMPLE_LINE}\n**Additional Routes**\n${SAMPLE_LINE}`);
  });

  it('never emits duplicate Additional Routes headers', () => {
    const out = buildTrackerDescription(SAMPLE_LINE, [SAMPLE_LINE, SAMPLE_LINE, SAMPLE_LINE]);
    const headerCount = (out.match(/\*\*Additional Routes\*\*/g) ?? []).length;
    expect(headerCount).toBe(1);
  });

  it('truncates oldest entries to stay under 4096 chars', () => {
    const marker = (i: number) => `[R${i}MARKER]`;
    const many = Array.from({ length: 50 }, (_, i) => `${marker(i)} ${SAMPLE_LINE}`);
    const out = buildTrackerDescription(SAMPLE_LINE, many);
    expect(out.length).toBeLessThanOrEqual(4096);
    expect(out).toContain(marker(49));
    expect(out).toContain(marker(27));
    expect(out).not.toContain(marker(26));
    expect(out).not.toContain(marker(0));
    expect(out).toContain('older route(s) omitted');
  });

  it('drops individual lines that alone exceed the description budget', () => {
    const hugeLine = 'x'.repeat(4500);
    const normal = `${SAMPLE_LINE} [normal]`;
    const out = buildTrackerDescription(null, [hugeLine, normal]);
    expect(out.length).toBeLessThanOrEqual(4096);
    expect(out).toContain('[normal]');
    expect(out).not.toContain(hugeLine);
  });
});

describe('routeLinkMarkdown (konik segment ranges)', () => {
  const d = 'a818613ca4cdcfa5';
  const r = '00000067--cde15f929d';
  const base: ExtractedRoute = { dongleId: d, routeName: r, provider: 'konik', public: true, rlogsAvailable: true };

  it('gives distinct short forms and links for different segment ranges of the same route', () => {
    const whole = routeLinkMarkdown({ ...base, originalText: `https://stable.konik.ai/${d}/${r}` });
    const first = routeLinkMarkdown({ ...base, originalText: `https://stable.konik.ai/${d}/${r}/0/100`, routeNumber: 1 });
    const second = routeLinkMarkdown({ ...base, originalText: `https://stable.konik.ai/${d}/${r}/50/150`, routeNumber: 2 });

    const shortFormOf = (line: string) => line.match(/`([^`]+)`/)?.[1];
    expect(shortFormOf(whole)).toBe(`${d}/${r}`);
    expect(shortFormOf(first)).not.toBe(shortFormOf(whole));
    expect(shortFormOf(second)).not.toBe(shortFormOf(whole));
    expect(shortFormOf(first)).not.toBe(shortFormOf(second));

    expect(first).toContain(`](https://stable.konik.ai/${d}/${r}/0/100)`);
    expect(second).toContain(`](https://stable.konik.ai/${d}/${r}/50/150)`);
  });
});
