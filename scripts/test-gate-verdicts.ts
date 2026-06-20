/**
 * Direct verdict-matrix test for the newer-commit gate.
 *
 * Exercises the real `compareCommits()` (GitHub compare + verdict mapping) without
 * going through Discord, covering every status GitHub can return:
 *   ahead | identical -> 'ok'
 *   behind            -> 'older'
 *   diverged          -> 'diverged'  (own verdict — rebased branch / different lineage)
 *   404 | error       -> 'unknown'
 *
 * Run:  npx tsx scripts/test-gate-verdicts.ts
 *
 * SHAs below are from firestar5683/openpilot (MAIN_REPO default) as of 2026-06-19;
 * refresh them if the branches move. `base` = the staff-pinned required commit,
 * `head` = the user's route commit (same argument order as report-actions uses:
 * compareCommits(req.requiredSha, routeCommit)).
 */
import { compareCommits, type CompareResult } from '../src/github.js';

interface Case { name: string; base: string; head: string; expect: CompareResult; note: string }

const cases: Case[] = [
  { name: 'identical',             base: '9217bf2', head: '9217bf2', expect: 'ok',       note: 'route on exactly the required commit' },
  { name: 'ahead (route newer)',   base: '5eb6fe2', head: '9217bf2', expect: 'ok',       note: 'required older, route newer on same Dom lineage' },
  { name: 'behind (route older)',  base: '9217bf2', head: '5eb6fe2', expect: 'older',    note: 'route on an older linear ancestor' },
  { name: 'diverged (real fork)',  base: '9217bf2', head: 'ed30419', expect: 'diverged', note: 'route commit diverged from required — bug_002 path' },
  { name: 'cross-branch (no base)',base: '9217bf2', head: '471e944', expect: 'unknown',  note: 'StarPilot vs Dom — GitHub 404 -> unknown' },
  { name: 'nonexistent sha',       base: '9217bf2', head: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', expect: 'unknown', note: 'route commit not in repo' },
];

let pass = 0;
for (const c of cases) {
  const got = await compareCommits(c.base, c.head);
  const ok = got === c.expect;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(24)} got=${got.padEnd(8)} expect=${c.expect.padEnd(8)} — ${c.note}`);
}
console.log(`\n${pass}/${cases.length} passed`);
process.exit(pass === cases.length ? 0 : 1);
