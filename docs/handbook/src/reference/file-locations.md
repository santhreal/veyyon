# File locations

Everything Veyyon stores lives under the config home — `~/.veyyon` on Unix by default, or the Veyyon
application directory on Windows. Override the directory name with `PI_CONFIG_DIR`; on Linux the XDG
layout is available after `veyyon config migrate`.

## Layout

| Path | Contents |
| --- | --- |
| `config.yml` | Your configuration (`config.yaml` also accepted). See [Configuration](../using/configuration.md). |
| `auth.json` | The managed OpenAI/ChatGPT credential (in `file` credential-store mode). |
| `local.age` | The encrypted managed-secrets store (general secrets, including BYOK provider keys). |
| `veyyon_auth.age` | The encrypted auth-token store (in `secrets` credential-store mode). |
| `sessions/` | Saved session rollouts (JSONL), one per thread. |
| `archived_sessions/` | Sessions moved aside by `veyyon gc`. |
| `logs/` | Log files, including the login log. |
| `history.jsonl` | Composer input history. |
| `plugins/` | Installed plugins. |
| `skills/` | Installed and local skills. |
| `hooks/` | Lifecycle hook configuration. |
| `agents/` | Agent definitions. |
| `attachments/`, `avatars/` | Session attachments and account avatars. |

## Credential storage modes

Where credentials land depends on `cli_auth_credentials_store_mode` in `config.yml`:

- `file` — `auth.json`, mode `0600`, written atomically.
- `keyring` — the OS keyring (with the encrypted `secrets` backend as one keyring option).
- `auto` — keyring when available, falling back to the file.
- `ephemeral` — in-memory only; nothing is written to disk.

BYOK provider keys always go to the encrypted managed-secrets store (`local.age`), never to plaintext
`config.yml`; see [Signing in](../using/authentication.md).

## Project-local files

Alongside your project (not under the config home):

| Path | Purpose |
| --- | --- |
| `AGENTS.md` | Project instructions Veyyon auto-loads. See [AGENTS.md](../using/extending.md). |
| `.veyyon/` | Optional per-project overrides and data. |
