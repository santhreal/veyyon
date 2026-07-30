#!/usr/bin/env bash
# End-to-end harness for veyyon's `/secret` flow, driven through the real CLI.
#
# WHAT THIS IS FOR. `/secret`'s security claims are all about what does NOT happen:
# a value never reaches the model, never reaches a log, never reaches the provider,
# and is never spent without permission outside yolo. None of that can be checked
# by reading the code, and on a developer machine it cannot be checked at all,
# because `/secret list` and the stored-name completion read the global, profile
# AND project scopes — so the output names that developer's real credentials.
# Everything below runs against a container-owned HOME and an empty vault.
#
# HOW IT DRIVES THE TOOL PATH. Placeholder expansion, the secret-use boundary and
# the post-revocation literal only happen on a real model turn that emits a real
# tool call, so the harness stands up `mock-provider.ts` (an OpenAI-compatible
# endpoint on loopback) and points a `models.yml` custom provider at it. Every
# layer under the HTTP boundary is shipped code.
#
# HOW A SPENT CREDENTIAL IS OBSERVED WITHOUT PRINTING IT. The tool call the model
# emits hashes its own argument and writes only the hex digest to a file in the
# project directory. The harness compares that digest with one it computes from
# the seed it generated. A digest is not a credential, so no assertion, capture,
# or failure message in this file can carry a value.
#
# WHY IT FAILS LOUDLY ON AN UNKNOWN NAME. A polluted environment is the one way
# this harness could pass while proving nothing: if a real vault were visible,
# `/secret list` would show real names and the alignment and count assertions
# would pass anyway. `guard/no-foreign-secret-names` sweeps every captured byte
# for placeholder tokens outside the three names it seeded and fails the run.

set -uo pipefail

HOME_DIR="${HARNESS_HOME:-$HOME}"
PROJECT="${HARNESS_PROJECT:-/harness/project}"
WORK="${HARNESS_WORK:-/harness/work}"
PORT="${HARNESS_MOCK_PORT:-8899}"
BIN_DIR="$(cd "$(dirname "$0")" && pwd)"

WIRE="$WORK/wire.log"
WIRE_SLICE="$WORK/wire-slice.log"
SPEC="$WORK/tool-spec.json"
MOCK_LOG="$WORK/mock-provider.log"
SPENT="$PROJECT/spent-digest.txt"
MODEL="harness/harness-model"

# Every approval mode `tools/approval.ts` accepts, legacy aliases included, split
# by what the secret-use boundary is documented to do in each. The lists are
# spelled out rather than derived so a mode added to the product without a
# decision here shows up as a missing row instead of silently inheriting one.
NON_YOLO_MODES=(plan ask auto-edit always-ask write)
YOLO_MODES=(yolo)

CHECKS=0
FAILURES=0

pass() {
	CHECKS=$((CHECKS + 1))
	printf 'PASS  %s\n' "$1"
}

fail() {
	CHECKS=$((CHECKS + 1))
	FAILURES=$((FAILURES + 1))
	printf 'FAIL  %s\n        %s\n' "$1" "$2"
}

# Assertion helpers never echo file contents, only the harness-authored needle and
# the path. A capture can hold an expanded credential (it does today — see
# `leak/json-event-stream-never-prints-value`), so a helper that quoted the file
# on failure would turn a detected leak into a printed one.
expect_contains() { # file needle name
	if grep -qF -- "$2" "$1" 2>/dev/null; then pass "$3"; else fail "$3" "not found in ${1}: ${2}"; fi
}

expect_absent() { # file needle name
	if grep -qF -- "$2" "$1" 2>/dev/null; then fail "$3" "unexpectedly present in ${1}: ${2}"; else pass "$3"; fi
}

expect_eq() { # actual expected name
	if [ "$1" = "$2" ]; then pass "$3"; else fail "$3" "expected '${2}', got '${1}'"; fi
}

