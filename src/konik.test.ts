import { afterEach, describe, expect, it, vi } from 'vitest';
import { konikViewerUrl, getKonikRouteInfo, validateKonikRoute } from './konik.js';

describe('konikViewerUrl', () => {
  it('builds the stable.konik.ai viewer url', () => {
    expect(konikViewerUrl('59679e5e40b60ce0', '0000091b--316e931f07'))
      .toBe('https://stable.konik.ai/59679e5e40b60ce0/0000091b--316e931f07');
  });
});

const dongleId = '59679e5e40b60ce0';
const routeName = '0000091b--316e931f07';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: () => Promise.resolve(body) } as Response;
}

describe('getKonikRouteInfo / validateKonikRoute', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports an invalid route when the API 404s', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'Bad Request' }, false)));
    const info = await getKonikRouteInfo(dongleId, routeName);
    expect(info).toEqual({ valid: false, public: false, rlogsAvailable: false, metadata: null });
  });

  it('reports a private route without hitting /files', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ is_public: false, git_remote: null, git_branch: null, git_commit: null, git_dirty: null, platform: null, maxqlog: 3 }));
    vi.stubGlobal('fetch', fetchMock);
    const info = await getKonikRouteInfo(dongleId, `${routeName}-private`);
    expect(info.valid).toBe(true);
    expect(info.public).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports a public route with metadata and rlog availability', async () => {
    const routeId = `${routeName}-public`;
    const logs = [0, 1].map(i => `https://api.konik.ai/connectdata/${dongleId}/${routeId}/${i}/rlog.zst?sig=x`);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        is_public: true, git_remote: 'https://github.com/foo/openpilot.git', git_branch: 'star',
        git_commit: 'abc123', git_dirty: false, platform: 'TOYOTA_RAV4', maxqlog: 1,
      }))
      .mockResolvedValueOnce(jsonResponse({ logs }));
    vi.stubGlobal('fetch', fetchMock);

    const info = await getKonikRouteInfo(dongleId, routeId);
    expect(info.valid).toBe(true);
    expect(info.public).toBe(true);
    expect(info.rlogsAvailable).toBe(true);
    expect(info.metadata).toMatchObject({ gitBranch: 'star', gitCommit: 'abc123', platform: 'TOYOTA_RAV4' });
  });

  it('validateKonikRoute flags missing segments when a range is given', async () => {
    const routeId = `${routeName}-segrange`;
    const logs = [0, 2].map(i => `https://api.konik.ai/connectdata/${dongleId}/${routeId}/${i}/rlog.zst?sig=x`);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        is_public: true, git_remote: null, git_branch: null, git_commit: null, git_dirty: null, platform: null, maxqlog: 2,
      }))
      .mockResolvedValueOnce(jsonResponse({ logs }))
      .mockResolvedValueOnce(jsonResponse({ logs }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await validateKonikRoute(dongleId, routeId, 0, 2);
    expect(result.valid).toBe(true);
    expect(result.public).toBe(true);
    expect(result.rlogCheck).toEqual({ mode: 'segment', missing: [1] });
  });
});
