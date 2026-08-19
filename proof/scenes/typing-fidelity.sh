#!/usr/bin/env bash
# Prove the recorder types what the scene asked for, byte for byte.
#
# WHY THIS EXISTS. Two takes were lost to xdotool doubling characters: a submit of
# "/secret from-env RELEASE_SIGNATURE release-signature" reached the composer as
# "//seccrret frroomm-env RELEASE_SIGNATURE release-signature", which is a slash command
# the app rejects, so twenty minutes of recording ended with its signing segment missing.
# The mechanism is X autorepeat, not typing speed: xdotool synthesises a press and a
# release per character, a client busy repainting processes the release late, and X
# repeats the key. `xsession.sh` turns repeat off. This scene is what proves it stayed off.
#
# WHAT IT CLOSES, AND WHAT IT DOES NOT. It covers the class -- any typed string arriving
# with inserted characters -- rather than the one string that broke, by comparing several
# shapes against what the shell received. It cannot observe the app's composer, because a
# scene has no way to read the screen; what it can observe is the same X input path at the
# same rate, so a repeat that the display would deliver to the app is delivered here too.
# A doubling that only ever happens under the app's repaint load would pass this and
# still break a take: the take's own secret frames remain the last check.
#
# It runs in a login shell (SCENE_COMMAND=bash -l) and needs no model.
TYPE_DELAY="${TYPE_DELAY:-24}"

# THE MUTATION SWITCH. A gate nobody has watched fail is an assumption, so this puts the
# defect back: repeat on, and a repeat delay short enough that a late release becomes a
# duplicate character. Run the scene with SCENE_TYPING_REPEAT=on and it must go red. It
# is a deliberate opt-in and never fires during a recording.
if [ "${SCENE_TYPING_REPEAT:-off}" = "on" ]; then
	xset r on
	xset r rate 25 40
fi

settle 4

# One line per shape that has broken or could: a slash command with arguments, a long
# prose line, repeated characters where a dropped release is invisible by eye, and the
# punctuation a shell would mangle if a character were inserted into it.
PROBES=(
	"/secret from-env RELEASE_SIGNATURE release-signature"
	"read src/parser.ts and tell me in one sentence what it rejects"
	"aaabbbcccdddeeefffggghhhiiijjjkkklllmmm"
	"sign your work: run one bash command that pipes the placeholder into sha256sum"
)

PASS=0
FAIL=0
: >"${SCENE_OUT}/typing-fidelity.txt"

index=0
for probe in "${PROBES[@]}"; do
	index=$((index + 1))
	target="/tmp/typed-${index}.txt"
	# printf rather than echo: the file then holds exactly the bytes the shell received,
	# with no trailing newline to explain away a difference.
	submit "printf '%s' '${probe}' > ${target}"
	sleep 2
	got="$(cat "${target}" 2>/dev/null || true)"
	if [ "${got}" = "${probe}" ]; then
		PASS=$((PASS + 1))
		printf 'ok %d: %s\n' "${index}" "${probe}" >>"${SCENE_OUT}/typing-fidelity.txt"
	else
		FAIL=$((FAIL + 1))
		{
			printf 'FAIL %d\n' "${index}"
			printf '  asked: %s\n' "${probe}"
			printf '  typed: %s\n' "${got}"
		} >>"${SCENE_OUT}/typing-fidelity.txt"
	fi
done

shot typed

printf 'typing fidelity: %d ok, %d failed, delay %sms\n' "${PASS}" "${FAIL}" "${TYPE_DELAY}" \
	>>"${SCENE_OUT}/typing-fidelity.txt"
cat "${SCENE_OUT}/typing-fidelity.txt"

# A scene that fails silently is worse than no scene: the run has to be red.
[ "${FAIL}" -eq 0 ] || exit 1
