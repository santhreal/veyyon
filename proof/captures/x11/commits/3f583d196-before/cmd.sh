cd /repo
bun test ./packages/coding-agent/test/hook-editor.test.ts ./packages/coding-agent/test/hook-selector-overflow.test.ts ./packages/coding-agent/test/modes/components/session-selector-mouse.test.ts ./packages/coding-agent/test/modes/components/the-hook-selector-answers-the-pointer.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=before ref=3f583d196^"
touch /tmp/scene-done
sleep 99999
