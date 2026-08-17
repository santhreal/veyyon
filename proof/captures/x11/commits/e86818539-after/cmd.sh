cd /repo
bun test ./packages/coding-agent/test/modes/components/subagent-agents-surface.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=after ref=e86818539"
touch /tmp/scene-done
sleep 99999
