cd /repo
bun test ./packages/coding-agent/test/modes/components/the-mcp-add-wizard-card-answers-the-pointer.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=before ref=1f2ea74b3^"
touch /tmp/scene-done
sleep 99999
