cd /repo
bun test ./packages/tui/test/component-render.test.ts ./packages/tui/test/scroll-isolation-history.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=before ref=247ae5792^"
touch /tmp/scene-done
sleep 99999
