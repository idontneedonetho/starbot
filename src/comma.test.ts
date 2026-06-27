import { describe, expect, it } from 'vitest';
import { computeRouteLogIssues, type RouteLogIssueInput } from './comma.js';

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
