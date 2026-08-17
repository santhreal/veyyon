cd /repo
bun test ./packages/tui/test/a-click-in-the-composer-places-the-caret.test.ts ./packages/tui/test/a-click-on-a-suggestion-accepts-the-completion.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=after ref=db946f360"
touch /tmp/scene-done
sleep 99999
