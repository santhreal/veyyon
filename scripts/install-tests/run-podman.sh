#!/bin/sh
set -e

cd "$(dirname "$0")/../.."

echo "=== Testing binary build ==="
podman build -f scripts/install-tests/binary.dockerfile -t veyyon-test-binary .

echo ""
echo "=== Testing the manual build from a checkout ==="
podman build -f scripts/install-tests/source.dockerfile -t veyyon-test-source .

echo ""
echo "=== All tests passed ==="
