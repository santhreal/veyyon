cd /repo
bun test ./packages/coding-agent/test/modes/components/subagent-agents-surface.test.ts ./packages/coding-agent/test/subagent-model-and-effort-have-one-owner.test.ts ./packages/coding-agent/test/task/subagent-settings.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=after ref=bbc96f153"
touch /tmp/scene-done
sleep 99999
