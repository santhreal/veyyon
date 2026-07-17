# Security policy

Veyyon runs on a developer's machine with real capability: it executes commands,
edits files, holds provider OAuth tokens and API keys, and manages an encrypted
secret store. Security reports are taken seriously.

## Reporting a vulnerability

**Do not open a public issue for a vulnerability.** Use GitHub's private reporting:

- Go to the [Security tab](https://github.com/santhreal/veyyon/security/advisories) →
  **Report a vulnerability**.

Include a description, affected version/commit, reproduction steps, and impact. You'll
get an acknowledgement, and we'll coordinate a fix and disclosure timeline with you.

## Supported versions

Veyyon has not yet cut its `1.0.0` release. Until then, only `main` is supported —
report against the latest `main`. After `1.0.0`, the latest published release and
`main` are supported.

## Scope

In scope:

- Sandbox or approval bypass — any path that runs a command or writes a file outside
  the policy the user approved.
- Secret exposure — tokens or keys written to logs, telemetry, session files, or
  reachable by a tool without consent. Credentials live in the encrypted store
  (`local.age` / `veyyon_auth.age`); a plaintext leak is in scope.
- Silent fallback that weakens a security control (a fail-closed check that quietly
  fails open).
- Remote-input handling — a hostile file, tool result, MCP server, or model response
  that escalates to code execution or credential access beyond the approved boundary.
- The installer and update path — checksum-verification bypass, or fetching an
  unverified binary.

Out of scope:

- Anything requiring an already-compromised host or a malicious local user.
- Social-engineering a user into approving an action the approval prompt described
  accurately.
- Vulnerabilities in a third-party model provider's own service.

## Handling of secrets

Credentials are never logged. The managed store is age-encrypted. Report any path
that violates this. See the internal notes under `docs/internal/` (auth broker,
secrets) for the intended model.
