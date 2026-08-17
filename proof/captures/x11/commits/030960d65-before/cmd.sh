cd /repo
{ bun test ./packages/simulations/src/paint-sim/a-streaming-answer-never-repaints-the-whole-screen.test.ts 2>&1 | tee /tmp/arm.log; clear; tail -32 /tmp/arm.log; }
echo
echo "--- command finished, arm=before ref=030960d65^"
touch /tmp/scene-done
sleep 99999
