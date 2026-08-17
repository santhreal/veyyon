cd /repo
bun test ./packages/coding-agent/test/modes/components/plugin-settings-view-transitions.test.ts ./packages/coding-agent/test/modes/components/the-plugins-tab-answers-the-pointer.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=before ref=36df196c3^"
touch /tmp/scene-done
sleep 99999
