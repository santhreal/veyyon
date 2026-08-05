# Runbooks

Operational procedures for scheduled or emergency secret rotation, organized by the
secret being rotated.

| Runbook | When to reach for it |
| --- | --- |
| [secret-rotation.md](secret-rotation.md) | Rotating Apple signing secrets, the Cloudflare Pages token, or auth-broker and auth-gateway bearer tokens. |

Release incidents are not here. Cutting a release, verifying one, recovering a
failed cut, and rolling back a bad release are all in
[releasing.md](../releasing.md), which is the only page about releases. Site and
install-endpoint deployment is in [deployment.md](../deployment.md).

*Verified against `92ff7a6b` on 2026-08-04.*
