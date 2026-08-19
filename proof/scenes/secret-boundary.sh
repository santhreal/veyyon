#!/usr/bin/env bash
# A credential the model spends without ever seeing.
#
# The scene stores a value from the environment, so the value is never typed on a
# screen that is being recorded, then shows the three surfaces that make the
# boundary checkable: the placeholder listed by name, a bash turn where the model
# spends it and gets a byte count back, and the use log recording that spend by name
# rather than by value.
#
# The credential is a throwaway string the recorder passes in as VEYYON_DEMO_SECRET.
# Nothing about the container survives the run: HOME is a tmpfs, so the vault it
# writes is gone with it.
#
# `/secret` takes plain words and no options, so a leading `--` stores nothing and
# records the command's own help text instead. The name goes on the same line: a
# terminal will ask for one afterwards, but the line that omits it stores under an
# auto-generated `SECRET_1`, and the next thing submitted is then an ordinary chat
# turn, so the placeholder the scene goes on to spend does not exist.
#
# The spend turn names the command to run. Asked to "use bash to print the byte
# length", the model asked a clarifying question instead, which is reasonable and is
# not what the row claims: the claim is that a placeholder becomes a real value at the
# tool boundary and nowhere else. The byte count separates the two outcomes -- the
# stored value is 39 bytes and the placeholder text is 16, so an unsubstituted
# recording cannot pass for a substituted one.
settle 20

slash "/secret from-env VEYYON_DEMO_SECRET DEMO_API_TOKEN"
settle 6
shot stored

slash "/secret list"
settle 6
shot listed

submit "run exactly this with the bash tool: printf %s '#DEMO_API_TOKEN#' | wc -c. Then reply with the number it printed and nothing else."
settle 45
shot approval
# A call that spends a stored credential asks first, whatever the approval mode says:
# the card names the secret and shows the command the real value will run in. Nothing
# runs until it is confirmed. Return alone denied the call in one take, so the choice
# is made explicitly: Up lands on the first option, which is the one-time approval.
k Up
k Up
k Up
pause 0.5
k Return
settle 60
shot spent

slash "/secret log"
settle 8
shot logged
