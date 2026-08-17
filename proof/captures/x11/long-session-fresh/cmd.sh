cd /sandbox/home/demo
export SESSION_BYTES=0
export SESSION_MESSAGES=0
start=$(date +%s.%N)
script -qc "bun /repo/packages/coding-agent/src/cli.ts " /tmp/pty.raw
export WALL_SECONDS=$(python3 -c "print(round($(date +%s.%N) - ${start}, 1))")
python3 /repo/proof/docker/pty-stats.py /tmp/pty.raw "long-session-fresh" | tee /out/pty-stats.txt
cp /tmp/pty.raw /out/pty.raw
touch /tmp/scene-done
sleep 99999
