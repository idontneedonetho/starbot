import { describe, expect, it } from 'vitest';
import { computeRouteLogIssues, parseRouteField, type RouteLogIssueInput } from './comma.js';

describe('parseRouteField', () => {
  const d1 = '0123456789abcdef';
  const r1 = '0000aaaa--1234567890';
  const d2 = 'fedcba9876543210';
  const r2 = '1111bbbb--0987654321';
  const d3 = 'aaaabbbbccccdddd';
  const r3 = '2222cccc--1122334455';

  it('parses a single bare route as the primary', () => {
    const result = parseRouteField(`${d1}/${r1}`);
    expect(result?.routes).toHaveLength(1);
    expect(result?.primary).toMatchObject({ dongleId: d1, routeName: r1 });
    expect(result?.primary.startSegment).toBeUndefined();
  });

  it('preserves connect-URL segment bounds on the primary', () => {
    const result = parseRouteField(`https://connect.comma.ai/${d1}/${r1}/120/240`);
    expect(result?.routes).toHaveLength(1);
    expect(result?.primary).toMatchObject({ dongleId: d1, routeName: r1, startSegment: 2, endSegment: 4 });
  });

  it.each([
    ['space', ' '],
    ['bare comma', ','],
    ['bare semicolon', ';'],
    ['comma-space', ', '],
    ['newline', '\n'],
    ['tab', '\t'],
  ])('extracts two routes separated by a %s, primary first', (_label, sep) => {
    const result = parseRouteField(`${d1}/${r1}${sep}${d2}/${r2}`);
    expect(result?.routes).toHaveLength(2);
    expect(result?.routes[0]).toMatchObject({ dongleId: d1, routeName: r1 });
    expect(result?.routes[1]).toMatchObject({ dongleId: d2, routeName: r2 });
    expect(result?.primary).toMatchObject({ dongleId: d1, routeName: r1 });
  });

  it('extracts mixed URL, pipe, and slash forms', () => {
    const result = parseRouteField(`https://connect.comma.ai/${d1}/${r1} ${d2}|${r2} ${d3}/${r3}`);
    expect(result?.routes).toHaveLength(3);
    expect(result?.routes.map(r => `${r.dongleId}/${r.routeName}`)).toEqual([
      `${d1}/${r1}`,
      `${d2}/${r2}`,
      `${d3}/${r3}`,
    ]);
  });

  it('dedupes a repeated route', () => {
    const result = parseRouteField(`${d1}/${r1} ${d1}/${r1}`);
    expect(result?.routes).toHaveLength(1);
  });

  it('returns null when no route is found', () => {
    expect(parseRouteField('not a route')).toBeNull();
    expect(parseRouteField('')).toBeNull();
  });
});

describe('computeRouteLogIssues', () => {
  const publicWhole = (originalText: string, rlogsAvailable: boolean): RouteLogIssueInput => ({
    originalText,
    public: true,
    rlogsAvailable,
    rlogCheck: { mode: 'whole', missing: [] },
  });

  it('returns no issues for a public route with logs available', () => {
    expect(computeRouteLogIssues([publicWhole('abc/def', true)])).toEqual([]);
  });

  it('flags a private route', () => {
    expect(computeRouteLogIssues([{ originalText: 'abc/def', public: false, rlogsAvailable: false }])).toEqual([
      '`abc/def` is **private**. Make it public, then check again.',
    ]);
  });

  it('flags a public route missing whole-route logs', () => {
    expect(computeRouteLogIssues([publicWhole('abc/def', false)])).toEqual([
      '`abc/def` is missing some logs. Upload all logs from your device, then check again.',
    ]);
  });

  it('flags a public route missing specific segments', () => {
    expect(computeRouteLogIssues([{
      originalText: 'abc/def',
      public: true,
      rlogsAvailable: false,
      rlogCheck: { mode: 'segment', missing: [2, 3] },
    }])).toEqual([
      '`abc/def` is missing logs for segment(s) **2, 3**. Upload them, then check again.',
    ]);
  });

  it('does not flag a segment route when nothing is missing', () => {
    expect(computeRouteLogIssues([{
      originalText: 'abc/def',
      public: true,
      rlogsAvailable: true,
      rlogCheck: { mode: 'segment', missing: [] },
    }])).toEqual([]);
  });

  it('collects an issue per offending route', () => {
    const issues = computeRouteLogIssues([
      publicWhole('ok/route', true),
      { originalText: 'priv/route', public: false, rlogsAvailable: false },
      publicWhole('nolog/route', false),
    ]);
    expect(issues).toEqual([
      '`priv/route` is **private**. Make it public, then check again.',
      '`nolog/route` is missing some logs. Upload all logs from your device, then check again.',
    ]);
  });
});
