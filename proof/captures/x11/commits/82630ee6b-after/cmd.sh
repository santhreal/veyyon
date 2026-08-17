cd /repo
bun test ./packages/coding-agent/test/modes/components/a-pointer-band-fades-on-a-hand-painted-list.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=after ref=82630ee6b"
touch /tmp/scene-done
sleep 99999
