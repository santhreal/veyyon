cd /repo
bun scripts/demos/render-setup-wizard.ts 2>&1 | head -44
echo
echo "--- command finished, arm=before ref=08ec85de5^"
touch /tmp/scene-done
sleep 99999
