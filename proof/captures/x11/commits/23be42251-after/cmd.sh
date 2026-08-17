cd /repo
bun test ./packages/simulations/src/paint-sim/a-streaming-answer-never-repaints-the-whole-screen.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=after ref=23be42251"
touch /tmp/scene-done
sleep 99999
