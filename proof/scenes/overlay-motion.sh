#!/usr/bin/env bash
# Overlay motion on the shared animation clock.
#
# Every card in the app opens through ModalRevealDriver + applyModalReveal, so
# driving three overlays back to back records the one seam. Recorded at 60fps:
# the enter preset runs 220ms, so the unfold is thirteen frames and the page's
# filmstrips are cut out of this video by proof/filmstrip.py. A still taken from
# inside the scene cannot catch it -- `import` alone costs longer than the
# animation -- so the scene only takes settled stills and leaves the motion to
# the recording.
settle 18
shot idle

# Marker beeps are not available, so each overlay is opened after a full second
# of a still screen. That quiet stretch is what the frame-difference pass keys
# on when it looks for the moment the card arrives.
sleep 1
submit "/settings"
settle 3
shot settings-settled
sleep 1
k Escape
settle 3
shot settings-closed

sleep 1
submit "/hotkeys"
settle 3
shot hotkeys-settled
sleep 1
k Escape
settle 2

sleep 1
submit "/model"
settle 4
shot model-settled
# The model list is the one card body whose rows answer the pointer: glide down
# it so the band tracks the cursor instead of appearing under it.
glide 10 40 16 40 14 0.06
shot model-hover
sleep 1
k Escape
settle 3
shot back-to-transcript
