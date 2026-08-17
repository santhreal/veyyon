cd /repo
bun test ./packages/coding-agent/test/a-fading-hover-band-is-mixed-out-of-the-ground.test.ts ./packages/tui/test/a-hover-band-fades-in-instead-of-switching.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=before ref=c823e9828^"
touch /tmp/scene-done
sleep 99999
