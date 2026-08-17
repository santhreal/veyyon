cd /repo
bun test ./packages/coding-agent/test/modal-shell.test.ts ./packages/tui/test/every-animation-in-the-terminal-shares-one-clock.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=after ref=ed8cd31b2"
touch /tmp/scene-done
sleep 99999
