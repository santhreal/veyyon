# Runbooks

Operational procedures for release incidents, install rollback, and scheduled or emergency secret rotation.
Incident runbooks lead from diagnosis through recovery and verification; credential runbooks are organized by
the secret being rotated. For normal flows, see [releasing](../releasing.md) and [deployment](../deployment.md).

| Runbook | When to reach for it |
| --- | --- |
| [release-recovery.md](release-recovery.md) | The automated Release or tagged publish workflow failed, or a tag exists without complete binaries. |
| [secret-rotation.md](secret-rotation.md) | Rotating Apple signing secrets, the Cloudflare Pages token, or auth-broker and auth-gateway bearer tokens. |
| [install-rollback.md](install-rollback.md) | A published release is bad and `curl … | sh` is serving it to users. |

*Verified against `0eb8d74a3ecf60e1b2ec37c15e9255f2dbe310dc` on 2026-07-30.*
