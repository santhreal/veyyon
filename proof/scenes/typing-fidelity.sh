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

# THE STALE-INPUT PROBE, which is a different defect from doubling and cost the same take.
# A slash command whose Return the completion popup swallowed stayed on the input line, and
# the next submit was typed onto the end of it. Here the leftover is typed deliberately and
# never submitted; the following submit must arrive alone, because `submit` clears the line
# first. Without that clear the shell receives both and the file holds the concatenation.
t "leftover-that-was-never-submitted "
sleep 0.5
submit "printf '%s' 'clean' > /tmp/typed-stale.txt"
sleep 2
stale="$(cat /tmp/typed-stale.txt 2>/dev/null || true)"
if [ "${stale}" = "clean" ]; then
	PASS=$((PASS + 1))
	printf 'ok stale: a submit does not inherit unsubmitted text\n' >>"${SCENE_OUT}/typing-fidelity.txt"
else
	FAIL=$((FAIL + 1))
	{
		printf 'FAIL stale\n'
		printf '  asked: clean\n'
		printf '  typed: %s\n' "${stale}"
	} >>"${SCENE_OUT}/typing-fidelity.txt"
fi

# THE IDLE WAIT, in both directions. settle_idle replaced fixed sleeps because a fixed
# sleep publishes a half-streamed frame when it guesses low and a still screen when it
# guesses high. Two things have to be true of it, and only one of them is obvious: on a
# quiet screen it must return well before its ceiling, and on a screen that keeps changing
# it must return AT the ceiling rather than never. A wait that cannot end is worse than a
# wait that is too short, because it hangs a take that is otherwise fine.
idle_start="$(date +%s)"
settle_idle 30 2 2
idle_quiet=$(($(date +%s) - idle_start))
if [ "${idle_quiet}" -lt 20 ]; then
	PASS=$((PASS + 1))
	printf 'ok idle: a quiet screen settled in %ds, ceiling 30s\n' "${idle_quiet}" >>"${SCENE_OUT}/typing-fidelity.txt"
else
	FAIL=$((FAIL + 1))
	printf 'FAIL idle: a quiet screen took %ds of a 30s ceiling\n' "${idle_quiet}" >>"${SCENE_OUT}/typing-fidelity.txt"
fi

# A screen that never stops changing: a shell loop printing a line a second. The wait must
# come back at the ceiling.
submit "for i in \$(seq 1 40); do echo busy-\$i; sleep 1; done"
sleep 1
busy_start="$(date +%s)"
settle_idle 12 2 2
busy_waited=$(($(date +%s) - busy_start))
k ctrl+c
sleep 1
if [ "${busy_waited}" -ge 11 ] && [ "${busy_waited}" -le 24 ]; then
	PASS=$((PASS + 1))
	printf 'ok busy: a moving screen returned at the ceiling after %ds\n' "${busy_waited}" >>"${SCENE_OUT}/typing-fidelity.txt"
else
	FAIL=$((FAIL + 1))
	printf 'FAIL busy: a moving screen returned after %ds, ceiling 12s\n' "${busy_waited}" >>"${SCENE_OUT}/typing-fidelity.txt"
fi

shot typed

# The path matters as much as the count: five green probes through the xdotool fallback
# would be a different claim from five through the pty.
printf 'typing fidelity: %d ok, %d failed, path %s\n' "${PASS}" "${FAIL}" "${_typing_path:-unknown}" \
	>>"${SCENE_OUT}/typing-fidelity.txt"
cat "${SCENE_OUT}/typing-fidelity.txt"

# A scene that fails silently is worse than no scene: the run has to be red.
[ "${FAIL}" -eq 0 ] || exit 1
