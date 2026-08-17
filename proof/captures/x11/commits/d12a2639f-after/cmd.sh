cd /repo
bun scripts/demos/render-hook-selector.ts 2>&1 | head -44
echo
echo "--- command finished, arm=after ref=d12a2639f"
touch /tmp/scene-done
sleep 99999
