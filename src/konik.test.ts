import { describe, expect, it } from 'vitest';
import { parseInitData, konikViewerUrl } from './konik.js';

describe('parseInitData', () => {
  it('extracts git fields from the openpilot JSON blob', () => {
    const text = 'garbage\x00{"channel": "StarPilot", "openpilot": {"version": "0.10.3", "git_commit": "045d44845ace183504441d79ebe20ef9fe0e2fe2", "git_origin": "https://github.com/firestar5683/openpilot.git", "git_commit_date": "\'1781977015 2026-06-20 12:36:55 -0500\'", "is_dirty": false}}\x00more';
    expect(parseInitData(text)).toMatchObject({
      gitCommit: '045d44845ace183504441d79ebe20ef9fe0e2fe2',
      gitRemote: 'https://github.com/firestar5683/openpilot.git',
      gitBranch: 'StarPilot',
      version: '0.10.3',
      gitDirty: false,
      gitCommitDate: '2026-06-20 12:36:55 -0500',
    });
  });

  it('falls back to raw text fields when the JSON blob is absent', () => {
    const text = 'noise 6fa509cc887954eb3a3faf29d548205cf6ef2a29 noise https://github.com/gotens87/openpilot.git noise';
    const m = parseInitData(text);
    expect(m.gitCommit).toBe('6fa509cc887954eb3a3faf29d548205cf6ef2a29');
    expect(m.gitRemote).toBe('https://github.com/gotens87/openpilot.git');
  });

  it('returns an empty object when no git data is present', () => {
    expect(parseInitData('nothing to see here')).toEqual({});
  });
});

describe('konikViewerUrl', () => {
  it('builds the stable.konik.ai viewer url', () => {
    expect(konikViewerUrl('59679e5e40b60ce0', '0000091b--316e931f07'))
      .toBe('https://stable.konik.ai/59679e5e40b60ce0/0000091b--316e931f07');
  });
});
