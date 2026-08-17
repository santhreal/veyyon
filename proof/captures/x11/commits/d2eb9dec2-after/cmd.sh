cd /repo
bun test ./packages/tui/test/a-suggestion-popup-grows-instead-of-cutting-in.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=after ref=d2eb9dec2"
touch /tmp/scene-done
sleep 99999
