cd /repo
bun test ./packages/coding-agent/test/a-band-is-mixed-out-of-the-ground-the-terminal-is-showing.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=before ref=929eabeac^"
touch /tmp/scene-done
sleep 99999
