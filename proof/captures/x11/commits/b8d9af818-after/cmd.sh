cd /repo
bun test ./packages/ai/test/thinking-loop.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=after ref=b8d9af818"
touch /tmp/scene-done
sleep 99999
