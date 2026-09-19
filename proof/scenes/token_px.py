"""A surface token value is either a number or a scale name.

This module is the one place the name becomes a pixel measure.
"""

from functools import lru_cache
from pathlib import Path
import sys
import tomllib

__all__ = [
    "tokens_dir",
    "themes_dir",
    "load",
    "px",
    "value_of",
    "measure",
    "measure_of",
    "text_of",
]


def tokens_dir() -> Path:
    """Return the token directory derived from this module's file location."""
    return Path(__file__).resolve().parents[2] / "crates/veyyon-desktop-tokens/tokens"


def themes_dir() -> Path:
    """Return the theme directory beside the token directory."""
    return tokens_dir().parent / "themes"


@lru_cache(maxsize=None)
def load(name: str) -> dict:
    """Parse a token file by name, accepting relative and surface-relative paths."""
    base = tokens_dir()
    path = base / name
    if not path.is_file():
        path = base / "surface" / name
    if not path.is_file():
        path = base.parent / name
    if not path.is_file():
        raise FileNotFoundError(f"token file not found: {name}")
    return tomllib.loads(path.read_text())


def px(value) -> int:
    """Resolve a number or a scale, radius, or stroke name to an integer measure."""
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        scale = load("scale.toml")
        if value in scale.get("spacing", {}):
            return int(scale["spacing"][value])
        if value in scale.get("radius", {}):
            return int(scale["radius"][value])
        if value in scale.get("stroke", {}):
            return int(scale["stroke"][value])
        if value in scale.get("type", {}).get("size", {}):
            return int(scale["type"]["size"][value]["size"])
        if value in scale.get("type", {}).get("mono", {}):
            return int(scale["type"]["mono"][value]["size"])
        try:
            return int(value)
        except ValueError:
            pass
    raise KeyError(f"unknown token scale name: {value!r}")

def measure(value) -> float:
    """Resolve a number or a scale, radius, or stroke name to a float measure."""
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        scale = load("scale.toml")
        if value in scale.get("spacing", {}):
            return float(scale["spacing"][value])
        if value in scale.get("radius", {}):
            return float(scale["radius"][value])
        if value in scale.get("stroke", {}):
            return float(scale["stroke"][value])
        if value in scale.get("type", {}).get("size", {}):
            return float(scale["type"]["size"][value]["size"])
        if value in scale.get("type", {}).get("mono", {}):
            return float(scale["type"]["mono"][value]["size"])
        try:
            return float(value)
        except ValueError:
            pass
    raise KeyError(f"unknown token scale name: {value!r}")


def measure_of(file: str, dotted: str) -> float:
    """Load a token file, traverse the dotted key path, and resolve the value to a float."""
    data = load(file)
    curr = data
    for part in dotted.split("."):
        if not isinstance(curr, dict) or part not in curr:
            raise KeyError(f"token file {file!r} key {dotted!r} missing segment {part!r}")
        curr = curr[part]
    try:
        return measure(curr)
    except KeyError as err:
        raise KeyError(f"token file {file!r} key {dotted!r} has invalid value {curr!r}") from err



def value_of(file: str, dotted: str) -> int:
    """Load a token file, traverse the dotted key path, and resolve the value to an integer."""
    data = load(file)
    curr = data
    for part in dotted.split("."):
        if not isinstance(curr, dict) or part not in curr:
            raise KeyError(f"token file {file!r} key {dotted!r} missing segment {part!r}")
        curr = curr[part]
    try:
        return px(curr)
    except KeyError as err:
        raise KeyError(f"token file {file!r} key {dotted!r} has invalid value {curr!r}") from err


def text_of(file: str, dotted: str) -> str:
    """Load a token file, traverse the dotted key path, and return the string it states."""
    data = load(file)
    curr = data
    for part in dotted.split("."):
        if not isinstance(curr, dict) or part not in curr:
            raise KeyError(f"token file {file!r} key {dotted!r} missing segment {part!r}")
        curr = curr[part]
    if not isinstance(curr, str):
        raise KeyError(f"token file {file!r} key {dotted!r} states {curr!r} rather than text")
    return curr


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--resolve":
        print(value_of(sys.argv[2], sys.argv[3]))
    elif len(sys.argv) == 4 and sys.argv[1] == "--text":
        print(text_of(sys.argv[2], sys.argv[3]))
    elif len(sys.argv) == 4 and sys.argv[1] == "--measure":
        print(measure_of(sys.argv[2], sys.argv[3]))
    elif len(sys.argv) == 3 and sys.argv[1] == "--measure":
        print(measure(sys.argv[2]))
    elif len(sys.argv) == 2:
        print(px(sys.argv[1]))
    else:
        sys.exit(f"usage: {sys.argv[0]} [--resolve|--measure|--text] <file> <dotted>")
