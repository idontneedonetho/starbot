import humanizeDuration from 'humanize-duration';

export const COLORS = {
  blurple: 0x5865f2,
  amber: 0xf0b132,
  green: 0x248046,
  red: 0xe74c3c,
} as const;

export function dot(a: number[], b: number[]): number {
  let result = 0;
  for (let i = 0; i < a.length; i++) result += a[i] * b[i];
  return result;
}

export function timeAgo(iso: string): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return `${humanizeDuration(Date.now() - ms, { largest: 1, round: true })} ago`;
}

export function discordTimestamp(iso: string, style: 't' | 'T' | 'd' | 'D' | 'f' | 'F' | 'R' = 'f'): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

// True when a route's build commit predates the required commit — the reopen gate's
// guard against testing on a stale build. Branches rebase and don't share history, so
// this is a pure commit-DATE comparison, not git ancestry. Unparsable/missing dates
// are treated as not stale (can't verify → don't block).
export function isStaleBuild(routeDate: string, requiredDate: string | undefined): boolean {
  const routeTime = Date.parse(routeDate);
  const reqTime = requiredDate ? Date.parse(requiredDate) : NaN;
  return Number.isFinite(routeTime) && Number.isFinite(reqTime) && routeTime < reqTime;
}

export function githubRemoteParts(remote: string): { owner: string; repo: string } | null {
  const match = remote.match(/^github\.com\/([^/]+)\/([^/]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

export function formatGitBranch(branch: string, remote: string): string {
  const gh = githubRemoteParts(remote);
  if (gh) return `[${branch}](https://github.com/${gh.owner}/${gh.repo}/tree/${branch})`;
  return branch;
}

export function formatGitCommit(commit: string, remote: string): string {
  const gh = githubRemoteParts(remote);
  const short = commit.slice(0, 7);
  if (gh) return `[${short}](https://github.com/${gh.owner}/${gh.repo}/commit/${commit})`;
  return short;
}
