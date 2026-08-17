cd /repo
bun test ./packages/coding-agent/test/modes/components/a-virtualized-transcript-never-loses-history-to-a-rebuild.test.ts ./packages/tui/test/component-render.test.ts ./packages/tui/test/scroll-isolation-history.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=after ref=c511ae76b"
touch /tmp/scene-done
sleep 99999
