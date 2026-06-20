import { LRUCache } from 'lru-cache';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('github');

const COMMIT_BRANCHES = ['StarPilot', 'Dom'] as const;

export interface CommitChoice {
  sha: string;
  short: string;
  branch: string;
  subject: string;
  date: string;
}

interface GitHubCommit {
  sha: string;
  commit: {
    message: string;
    committer: { date: string } | null;
  };
}

// Unauthenticated GitHub API allows 60 req/hr per IP. Both endpoints are
// LRU-cached to stay well under that: branch commit lists for 5 minutes
// (≤ 24 req/hr across the two branches), and compare results indefinitely —
// a comparison between two fixed SHAs never changes.
const GITHUB_HEADERS = { Accept: 'application/vnd.github+json' } as const;

const COMMITS_CACHE_TTL_MS = 5 * 60_000;
const branchCommitsCache = new LRUCache<string, CommitChoice[]>({ max: 10, ttl: COMMITS_CACHE_TTL_MS });

async function fetchBranchCommits(branch: string): Promise<CommitChoice[]> {
  const cached = branchCommitsCache.get(branch);
  if (cached) return cached;
  const { mainRepo } = loadConfig();
  try {
    const res = await fetch(
      `https://api.github.com/repos/${mainRepo}/commits?sha=${encodeURIComponent(branch)}&per_page=10`,
      { headers: GITHUB_HEADERS },
    );
    if (!res.ok) {
      log.warn({ branch, status: res.status }, 'GitHub commits request failed');
      return [];
    }
    const data = await res.json() as GitHubCommit[];
    if (!Array.isArray(data)) return [];
    const choices = data.map(c => ({
      sha: c.sha,
      short: c.sha.slice(0, 7),
      branch,
      subject: c.commit.message.split('\n')[0],
      date: c.commit.committer?.date ?? '',
    }));
    branchCommitsCache.set(branch, choices);
    return choices;
  } catch (err) {
    log.warn({ err, branch }, 'GitHub commits request errored');
    return [];
  }
}

export async function fetchCommitChoices(): Promise<CommitChoice[]> {
  const perBranch = await Promise.all(COMMIT_BRANCHES.map(fetchBranchCommits));
  return perBranch
    .flat()
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 25); // Discord select menus cap at 25 options
}

export type CompareResult = 'ok' | 'older' | 'diverged' | 'unknown';

const compareCache = new LRUCache<string, CompareResult>({ max: 500 });

export async function compareCommits(base: string, head: string): Promise<CompareResult> {
  const { mainRepo } = loadConfig();
  const key = `${mainRepo}:${base}...${head}`;
  const cached = compareCache.get(key);
  if (cached) return cached;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${mainRepo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
      { headers: GITHUB_HEADERS },
    );
    if (!res.ok) {
      log.warn({ base, head, status: res.status }, 'GitHub compare request failed');
      return 'unknown';
    }
    const data = await res.json() as { status?: string };
    // 'diverged' (neither commit is an ancestor — e.g. a rebased branch, or a route on
    // a different branch than required) is its own verdict, distinct from 'older' and
    // from the 'unknown' we return for 404/errors. Callers message it differently.
    const result: CompareResult = data.status === 'ahead' || data.status === 'identical'
      ? 'ok'
      : data.status === 'behind'
        ? 'older'
        : data.status === 'diverged'
          ? 'diverged'
          : 'unknown';
    // Safe to cache: a verdict between two fixed SHAs never changes (error 'unknown's below aren't cached).
    compareCache.set(key, result);
    return result;
  } catch (err) {
    log.warn({ err, base, head }, 'GitHub compare request errored');
    return 'unknown';
  }
}
