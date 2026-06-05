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
