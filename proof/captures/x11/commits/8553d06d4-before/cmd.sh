cd /repo
bun test ./packages/coding-agent/test/modes/components/a-transcript-under-a-header-does-not-rebuild-the-screen.test.ts ./packages/coding-agent/test/modes/components/a-virtualized-transcript-never-loses-history-to-a-rebuild.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=before ref=8553d06d4^"
touch /tmp/scene-done
sleep 99999