# ---------------------------------------------------------------------------
# Seeds
#
# Generated in the container, so no value the harness stores has ever existed on
# the host, in the repo, or in this file. Names avoid every keyword in
# `secrets/env-keywords.yml` (KEY, SECRET, TOKEN, PASSWORD, PASS, PASSPHRASE,
# AUTH, CREDENTIAL, PRIVATE, OAUTH) at a matching boundary, so environment
# auto-detection cannot be the reason a value is protected: the vault has to be.
# ---------------------------------------------------------------------------
new_seed() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

HARNESS_SEED_A="$(new_seed)"
HARNESS_SEED_B="$(new_seed)"
HARNESS_SEED_C="$(new_seed)"
export HARNESS_SEED_A HARNESS_SEED_B HARNESS_SEED_C

NAME_PROFILE=HARNESS_TOKEN
NAME_PROJECT=HKEY1
NAME_GLOBAL=HARNESS_GLOBAL_TOKEN
PTY_NAME=HPTY1
PTY_TYPED="harness-typed-in-the-masked-field"
SEEDED_NAMES=("$NAME_PROFILE" "$NAME_PROJECT" "$NAME_GLOBAL" "$PTY_NAME")

DIGEST_A="$(printf %s "$HARNESS_SEED_A" | sha256sum | cut -c1-64)"
DIGEST_LITERAL="$(printf %s "#${NAME_PROFILE}#" | sha256sum | cut -c1-64)"

# Every value this run ever created, and the one sweep that looks for any of them
# in any sink. Shared by the list assertion and the leak section so a sink added
# later cannot be checked against a shorter list of seeds than the rest.
SEEDS=("$HARNESS_SEED_A" "$HARNESS_SEED_B" "$HARNESS_SEED_C")

sweep() { # label, paths...
	local label="$1"
	shift
	local hits=0
	for seed in "${SEEDS[@]}"; do
		for target in "$@"; do
			[ -e "$target" ] || continue
			if grep -rqF -- "$seed" "$target" 2>/dev/null; then hits=$((hits + 1)); fi
		done
	done
	if [ "$hits" -eq 0 ]; then pass "$label"; else fail "$label" "${hits} seeded value(s) found; paths withheld so this report cannot leak one"; fi
}

mkdir -p "$HOME_DIR" "$PROJECT" "$WORK"

# Placeholder tokens this run is allowed to produce: the four it seeds, plus the two
# the product writes literally about itself. `/secret list` on an empty vault says the
# agent spends one "by writing #NAME#", and the system prompt statement in
# `prompts/session/statements/tool-policy/secrets-redaction.md` explains `#NAME#` and
# `#XXXX#` tokens to the model. Both are prose about the feature, not stored names.
#
# Everything else is a finding, and the check that reads this list is worth more than
# it looks: since the secret inventory went into the system prompt, the wire log now
# carries the names of spendable credentials, so a foreign vault would show up in a
# provider request. That is the failure this list exists to keep visible.
ALLOWED="$WORK/allowed-placeholders.txt"
printf '#NAME#\n#XXXX#\n' >"$ALLOWED"
for name in "${SEEDED_NAMES[@]}"; do printf '#%s#\n' "$name" >>"$ALLOWED"; done

foreign_placeholders() { # files... -> one unexpected token per line
	grep -ohE '#[A-Za-z0-9_]{3,64}#' "$@" 2>/dev/null | sort -u | grep -vxF -f "$ALLOWED"
}

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------
: >"$WIRE"

# Ask veyyon where its agent directory is instead of hardcoding a profile path, and
# read it with stdin closed: every `veyyon` call in this script inherits the
# harness's own stdin, and one that drains it leaves `--shell probe.sh` with
# nothing to execute.
AGENT_DIR="$(cd "$PROJECT" && veyyon config path 2>/dev/null </dev/null | tail -1)"
if [ -z "$AGENT_DIR" ] || [ ! -d "$(dirname "$AGENT_DIR")" ]; then
	printf 'FATAL veyyon config path did not resolve an agent directory (got %s)\n' "${AGENT_DIR:-<empty>}"
	exit 2
fi
mkdir -p "$AGENT_DIR"

