cd /repo
bun test ./packages/coding-agent/test/a-context-gauge-travels-to-its-new-reading.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=after ref=10b6c2dfb"
touch /tmp/scene-done
sleep 99999
