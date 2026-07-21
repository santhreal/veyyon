# Runbook: secret rotation

Production secrets and where they live. Rotate on a schedule and immediately on any suspected leak.
Never commit secret values; local secrets live in `/credentials/.env` (Linux) / `C:\credentials\.env`
(Windows).

## Apple signing secrets (macOS release)

Five repo secrets gate macOS signing/notarization. Missing or invalid ones fail the release's signing
step (see [macOS signing](../macos-signing-notarization.md)).

| Secret | What it is |
| --- | --- |
| `APPLE_CERTIFICATE_P12` | base64 of the Developer ID Application `.p12` (cert + key). |
| `APPLE_CERTIFICATE_PASSWORD` | password set when exporting the `.p12`. |
| `APPLE_API_KEY_ID` | App Store Connect API Key ID. |
| `APPLE_API_ISSUER_ID` | App Store Connect API Issuer ID. |
| `APPLE_API_KEY` | base64 of the App Store Connect `.p8` key. |

Rotate:

1. Regenerate the credential in the Apple developer portal (new `.p12` or new API key).
2. Re-run `scripts/ci-macos-upload-secrets.sh <dir>`: it validates the files (opens the `.p12` with
   the password, sanity-checks the `.p8`) and pipes each value to `gh secret set`. Dry-run first with
   `--dry-run`.
3. Revoke the old credential in the portal only after a test release signs cleanly.

## Cloudflare Pages token (website / install script)

The website and `get.veyyon.dev` deploy with `CLOUDFLARE_API_TOKEN` (kept in `/credentials/.env` as
`CF_PAGES_API_TOKEN`; see [deployment](../deployment.md)).

1. Create a new **Cloudflare Pages: Edit** scoped API token in the Cloudflare dashboard.
2. Update `CF_PAGES_API_TOKEN` in `/credentials/.env`.
3. Verify: `export CLOUDFLARE_API_TOKEN="$CF_PAGES_API_TOKEN" && bun run site:deploy` (add
   `--dry-run` first).
4. Revoke the old token.

## Auth-broker / auth-gateway bearer tokens

The broker and gateway each authenticate every endpoint (except health) with a bearer token stored at
`<config-dir>/auth-broker.token` / `<config-dir>/auth-gateway.token` (see
[auth-broker-gateway](../auth-broker-gateway.md)).

1. Rotate: `veyyon auth-broker token --regenerate` (and `veyyon auth-gateway token --regenerate`).
2. Distribute the new token to every gateway client via `VEYYON_AUTH_BROKER_TOKEN` (or
   `auth.broker.token` in config).
3. Clients using a stale token fail closed on the next call: expected; update them.

## After any rotation

- Confirm a test run of the affected system works with the new secret **before** revoking the old one.
- If the rotation was triggered by a leak, also audit access logs for use of the leaked value.

*Verified against `7ca44d3` on 2026-07-21.*
