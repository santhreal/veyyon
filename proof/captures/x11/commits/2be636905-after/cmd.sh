cd /repo
bun test ./packages/tui/test/a-scrolled-viewport-travels-through-the-rows-between.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=after ref=2be636905"
touch /tmp/scene-done
sleep 99999
