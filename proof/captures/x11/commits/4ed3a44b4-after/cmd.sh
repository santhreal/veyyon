cd /repo
bun test ./packages/coding-agent/test/keybindings-selector-navigation.test.ts ./packages/coding-agent/test/modes/components/the-session-tree-card-answers-the-pointer.test.ts ./packages/coding-agent/test/modes/components/tree-selector-chain-gutter-2298.test.ts ./packages/coding-agent/test/modes/components/tree-selector-developer.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=after ref=4ed3a44b4"
touch /tmp/scene-done
sleep 99999
