#!/usr/bin/env bash
# Does the shell the terminal started actually run what a scene types at it?
#
# Diagnostic, not a gallery row. The install row recorded four command lines that
# appeared on screen and produced no output at all, with two of them carrying doubled
# characters ("veyyonn", "$HHOME"), so this scene types three short commands whose
# output is unmistakable and keeps the terminal's own log and the bootstrap's stderr
# next to the video.
settle 6
shot before

submit "echo shell-alive-\$\$"
settle 4
shot alive

submit "stty size; id -un; pwd"
settle 4
shot facts

submit "printf 'abcdefghij\\n'"
settle 4
shot typed

cp /tmp/term.log /tmp/boot.err /tmp/geom "${SCENE_OUT}/" 2>/dev/null || true
