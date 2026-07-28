"""
Marks `scripts/` as a Python package so its modules can import each other.

Empty on purpose and there is nothing to run here. `analyze_small_edits.py`
imports `tool_io` and `edit-benchmark.py` imports `edit_benchmark_common`, and
both do it by module name; without this file those imports resolve only when the
interpreter happens to be started from inside this directory.

Run: nothing. There is no command here, and that is the point of the file.
"""