cat >"$AGENT_DIR/models.yml" <<YAML
providers:
  harness:
    baseUrl: http://127.0.0.1:${PORT}/v1
    apiKey: harness-loopback-only
    api: openai-completions
    auth: apiKey
    models:
      - id: harness-model
        name: Harness Model
        reasoning: false
        input: [text]
        supportsTools: true
        contextWindow: 200000
        maxTokens: 4096
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
YAML

# `tools.approval.bash: allow` is what isolates the secret-use boundary from the
# approval TIER. bash is exec tier, so in ask/auto-edit/plan it would prompt for
# being bash and the run would prove nothing about secrets. With an explicit
# allow, `requiresApproval` returns false in every mode, and the ONLY thing left
# that can force a prompt is the boundary in `extensions/wrapper.ts`. The
# `spend/*-control-runs-without-secret` rows are the negative control that proves
# the allow really does auto-approve.
cat >"$AGENT_DIR/config.yml" <<YAML
startup:
  setupWizard: false
  showSplash: false
  checkUpdate: false
tools:
  approval:
    bash: allow
YAML

export HARNESS_TOOL_SPEC="$SPEC"
export HARNESS_WIRE_LOG="$WIRE"
export HARNESS_MOCK_PORT="$PORT"
printf '{}\n' >"$SPEC"

bun "$BIN_DIR/mock-provider.ts" >>"$MOCK_LOG" 2>&1 &
MOCK_PID=$!
cleanup() { kill "$MOCK_PID" 2>/dev/null; }
trap cleanup EXIT

