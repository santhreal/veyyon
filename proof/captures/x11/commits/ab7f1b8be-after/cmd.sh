cd /repo
bun test ./packages/coding-agent/test/modes/components/the-transcript-card-answers-the-pointer.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=after ref=ab7f1b8be"
touch /tmp/scene-done
sleep 99999
