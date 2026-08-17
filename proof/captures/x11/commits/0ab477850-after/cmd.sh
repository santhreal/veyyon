cd /repo
bun test ./packages/coding-agent/test/modes/components/a-settings-category-fades-under-the-pointer.test.ts ./packages/coding-agent/test/modes/controllers/a-closed-settings-card-lets-go-of-the-clock.test.ts ./packages/tui/test/a-category-tab-fades-in-under-the-pointer.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=after ref=0ab477850"
touch /tmp/scene-done
sleep 99999