for _ in $(seq 1 50); do
	if (echo >"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null; then break; fi
	sleep 0.2
done
if ! (echo >"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null; then
	printf 'FATAL mock provider never accepted a connection on port %s\n' "$PORT"
	cat "$MOCK_LOG"
	exit 2
fi

# ---------------------------------------------------------------------------
# CLI driver
# ---------------------------------------------------------------------------
LAST_OUT=""
LAST_ERR=""
CAPTURES=()

# Two drivers, because `--model` is a root-command flag: `veyyon --model M config get
# …` is a usage error that prints nothing on stdout, which reads exactly like a
# setting that failed to persist. One helper per command shape removes the trap.
#
# `</dev/null` on both: with `--shell probe.sh` the harness's own stdin is the probe
# script, and a veyyon process that inherits and drains it eats the rest of the file.
vey() { # tag, root-command args (prompt runs)
	local tag="$1"
	shift
	LAST_OUT="$WORK/${tag}.out"
	LAST_ERR="$WORK/${tag}.err"
	(cd "$PROJECT" && veyyon --model "$MODEL" "$@" </dev/null) >"$LAST_OUT" 2>"$LAST_ERR"
	CAPTURES+=("$LAST_OUT" "$LAST_ERR")
}

veyc() { # tag, subcommand args (config, …) — no --model
	local tag="$1"
	shift
	LAST_OUT="$WORK/${tag}.out"
	LAST_ERR="$WORK/${tag}.err"
	(cd "$PROJECT" && veyyon "$@" </dev/null) >"$LAST_OUT" 2>"$LAST_ERR"
	CAPTURES+=("$LAST_OUT" "$LAST_ERR")
}

# The tool arguments the mock provider replays are a JSON string containing a JSON
# document, so every command goes through two encodes. Done with `JSON.stringify`
# rather than shell quoting: a hand-rolled approximation is how a harness ends up
# asserting on its own escaping bug instead of on the product.
json_string() { printf %s "$1" | bun -e 'process.stdout.write(JSON.stringify(await Bun.stdin.text()))'; }

set_bash_tool_spec() { # shell command, or "" to make the model answer with plain text
	if [ -z "$1" ]; then
		printf '{}\n' >"$SPEC"
		return
	fi
	printf '{"name":"bash","arguments":%s}\n' "$(json_string "{\"command\":$(json_string "$1")}")" >"$SPEC"
}

# The two calls every spend check replays. The secret one names a placeholder; the
# control is byte-identical in shape and names nothing, which is what makes a block
# attributable to the secret rather than to the approval tier.
SPENT_FILE="$(basename "$SPENT")"
SECRET_COMMAND="printf %s '#${NAME_PROFILE}#' | sha256sum | cut -c1-64 > ./${SPENT_FILE}"
CONTROL_COMMAND="printf %s HARNESS_NOT_A_SECRET | sha256sum | cut -c1-64 > ./${SPENT_FILE}"
BOUNDARY_REASON="This call uses stored secret: ${NAME_PROFILE}."

# The wire log is append-only for the whole run, so the leak sweep at the end sees
# every byte veyyon ever sent a provider, and each spend drops a marker so a
# per-mode assertion can still read only its own slice. Truncating between spends
# would give the per-mode rows their scope and leave the sweep inspecting one turn.
spend() { # tag, approval mode, command, extra veyyon args…
	local tag="$1" mode="$2" command="$3"
	shift 3
	rm -f "$SPENT"
	printf 'HARNESS-MARK %s\n' "$tag" >>"$WIRE"
	set_bash_tool_spec "$command"
	vey "$tag" --approval-mode "$mode" "$@" -p "spend the credential"
	awk -v mark="HARNESS-MARK ${tag}" 'index($0, mark) == 1 { keep = 1; next } keep' "$WIRE" >"$WIRE_SLICE"
}

# What the tool actually received, as a digest. Never the value: a digest cannot
# leak a credential into this report, and comparing digests answers the only
# question that matters — real value, or untouched placeholder.
spent_digest() { tr -d '[:space:]' <"$SPENT" 2>/dev/null; }

printf '\n=== veyyon /secret container harness ===\n'
printf 'veyyon    %s\n' "$(cd "$PROJECT" && veyyon --version 2>/dev/null | tail -1)"
printf 'HOME      %s\n' "$HOME_DIR"
printf 'agent dir %s\n' "$AGENT_DIR"
printf 'project   %s\n\n' "$PROJECT"

# `--shell` stops here, with the mock provider up, `models.yml` pointed at it and
# an empty vault: the exact state every check below starts from. Diagnosing one of
# these rows means reproducing it by hand at that point, and without this the only
# way in is to retype the whole setup and hope it matches. Anything after `--shell`
# is handed to bash, so `--shell probe.sh` and `--shell -c '…'` both work; with
# `docker run -it` and nothing after it, you get a prompt.
if [ "${1:-}" = "--shell" ]; then
	shift
	printf 'ready for manual use — try: veyyon --model %s -p "/secret list"\n\n' "$MODEL"
	exec bash "$@"
fi

# ---------------------------------------------------------------------------
# 1. Isolation
# ---------------------------------------------------------------------------
printf -- '-- isolation --\n'
case "$AGENT_DIR" in
"$HOME_DIR"/*) pass "isolation/agent-dir-inside-container-home" ;;
*) fail "isolation/agent-dir-inside-container-home" "agent dir ${AGENT_DIR} is not under ${HOME_DIR}" ;;
esac

vey empty-list -p "/secret list"
expect_contains "$LAST_OUT" "No active secrets. Nothing is being substituted right now." "isolation/vault-starts-empty"
FOREIGN="$(foreign_placeholders "$LAST_OUT")"
if [ -z "$FOREIGN" ]; then
	pass "isolation/empty-vault-names-no-real-secret"
else
	fail "isolation/empty-vault-names-no-real-secret" "a stored name was visible before this run stored anything: $(printf '%s' "$FOREIGN" | tr '\n' ' ')"
fi

# ---------------------------------------------------------------------------
# 2. Store from an environment variable
# ---------------------------------------------------------------------------
printf -- '\n-- store --\n'
vey add-profile -p "/secret add ${NAME_PROFILE} --from-env HARNESS_SEED_A --ttl 30d --scope profile"
expect_contains "$LAST_OUT" "Stored ${NAME_PROFILE} in the profile vault" "add/confirmation-names-the-vault"
expect_contains "$LAST_OUT" "The model sees #${NAME_PROFILE}# and never the value." "add/confirmation-names-the-placeholder"
expect_absent "$LAST_OUT" "$HARNESS_SEED_A" "add/confirmation-never-shows-the-value"
expect_absent "$LAST_ERR" "$HARNESS_SEED_A" "add/stderr-never-shows-the-value"

# The first add promises the enable is "saved for the next one". Two rows, because
# the promise and its consequence fail separately and only the second one bites: a
# fresh process reading the setting, and a fresh process actually spending the
# placeholder. With protection off, `#NAME#` is not substituted at all — the shell
# receives the literal token, silently, which is the dead end the auto-enable exists
# to prevent.
if grep -qF "saved for the next one" "$WORK/add-profile.out"; then
	veyc enabled-probe config get secrets.enabled
	expect_eq "$(tr -d '[:space:]' <"$LAST_OUT")" "true" "add/persists-protection-for-the-next-session"
else
	fail "add/persists-protection-for-the-next-session" "the first add never announced enabling protection at all"
fi

spend spend-before-workaround yolo "$SECRET_COMMAND"
expect_eq "$(spent_digest)" "$DIGEST_A" "add/next-process-actually-substitutes-the-placeholder"

# Workaround for the two rows above, so every later row measures the secret flow and
# not the lost setting. Named rather than hidden: if the defect is fixed this becomes
# a no-op and nothing else changes.
veyc enable-workaround config set secrets.enabled true

vey add-project -p "/secret add ${NAME_PROJECT} --from-env HARNESS_SEED_B --ttl 30d --scope project"
expect_contains "$LAST_OUT" "Stored ${NAME_PROJECT} in the project vault" "add/project-scope-stores"
vey add-global -p "/secret add ${NAME_GLOBAL} --from-env HARNESS_SEED_C --ttl 30d --scope global"
expect_contains "$LAST_OUT" "Stored ${NAME_GLOBAL} in the global vault" "add/global-scope-stores"

vey add-missing-env -p "/secret add HNOPE1 --from-env HARNESS_NOT_SET_ANYWHERE"
expect_contains "$LAST_ERR" "is not set in this process" "add/missing-env-var-says-why"

# ---------------------------------------------------------------------------
# 3. `/secret list`
# ---------------------------------------------------------------------------
printf -- '\n-- list --\n'
vey list -p "/secret list"
LIST="$LAST_OUT"
expect_contains "$LIST" "3 active secrets." "list/counts-every-scope"
expect_contains "$LIST" "PLACEHOLDER" "list/renders-a-header-row"

for scope_pair in "${NAME_GLOBAL}:global" "${NAME_PROFILE}:profile" "${NAME_PROJECT}:project"; do
	name="${scope_pair%%:*}"
	scope="${scope_pair##*:}"
	if grep -qE "^  #${name}# +${scope} +" "$LIST"; then
		pass "list/row-for-${name}-says-${scope}"
	else
		fail "list/row-for-${name}-says-${scope}" "no aligned row matched '#${name}#  ${scope}'"
	fi
done

# Alignment, asserted as a property rather than a golden string: split every table
# line on runs of two or more spaces (the gutter) and require the SCOPE and
# EXPIRES cells to begin at the same column on the header and on all three rows.
# A single-space-separated cell value like "30d left" survives this split, which a
# whitespace-token split would not.
TABLE_SHAPE="$(grep -E '^  (PLACEHOLDER|#)' "$LIST" | awk -F'  +' '{ print NF, index($0,$3), index($0,$4) }' | sort -u)"
TABLE_ROWS="$(grep -cE '^  (PLACEHOLDER|#)' "$LIST")"
expect_eq "$TABLE_ROWS" "4" "list/table-has-a-header-and-one-row-per-secret"
if [ "$(printf '%s\n' "$TABLE_SHAPE" | wc -l)" = "1" ] && [ "${TABLE_SHAPE%% *}" = "4" ]; then
	pass "list/table-columns-are-aligned"
else
	fail "list/table-columns-are-aligned" "column starts differ across rows: $(printf '%s' "$TABLE_SHAPE" | tr '\n' '|')"
fi

sweep "list/never-shows-a-value" "$LIST"

# ---------------------------------------------------------------------------
# 4. Spending a placeholder, per approval mode
# ---------------------------------------------------------------------------
printf -- '\n-- spend --\n'
for mode in "${YOLO_MODES[@]}"; do
	spend "spend-${mode}" "$mode" "$SECRET_COMMAND"
	expect_eq "$(spent_digest)" "$DIGEST_A" "spend/${mode}-tool-receives-the-real-credential"
	expect_absent "$WIRE_SLICE" "$BOUNDARY_REASON" "spend/${mode}-boundary-does-not-ask"
done

for mode in "${NON_YOLO_MODES[@]}"; do
	spend "spend-${mode}" "$mode" "$SECRET_COMMAND"
	if [ -f "$SPENT" ]; then
		fail "spend/${mode}-boundary-blocks-the-call" "the tool ran and spent the credential without approval"
	else
		pass "spend/${mode}-boundary-blocks-the-call"
	fi
	expect_contains "$WIRE_SLICE" "$BOUNDARY_REASON" "spend/${mode}-refusal-names-the-secret"
	expect_absent "$WIRE_SLICE" "$HARNESS_SEED_A" "spend/${mode}-refusal-carries-no-value"

	spend "control-${mode}" "$mode" "$CONTROL_COMMAND"
	if [ -f "$SPENT" ]; then
		pass "spend/${mode}-identical-call-without-a-secret-runs"
	else
		fail "spend/${mode}-identical-call-without-a-secret-runs" "the control was blocked too, so the block is not attributable to the secret"
	fi
done

# ---------------------------------------------------------------------------
# 5. Revocation
# ---------------------------------------------------------------------------
printf -- '\n-- revoke --\n'
vey rm-unknown -p "/secret rm HGONE1"
expect_contains "$LAST_ERR" "Run /secret list to see what is." "rm/unknown-name-says-how-to-recover"

vey rm -p "/secret rm ${NAME_PROFILE}"
expect_contains "$LAST_OUT" "Removed ${NAME_PROFILE} from the profile vault." "rm/confirmation-names-the-vault"

vey list-after-rm -p "/secret list"
expect_absent "$LAST_OUT" "#${NAME_PROFILE}#" "rm/name-disappears-from-list"

spend spend-after-rm yolo "$SECRET_COMMAND"
expect_eq "$(spent_digest)" "$DIGEST_LITERAL" "rm/placeholder-is-no-longer-substituted"

# ---------------------------------------------------------------------------
# 6. The TUI, under a real PTY
#
# `script -qec` and never tmux: AGENTS.md forbids tmux for verification, and both
# claims here are about what a terminal actually shows, which is exactly what tmux
# distorts. Two launches, because the first one is its own finding: the crash below
# only happens when the interactive-only files under the agent directory do not
# exist yet, so it is reachable exactly once per machine and a harness that opened
# the TUI a second time would never see it.
# ---------------------------------------------------------------------------
printf -- '\n-- tui (pty) --\n'
PTY_NAME=HPTY1
PTY_TYPED="harness-typed-in-the-masked-field"
SEEDS+=("$PTY_TYPED")
printf '{}\n' >"$SPEC"

run_tui() { # tag, then delay/keystroke pairs
	local tag="$1"
	shift
	PTY_LOG="$WORK/${tag}.pty"
	CAPTURES+=("$PTY_LOG")
	{
		while [ "$#" -ge 2 ]; do
			sleep "$1"
			printf '%s\r' "$2"
			shift 2
		done
		sleep 4
	} | (cd "$PROJECT" && script -qec "veyyon --model ${MODEL}" /dev/null) >"$PTY_LOG" 2>&1
}

# The first interactive launch on this machine, with a non-empty vault. Nothing is
# typed: the point is whether veyyon survives its own startup. `assertFreshForExpansion`
# runs on every transcript render as soon as an obfuscator exists, and startup
# creates `history.db`, `terminal-sessions/` and `last-changelog-version` inside the
# same directory the profile vault lives in — which `vaultRevision` fingerprints by
# parent-directory stat, so the revision moves under the session that just captured it.
run_tui tui-first-launch 9 "/quit"
if [ -s "$PTY_LOG" ]; then
	pass "tui/launches-under-a-pty"
else
	fail "tui/launches-under-a-pty" "the PTY capture is empty"
fi
expect_absent "$PTY_LOG" "Secret expansion was refused" "tui/first-launch-with-a-stored-secret-survives-startup"
expect_contains "$PTY_LOG" "ask anything" "tui/first-launch-reaches-the-prompt"

# Masked entry, on a launch that is past the startup crash above. This is the one
# claim print mode cannot reach: the value is typed into a terminal, so only a
# terminal can show whether it was echoed.
run_tui tui-masked 9 "/secret add ${PTY_NAME}" 4 "$PTY_TYPED" 3 "/secret list" 4 "/quit"
expect_contains "$PTY_LOG" "Paste the value for ${PTY_NAME}." "tui/masked-prompt-names-the-secret"
expect_absent "$PTY_LOG" "$PTY_TYPED" "tui/masked-field-never-echoes-what-was-typed"
expect_contains "$PTY_LOG" "PLACEHOLDER" "tui/list-renders-the-table"
expect_contains "$PTY_LOG" "#${PTY_NAME}#" "tui/list-shows-the-name-added-in-the-tui"

vey list-after-tui -p "/secret list"
expect_contains "$LAST_OUT" "#${PTY_NAME}#" "tui/add-is-durable-across-processes"

# ---------------------------------------------------------------------------
# 7. Leak sweep
# ---------------------------------------------------------------------------
printf -- '\n-- leaks --\n'
sweep "leak/provider-never-receives-a-value" "$WIRE"
sweep "leak/session-transcripts-never-store-a-value" "$AGENT_DIR/sessions"
sweep "leak/logs-and-audit-never-store-a-value" "$HOME_DIR/.veyyon"
sweep "leak/pty-captures-never-show-a-value" "$WORK/tui-first-launch.pty" "$WORK/tui-masked.pty"

# `--mode json` is the machine-readable headless surface: the one most likely to be
# piped into a file, a CI log, or another program. Its own row, next to the same
# turn rendered as text, because that pairing is what makes the result actionable —
# if both leaked it would be an argument about whether display deobfuscation is
# intended, and one clean renderer settles it.
vey add-back -p "/secret add ${NAME_PROFILE} --from-env HARNESS_SEED_A --ttl 30d --scope profile"
spend json-spend yolo "$SECRET_COMMAND" --mode json
expect_eq "$(spent_digest)" "$DIGEST_A" "leak/json-mode-still-substitutes-the-placeholder"
sweep "leak/json-event-stream-never-prints-a-value" "$WORK/json-spend.out"
spend text-spend yolo "$SECRET_COMMAND"
sweep "leak/text-print-mode-never-prints-a-value" "$WORK/text-spend.out"

# Names the fields rather than the fact, so the row above is a bug report instead of
# a boolean. Paths only — `leak-paths.ts` never echoes what it matched.
LEAK_PATHS="$(HARNESS_SEED="$HARNESS_SEED_A" bun "$BIN_DIR/leak-paths.ts" "$WORK/json-spend.out")"
if [ -n "$LEAK_PATHS" ]; then
	printf '      json event fields carrying the value:\n'
	printf '        %s\n' $LEAK_PATHS
fi

# ---------------------------------------------------------------------------
# 8. Foreign-name guard
#
# Last, so it sees every byte the run produced, the append-only wire log included:
# a foreign name reaching a provider is the worst version of this failure. Any
# placeholder token outside the seeded set means either a real vault leaked into
# this container or one was minted from the environment — both make every count and
# alignment assertion above meaningless, so the run must not be allowed to pass.
# ---------------------------------------------------------------------------
printf -- '\n-- guard --\n'
FOREIGN="$(foreign_placeholders "${CAPTURES[@]}" "$WIRE")"
if [ -z "$FOREIGN" ]; then
	pass "guard/no-foreign-secret-names"
else
	fail "guard/no-foreign-secret-names" "placeholder tokens this run never seeded: $(printf '%s' "$FOREIGN" | tr '\n' ' ')"
fi

# ---------------------------------------------------------------------------
printf -- '\n=== %d checks, %d failed ===\n' "$CHECKS" "$FAILURES"
[ "$FAILURES" -eq 0 ] || exit 1
