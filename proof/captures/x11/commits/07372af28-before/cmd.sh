cd /repo
bun test ./packages/coding-agent/src/modes/components/__tests__/pause-screen.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=before ref=07372af28^"
touch /tmp/scene-done
sleep 99999
