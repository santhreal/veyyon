#!/usr/bin/env bash
# Prints a markdown table comparing two desktop bench reports probe by probe.
#
#   scripts/desktop-bench/compare.sh <a.json> <b.json>
#
# The ratio column is the median of b over the median of a.
set -euo pipefail

if [ $# -ne 2 ]; then
	printf 'usage: %s <a.json> <b.json>\n' "$0" >&2
	exit 2
fi

exec python3 - "$1" "$2" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
	a = json.load(handle)
with open(sys.argv[2], encoding="utf-8") as handle:
	b = json.load(handle)


def cell(value):
	return "n/a" if value is None else f"{value:g}"


names = list(a["probes"])
names += [name for name in b["probes"] if name not in names]
print(f"| probe | unit | {a['name']} median | {a['name']} p95 | {b['name']} median | {b['name']} p95 | {b['name']}/{a['name']} |")
print("|---|---|---:|---:|---:|---:|---:|")
for name in names:
	pa = a["probes"].get(name)
	pb = b["probes"].get(name)
	unit = (pa or pb)["unit"]
	ma = pa["median"] if pa else None
	mb = pb["median"] if pb else None
	ratio = f"{mb / ma:.2f}" if ma and mb is not None else "n/a"
	print(
		f"| {name} | {unit} | {cell(ma)} | {cell(pa['p95'] if pa else None)} | "
		f"{cell(mb)} | {cell(pb['p95'] if pb else None)} | {ratio} |"
	)
for report in (a, b):
	for name, reason in report.get("failed", {}).items():
		print(f"\n{report['name']} {name} did not run: {reason}")
PY
