const fs = require('fs');
const execSync = require('child_process').execSync;

const date = execSync('date -u +%Y-%m-%d').toString().trim();
// The issue is that `commit` wasn't valid in CI because it was using a shallow clone or `54f074f0` wasn't pushed?
// No, the CI checked out `54f074f0` but then check-doc-freshness failed because the commit doesn't exist?
// Wait, `check-doc-freshness` complains "stamped commit 54f074f0 does not exist".
// Ah! In CI, the checkout is shallow (`fetch-depth: 1` or similar?).
// Wait, the CI logs show: `git fetch ... origin +refs/heads/*:refs/remotes/origin/*`.
// Then it merges the PR ref into target branch `df13410f8eb5bd572ac94e2cfac65bdc65ec2e70`.
// So the commit `54f074f0` is my HEAD commit. Why does `check-doc-freshness.ts` say it does not exist?
// Because `check-doc-freshness.ts` might verify it against `origin/main`!
// Let me look at `scripts/check-doc-freshness.ts`.
