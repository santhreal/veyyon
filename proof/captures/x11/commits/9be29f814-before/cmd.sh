cd /repo
bun test ./packages/coding-agent/test/modes/components/every-settings-submenu-answers-the-pointer.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=before ref=9be29f814^"
touch /tmp/scene-done
sleep 99999
