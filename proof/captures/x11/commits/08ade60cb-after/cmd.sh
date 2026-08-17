cd /repo
bun test ./packages/coding-agent/test/modes/components/selector-overlays-answer-the-pointer.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=after ref=08ade60cb"
touch /tmp/scene-done
sleep 99999
