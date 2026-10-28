import { describe, expect, it } from 'vitest';
import { formatGitBranch, formatGitCommit, isStaleBuild } from './util.js';

describe('isStaleBuild', () => {
  const older = '2026-06-20T04:00:00Z';
  const newer = '2026-06-20T06:00:00Z';

  it('is stale when the route build predates the required commit', () => {
    expect(isStaleBuild(older, newer)).toBe(true);
  });

  it('is not stale when the route build is newer or equal', () => {
    expect(isStaleBuild(newer, older)).toBe(false);
    expect(isStaleBuild(newer, newer)).toBe(false);
  });

  it('is not stale when a date is missing or unparsable (cannot verify, do not block)', () => {
    expect(isStaleBuild(older, undefined)).toBe(false);
    expect(isStaleBuild('', newer)).toBe(false);
    expect(isStaleBuild('not-a-date', newer)).toBe(false);
    expect(isStaleBuild(older, 'garbage')).toBe(false);
  });
});

describe('formatGit helpers', () => {
  it('link to GitHub for a github remote', () => {
    expect(formatGitBranch('main', 'github.com/foo/bar')).toBe('[main](https://github.com/foo/bar/tree/main)');
    expect(formatGitCommit('abcdef123', 'github.com/foo/bar')).toBe('[abcdef1](https://github.com/foo/bar/commit/abcdef123)');
  });

  it('fall back to plain text when the remote is missing or not GitHub', () => {
    expect(formatGitBranch('main', null)).toBe('main');
    expect(formatGitBranch('main', undefined)).toBe('main');
    expect(formatGitCommit('abcdef123', null)).toBe('abcdef1');
    expect(formatGitBranch('main', 'gitlab.com/foo/bar')).toBe('main');
  });
});
