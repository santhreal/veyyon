cd /repo
bun test ./packages/coding-agent/test/modes/components/a-transcript-divider-marks-a-point-instead-of-spanning-the-viewport.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=after ref=23504cc4d"
touch /tmp/scene-done
sleep 99999
