# Runbook: self-hosted runner outage

`ci.yml` routes **release-shaped runs** (the `chore: bump version to vX.Y.Z` push, a `v*` tag-ref
dispatch, or any manual dispatch) entirely to **GitHub-hosted runners** — a release does not depend on
the self-hosted `omp-kata` fleet. Ordinary `main` pushes use `omp-kata` for speed and cache warmth
(the `runs-on` ternaries in `ci.yml`, locked by `scripts/ci-concurrency.test.ts`). The public-gate
checks (`checks.yml` — lint, typecheck, tests, secret scan) run on GitHub-hosted runners and are
unaffected either way.

## Symptom

Ordinary main-push CI jobs are queued indefinitely, or fail to start with a
"no runner matching labels" / offline-runner error. Releases are **not** blocked by this — if a
release run is stuck, the cause is elsewhere; see [release-recovery.md](release-recovery.md).

## Diagnose

1. Actions → the stuck run: a job stuck in **Queued** with no runner picking it up means no
   `omp-kata` runner is online.
2. Settings → Actions → Runners: check whether the self-hosted runner shows **Idle** (healthy) or
   **Offline**.
3. On the runner host, check the runner service and that the host has network + disk.

## Recover

- **Bring the runner back.** Restart the self-hosted runner service on the `omp-kata` host and confirm
  it flips to **Idle** in the Runners list. Then re-run the stuck jobs (Actions → the run →
  **Re-run failed jobs**).
- **If the host is unrecoverable in the moment and a fix must land:** cutting a release is still
  possible (release runs are GitHub-hosted), and `checks.yml` still gates PRs. Main-push CI simply
  waits for the runner; nothing is lost.
- Do **not** edit the `runs-on` ternaries to force GitHub-hosted runners for ordinary pushes as a
  workaround — `scripts/ci-concurrency.test.ts` locks the routing predicate, and the change would
  outlive the outage.

## Verify

Re-run the previously stuck workflow and confirm every job leaves **Queued** and completes. For a
release, follow the verification in [release-recovery.md](release-recovery.md).

*Verified against `7ca44d3` on 2026-07-17.*
