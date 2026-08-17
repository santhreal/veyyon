cd /repo
bun test ./packages/coding-agent/test/modes/components/a-clicked-composer-chip-runs-its-action.test.ts ./packages/tui/test/a-footer-click-target-holds-the-mouse-in-a-session-that-never-scrolls.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=after ref=2645becbd"
touch /tmp/scene-done
sleep 99999
