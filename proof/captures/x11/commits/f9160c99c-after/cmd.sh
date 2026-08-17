cd /repo
bun test ./packages/coding-agent/test/modes/components/a-transcript-block-sits-on-the-rail.test.ts ./packages/coding-agent/test/modes/components/hook-editor-title-width.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=after ref=f9160c99c"
touch /tmp/scene-done
sleep 99999
