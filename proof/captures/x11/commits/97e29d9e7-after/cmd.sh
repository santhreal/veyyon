cd /repo
bun test ./packages/coding-agent/test/architecture/tools-reach-the-ui-only-to-draw.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=after ref=97e29d9e7"
touch /tmp/scene-done
sleep 99999
