cd /repo
bun test ./packages/coding-agent/test/modes/components/a-cut-short-batch-ledger-renders-as-one-marker-line.test.ts 2>&1 | tail -32
echo
echo "--- command finished, arm=before ref=b852f2543^"
touch /tmp/scene-done
sleep 99999
