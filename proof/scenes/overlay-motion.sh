#!/usr/bin/env bash
# Overlay arrival and pointer tracking.
#
# Every card in the app opens through the modal shell, so driving three overlays
# back to back records the one seam. A card's first frame is its settled frame,
# so the stills below are the whole of what arrival looks like; the recording
# carries the pointer band tracking the cursor down the model list.
settle 18
shot idle

# Each overlay is opened after a full second of a still screen. That quiet
# stretch is what the frame-difference pass keys on when it looks for the moment
# the card arrives.
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
