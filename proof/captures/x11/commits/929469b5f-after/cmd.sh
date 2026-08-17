cd /repo
bun test ./packages/coding-agent/test/hook-editor.test.ts ./packages/coding-agent/test/modes/components/the-hook-dialogs-answer-the-pointer.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=after ref=929469b5f"
touch /tmp/scene-done
sleep 99999
