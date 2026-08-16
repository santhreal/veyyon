#!/usr/bin/env bash
# The composer's autocomplete popup arriving.
#
# It grows out of the composer instead of appearing at full height: the frame
# itself is short on the first frame and reaches its height over the curve, so the
# rows never slide past a border that is already where it ends up. The dismissal
# is deliberately instant -- a popup you have decided against should not linger --
# and the recording shows that asymmetry.
settle 18
shot idle

# A slash opens the command list.
t "/"
sleep 1.6
shot slash-popup

k BackSpace
sleep 1.0
shot slash-dismissed

# A filter narrows it, which is a second arrival of a shorter frame.
t "/mo"
sleep 1.6
shot slash-filtered
key_repeat BackSpace 3 0.12
sleep 1.0

# An at-sign opens the file list, off the real working tree the container seeded.
t "@"
sleep 1.8
shot at-popup

t "src/"
sleep 1.6
shot at-filtered

k Escape
sleep 1.2
shot at-dismissed
sleep 1.0
