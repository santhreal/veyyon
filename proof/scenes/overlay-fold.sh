#!/usr/bin/env bash
# A card opens and a card closes, both on the one animation clock.
#
# The close is the half `main` does not have: there the card is gone between two
# frames. Recorded at 60fps because both curves run 220ms, so the frames have to
# be cut out of the video afterwards -- a still taken from inside the scene lands
# after the motion every time.
#
# The stills are only anchors for the eye; the evidence is the filmstrip.
settle 18
shot idle

submit "/settings"
settle 3
shot settings-open

# The dismissal. Nothing else moves on screen, so this is the frame-difference
# peak the filmstrip cutter finds.
k Escape
sleep 1.6
shot settings-closed
sleep 1.2

submit "/model"
settle 3
shot model-open

k Escape
sleep 1.6
shot model-closed
sleep 1.4
