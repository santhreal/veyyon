import sys
from pathlib import Path

_harbor_dir = str(Path(__file__).resolve().parent)
if _harbor_dir not in sys.path:
    sys.path.insert(0, _harbor_dir)
