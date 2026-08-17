cd /repo
{ bun test ./packages/coding-agent/test/modes/components/the-login-card-answers-the-pointer.test.ts ./packages/coding-agent/test/modes/components/the-login-screen-is-one-frame.test.ts ./packages/coding-agent/test/modes/controllers/a-command-login-lands-in-the-account-manager.test.ts ./packages/coding-agent/test/modes/controllers/selector-controller-login.test.ts 2>&1 | tee /tmp/arm.log; clear; tail -32 /tmp/arm.log; }
echo
echo "--- command finished, arm=before ref=d4d2a4290^"
touch /tmp/scene-done
sleep 99999
