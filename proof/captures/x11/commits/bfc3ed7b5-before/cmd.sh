cd /repo
bun test ./packages/coding-agent/test/modes/components/a-transcript-block-sits-on-the-rail.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=before ref=bfc3ed7b5^"
touch /tmp/scene-done
sleep 99999
