cd /repo
bun test ./packages/simulations/src/paint-sim/a-turn-that-ends-short-never-paints-a-blank-band-over-the-conversation.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=after ref=161922a84"
touch /tmp/scene-done
sleep 99999
