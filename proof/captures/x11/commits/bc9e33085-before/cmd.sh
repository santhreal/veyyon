cd /repo
bun test ./packages/coding-agent/test/modes/components/a-transcript-divider-marks-a-point-instead-of-spanning-the-viewport.test.ts ./packages/coding-agent/test/modes/components/compaction-divider.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=before ref=bc9e33085^"
touch /tmp/scene-done
sleep 99999
