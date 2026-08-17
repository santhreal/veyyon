cd /repo
bun test ./packages/coding-agent/test/no-message-role-reaches-the-provider-uncounted.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=before ref=e7aaaea3c^"
touch /tmp/scene-done
sleep 99999
