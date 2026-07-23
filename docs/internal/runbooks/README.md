# Runbooks

Step-by-step procedures for when something breaks in production. Each runbook is symptom → diagnosis →
recovery → verification. For the normal (non-incident) flows, see [releasing](../releasing.md) and
[deployment](../deployment.md).

| Runbook | When to reach for it |
| --- | --- |
| [release-recovery.md](release-recovery.md) | `bun run release` or its CI failed partway; a tag exists but the GitHub release / binaries are missing or incomplete. |
| [secret-rotation.md](secret-rotation.md) | Rotating Apple signing secrets, the Cloudflare Pages token, or auth-broker bearer tokens. |
| [install-rollback.md](install-rollback.md) | A published release is bad and `curl … | sh` is serving it to users. |

*Verified against `d3e3db30` on 2026-07-23.*
