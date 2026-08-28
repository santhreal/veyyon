#!/usr/bin/env bash
# TerminalBench Task #1: ytt-jsonpath-query-api
# Adds JSONPath Query / QueryOne engine to orderedmap and yttlibrary.
# Verified against Go test oracle suite.
set -euo pipefail

pause 1.5
shot idle

# 1. Enable yolo mode
slash "/yolo"
pause 0.5
k Return
pause 0.5

# 2. Submit task prompt
submit "Read TASK.md and implement the JSONPath Query and QueryOne engine for orderedmap and yttlibrary. Run the test suite (go test ./pkg/orderedmap/... ./pkg/yttlibrary/...) to verify all query selectors and syntax errors pass."

# 3. Wait for model execution to complete
settle_idle 240 8 3 25
shot task-execution

wheel_up 6
pause 1.5
shot scrolled
