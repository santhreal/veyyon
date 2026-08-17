cd /repo
bun test ./packages/coding-agent/test/secrets/the-masked-prompt-cannot-be-read-as-a-name-prompt.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=after ref=7184efa23"
touch /tmp/scene-done
sleep 99999
