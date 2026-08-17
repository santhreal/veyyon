cd /repo
bun test ./packages/coding-agent/test/modes/components/assistant-prose-carries-the-text-color.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=after ref=aa2d62dc7"
touch /tmp/scene-done
sleep 99999
