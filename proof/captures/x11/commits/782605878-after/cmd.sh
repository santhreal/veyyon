cd /repo
bun test ./packages/coding-agent/test/a-tool-block-hangs-its-output-on-a-rail-not-in-a-box.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=after ref=782605878"
touch /tmp/scene-done
sleep 99999
