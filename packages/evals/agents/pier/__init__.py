import sys
from pathlib import Path

_pier_dir = str(Path(__file__).resolve().parent)
if _pier_dir not in sys.path:
    sys.path.insert(0, _pier_dir)
