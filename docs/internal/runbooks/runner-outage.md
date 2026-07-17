# Runbook: release-runner outage

`ci.yml`'s release matrix runs on the self-hosted **`omp-kata`** runner. The public-gate checks
(`checks.yml` — lint, typecheck, tests, secret scan) run on GitHub-hosted runners and are unaffected;
only the **release build/publish** jobs depend on `omp-kata`.

## Symptom

A release tag is pushed but the release jobs are queued indefinitely, or they fail to start with a
"no runner matching labels" / offline-runner error.

## Diagnose

1. Actions → the release run: a job stuck in **Queued** with no runner picking it up means no
   `omp-kata` runner is online.
2. Settings → Actions → Runners: check whether the self-hosted runner shows **Idle** (healthy) or
   **Offline**.
3. On the runner host, check the runner service and that the host has network + disk.

## Recover

- **Bring the runner back.** Restart the self-hosted runner service on the `omp-kata` host and confirm
  it flips to **Idle** in the Runners list. Then re-run the failed release jobs (Actions → the run →
  **Re-run failed jobs**). The tag does not need to be re-cut.
- **If the host is unrecoverable in the moment:** the release simply waits. The tag is already on
  `main`; nothing is lost. Do not cut a new version to force GitHub-hosted runners — that would fork
  the release line. Restore the runner, then re-run.
- **Longer-term:** migrating the release matrix to GitHub-hosted runners removes this single point of
  failure. That is a known gap tracked in [releasing.md](../releasing.md); until it lands, the runner
  must be online to publish.

## Verify

The re-run publishes the GitHub release with all `veyyon-*` binaries + `.sha256` files, then follow the
verification in [release-recovery.md](release-recovery.md).
