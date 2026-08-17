cd /repo
bun test ./packages/coding-agent/test/modes/components/a-clicked-composer-chip-runs-its-action.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=after ref=b373c7c55"
touch /tmp/scene-done
sleep 99999
