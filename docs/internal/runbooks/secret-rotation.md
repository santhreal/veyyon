# Runbook: secret rotation

Production secrets and where they live. Rotate on a schedule and immediately on any suspected leak.
Never commit secret values; local secrets live in `/credentials/.env` (Linux) / `C:\credentials\.env`
(Windows).

## Cloudflare Pages token (website / install script)

The website and `get.veyyon.dev` deploy with `CLOUDFLARE_API_TOKEN` (kept in `/credentials/.env` as
`CF_PAGES_API_TOKEN`; see [deployment](../deployment.md)). CI reads it as a repository secret and
pairs it with `CLOUDFLARE_ACCOUNT_ID`: both release deploy jobs fail closed when either value is
empty, so updating the local file alone leaves CI on the token you are about to revoke.

1. Create a new **Cloudflare Pages: Edit** scoped API token in the Cloudflare dashboard.
2. Update `CF_PAGES_API_TOKEN` in `/credentials/.env` **and** the `CLOUDFLARE_API_TOKEN`
   repository secret in GitHub.
3. Verify locally: `export CLOUDFLARE_API_TOKEN="$CF_PAGES_API_TOKEN"`, then
   `bun run site:deploy --dry-run` to print the command without deploying. Then deploy for real with
   `bun run site:deploy` (project `veyyon`, serving `veyyon.dev`) and `bun run site:deploy:get`
   (project `veyyon-get`, serving `get.veyyon.dev`). `site:deploy` publishes only the first project,
   so the install endpoint is unproven until you run the second.
4. Revoke the old token.

## Auth-broker / auth-gateway bearer tokens

The broker and gateway each authenticate every endpoint with a bearer token stored at
`<config-dir>/auth-broker.token` / `<config-dir>/auth-gateway.token` (see
[auth-broker-gateway](../auth-broker-gateway.md)). Only the health probes are exempt:
`GET /v1/healthz` on the broker, `GET /healthz` on the gateway.

1. Rotate: `veyyon auth-broker token --regenerate` (and `veyyon auth-gateway token --regenerate`).
2. Distribute the new broker token to every broker client, the gateway included, via
   `VEYYON_AUTH_BROKER_TOKEN` or `auth.broker.token` in config. The gateway token has no env var or
   config key: gateway clients read it from `veyyon auth-gateway token` and send it as a bearer
   header.
3. Clients using a stale token fail closed on the next call: expected; update them.

## After any rotation

- Confirm a test run of the affected system works with the new secret **before** revoking the old one.
- If the rotation was triggered by a leak, also audit access logs for use of the leaked value.

*Verified against `77074dee` on 2026-08-02.*
