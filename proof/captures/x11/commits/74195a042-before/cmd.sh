cd /repo
bun test ./packages/tui/test/chrome-taller-than-the-viewport-never-reaches-native-scrollback.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=before ref=74195a042^"
touch /tmp/scene-done
sleep 99999
