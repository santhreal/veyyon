cd /repo
bun test ./packages/coding-agent/test/modes/components/subagent-agents-surface.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=before ref=5ab98e6d6^"
touch /tmp/scene-done
sleep 99999
