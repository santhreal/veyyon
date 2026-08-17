cd /repo
bun scripts/demos/transcript-blanking-repro.ts 2>&1 | head -44
echo
echo "--- command finished, arm=before ref=9beabe14a^"
touch /tmp/scene-done
sleep 99999
