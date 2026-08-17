cd /repo
bun scripts/demos/transcript-blanking-repro.ts 2>&1 | head -44
echo
echo "--- command finished, arm=after ref=f5e0aad58"
touch /tmp/scene-done
sleep 99999
