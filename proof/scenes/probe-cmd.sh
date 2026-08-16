#!/usr/bin/env bash
exec 2>/out/probe.err
set -x
tty
stty raw -echo
printf '\033[?1000h\033[?1002h\033[?1003h\033[?1006h'
timeout 12 stdbuf -o0 cat -v > /out/mouse-probe.txt
printf '\033[?1003l\033[?1002l\033[?1000l\033[?1006l'
stty sane
sleep 2
