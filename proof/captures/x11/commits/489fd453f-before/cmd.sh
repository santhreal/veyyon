cd /repo
bun test ./packages/tui/test/a-click-on-a-suggestion-accepts-the-completion.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=before ref=489fd453f^"
touch /tmp/scene-done
sleep 99999
