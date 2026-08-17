cd /repo
bun test ./packages/coding-agent/test/modes/components/an-elided-thinking-fence-says-how-much-it-hid.test.ts ./packages/coding-agent/test/modes/components/prose-only-thinking.test.ts ./packages/coding-agent/test/streaming-reveal.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=after ref=3e8038714"
touch /tmp/scene-done
sleep 99999
