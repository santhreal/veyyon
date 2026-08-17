cd /repo
bun test ./packages/coding-agent/test/modes/components/a-pointer-band-fades-on-a-hand-painted-list.test.ts ./packages/coding-agent/test/modes/components/the-extensions-dashboard-fades-both-its-bands.test.ts ./packages/coding-agent/test/modes/components/the-model-cards-fade-every-band-they-own.test.ts ./packages/coding-agent/test/modes/controllers/a-closed-settings-card-lets-go-of-the-clock.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=before ref=05bd9d643^"
touch /tmp/scene-done
sleep 99999
