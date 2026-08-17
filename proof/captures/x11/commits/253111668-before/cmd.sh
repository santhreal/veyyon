cd /repo
bun test ./packages/coding-agent/test/setup-wizard.test.ts ./packages/coding-agent/test/the-setup-wizard-footer-chips-answer-the-pointer.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=before ref=253111668^"
touch /tmp/scene-done
sleep 99999
