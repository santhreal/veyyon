cd /repo
bun test ./packages/coding-agent/test/a-dismissed-overlay-plays-out-before-it-leaves.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=before ref=3cd9362a9^"
touch /tmp/scene-done
sleep 99999
