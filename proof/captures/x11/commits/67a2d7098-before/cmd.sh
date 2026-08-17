cd /repo
bun test ./packages/tui/test/the-motion-clock-always-stops.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=before ref=67a2d7098^"
touch /tmp/scene-done
sleep 99999
