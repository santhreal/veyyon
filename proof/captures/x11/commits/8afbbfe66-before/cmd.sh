cd /repo
bun test ./packages/coding-agent/test/an-effort-picker-offers-no-level-the-endpoint-never-declared.test.ts ./packages/coding-agent/test/every-effort-surface-offers-only-what-the-model-declares.test.ts ./packages/coding-agent/test/modes/components/any-model-effort-is-settable.test.ts ./packages/coding-agent/test/modes/components/every-settings-submenu-answers-the-pointer.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=before ref=8afbbfe66^"
touch /tmp/scene-done
sleep 99999
