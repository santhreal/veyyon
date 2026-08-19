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
settle 20

slash "/secret --from-env VEYYON_DEMO_SECRET"
settle 3
submit "DEMO_API_TOKEN"
settle 4
shot stored

slash "/secret list"
settle 6
shot listed

submit "use bash with the DEMO_API_TOKEN placeholder to print only its byte length. After the tool returns, reply with the byte length and nothing else. Do not repeat the placeholder, the credential name, or the value."
settle 90
shot spent

slash "/secret log"
settle 8
shot logged
