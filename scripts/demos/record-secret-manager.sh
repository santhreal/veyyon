#!/usr/bin/env bash
# Record the secret manager demo against a throwaway project and a seeded demo vault.
#
# The card needs something to manage, so this seeds four fabricated credentials and six
# recorded uses before the tape runs, through the real vault and audit APIs. Both are removed
# afterwards: the demo profile keeps no credentials once the recording is written.
#
# The tape needs no provider. Nothing here talks to a model, so this records offline.
#
# Run:
#     bash scripts/demos/record-secret-manager.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEMO_CWD="$(mktemp -d /tmp/veyyon-secret-manager-demo.XXXXXX)"

# The demo stores one credential at global scope, because the roster is only honest if it shows
# all three scopes. Global scope is the machine's own vault, shared by every profile, so the run
# would otherwise leave a fabricated credential in the operator's real vault, and the profile-only
# cleanup below would never find it. It did exactly that once. Snapshot the file and put it back
# byte for byte, whatever happens, so the recording cannot outlive itself.
# Derived from $HOME, never from VEYYON_HOME. The product has no such knob: it resolves its
# config root from the home directory alone. A script that honours VEYYON_HOME therefore guards
# and cleans a directory the running app never touches, which is how a fabricated global
# credential once reached the operator's real vault.
GLOBAL_VAULT="$HOME/.veyyon/vault.json"
GLOBAL_VAULT_BACKUP="$(mktemp /tmp/veyyon-global-vault-backup.XXXXXX)"
if [[ -f "$GLOBAL_VAULT" ]]; then
	cp -p -- "$GLOBAL_VAULT" "$GLOBAL_VAULT_BACKUP"
	restore_global_vault() { cp -p -- "$GLOBAL_VAULT_BACKUP" "$GLOBAL_VAULT"; }
else
	restore_global_vault() { rm -f -- "$GLOBAL_VAULT"; }
fi
trap 'restore_global_vault; rm -rf "$DEMO_CWD" "$GLOBAL_VAULT_BACKUP"' EXIT

mkdir -p "$DEMO_CWD/.veyyon" "$DEMO_CWD/src"
printf 'export const demo = true;\n' > "$DEMO_CWD/src/index.ts"
printf '{"name":"veyyon-secret-manager-demo","private":true,"type":"module"}\n' > "$DEMO_CWD/package.json"

export VEYYON_DEMO_CWD="$DEMO_CWD"
export VEYYON_DEMO_PROFILE="${VEYYON_DEMO_PROFILE:-demo}"

cd "$REPO_ROOT"
bash scripts/demos/setup-profile.sh >/dev/null

BUN="${VEYYON_DEMO_BUN:-$HOME/.bun/bin/bun}"
CLI=("$BUN" "$REPO_ROOT/packages/coding-agent/src/cli.ts" --profile "$VEYYON_DEMO_PROFILE")
DEMO_PROFILE_DIR="$HOME/.veyyon/profiles/$VEYYON_DEMO_PROFILE/agent"

# The shared demo profile turns secret handling off, because most tapes have no use for it and
# an unexpected expansion would be a surprise in an unrelated recording. This one is about the
# feature, so it needs both the vault and the expansion log switched on for the run.
"${CLI[@]}" config set secrets.enabled true >/dev/null
"${CLI[@]}" config set secrets.auditLog true >/dev/null

# Start from nothing so the roster holds exactly what the tape narrates. A leftover credential
# from an earlier run would put an unexplained row in the recording.
rm -f -- "$DEMO_PROFILE_DIR/vault.json" \
	"$DEMO_PROFILE_DIR/secret-audit.jsonl" \
	"$DEMO_PROFILE_DIR/secret-audit.jsonl.1"

"$BUN" scripts/demos/seed-secret-manager.ts --profile "$VEYYON_DEMO_PROFILE" --cwd "$DEMO_CWD" >/dev/null

vhs assets/tapes/secret-manager.tape

# Leave no fabricated credential behind, and hand the shared demo profile back the way the
# other tapes expect to find it.
rm -f -- "$DEMO_PROFILE_DIR/vault.json" \
	"$DEMO_PROFILE_DIR/secret-audit.jsonl" \
	"$DEMO_PROFILE_DIR/secret-audit.jsonl.1"
bash scripts/demos/setup-profile.sh >/dev/null

printf 'wrote assets/demo-secret-manager.gif using throwaway project %s\n' "$DEMO_CWD"
