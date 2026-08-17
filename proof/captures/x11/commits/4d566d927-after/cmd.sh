cd /repo
bun test ./packages/agent/test/a-chatgpt-oauth-session-compacts-on-the-codex-backend.test.ts ./packages/agent/test/compaction-remote.test.ts ./packages/catalog/test/server-compaction-capability.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=after ref=4d566d927"
touch /tmp/scene-done
sleep 99999
