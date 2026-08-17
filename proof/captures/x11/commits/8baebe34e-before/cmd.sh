cd /repo
bun test ./packages/coding-agent/test/modes/controllers/a-taller-terminal-still-hugs-the-composer-to-the-bottom.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=before ref=8baebe34e^"
touch /tmp/scene-done
sleep 99999
