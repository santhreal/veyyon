cd /repo
bun test ./packages/coding-agent/test/modes/components/a-pointer-band-fades-on-a-hand-painted-list.test.ts ./packages/coding-agent/test/modes/controllers/a-dismissed-picker-lets-go-of-the-clock.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=after ref=b30f10d2f"
touch /tmp/scene-done
sleep 99999
