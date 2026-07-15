#!/usr/bin/env python3
"""R1/R2 rebrand: @oh-my-pi -> @veyyon, brand constants, config dir, CLI bin."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

SKIP_DIRS = {
    ".git",
    "node_modules",
    "target",
    "dist",
    ".turbo",
    "coverage",
}

SKIP_FILES = {
    "bun.lock",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
}

BINARY_SUFFIXES = {
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".woff",
    ".woff2",
    ".ttf",
    ".eot",
    ".mp3",
    ".mp4",
    ".zip",
    ".gz",
    ".bz2",
    ".xz",
    ".7z",
    ".pdf",
    ".node",
    ".so",
    ".dylib",
    ".dll",
    ".exe",
    ".wasm",
    ".bin",
}

TEXT_SUFFIXES = {
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".json",
    ".md",
    ".yml",
    ".yaml",
    ".toml",
    ".sh",
    ".ps1",
    ".py",
    ".rs",
    ".dockerfile",
    ".html",
    ".css",
    ".svg",
    ".txt",
    ".patch",
    ".nix",
    ".rb",
    ".go",
    ".sql",
    ".env.example",
    ".gitignore",
    ".gitattributes",
    ".editorconfig",
    ".biomejson",
}

# Files where CHANGELOG issue/provenance links stay as-is for git history context.
CHANGELOG_SKIP_CONTENT_REPLACE = False


def is_text_file(path: Path) -> bool:
    if path.name in SKIP_FILES:
        return False
    if path.suffix in BINARY_SUFFIXES:
        return False
    if path.suffix in TEXT_SUFFIXES:
        return True
    if path.suffix == "" and path.name not in SKIP_FILES:
        # extensionless scripts (Dockerfile, Makefile fragments)
        if path.name.lower() in {"dockerfile", "makefile", "license"}:
            return True
    return path.suffix in {".ts", ".tsx", ".js", ".json", ".md"}


def should_skip_dir(name: str) -> bool:
    return name in SKIP_DIRS


def replace_content(path: Path, content: str) -> str:
    rel = path.relative_to(ROOT).as_posix()
    original = content

    # R2: npm scope
    content = content.replace("@veyyon/", "@veyyon/")

    # Root package.json name/homepage handled separately; coding-agent bin handled separately.

    # R1: config dir string literals (not temp test prefixes like .omp-profile-test-)
    # Replace quoted ".veyyon" as path segment
    content = re.sub(r'(["\'])\.omp\1', r'\1.veyyon\1', content)
    # Replace ~/.veyyon and ~\.veyyon (windows)
    content = content.replace("~/.veyyon", "~/.veyyon")
    content = content.replace("~\\.omp", "~\\.veyyon")
    # XDG paths: $XDG_*_HOME/omp/
    content = re.sub(r"(\$XDG_[A-Z_]+_HOME)/omp/", r"\1/veyyon/", content)
    content = re.sub(r"(XDG_[A-Z_]+_HOME)/omp/", r"\1/veyyon/", content)

    # Product CLI command references in help-ish strings (careful: not omp:// protocol)
    if rel.endswith("package.json") and "coding-agent" in rel:
        content = content.replace('"omp": "src/cli.ts"', '"veyyon": "src/cli.ts"')

    if rel == "package.json":
        content = re.sub(r'"name"\s*:\s*"omp"', '"name": "veyyon"', content)
        content = content.replace('"homepage": "https://omp.sh"', '"homepage": "https://veyyon.dev"')

    if rel == "packages/coding-agent/package.json":
        content = content.replace('"homepage": "https://omp.sh"', '"homepage": "https://veyyon.dev"')

    # omp-command default CLI binary name
    if rel == "packages/coding-agent/src/task/omp-command.ts":
        content = content.replace(
            'process.platform === "win32" ? "omp.cmd" : "omp"',
            'process.platform === "win32" ? "veyyon.cmd" : "veyyon"',
        )

    # loader-state.js: XDG and homedir natives paths
    if rel == "packages/natives/native/loader-state.js":
        content = content.replace('path.join(xdgDataHome, "omp")', 'path.join(xdgDataHome, "veyyon")')
        content = content.replace('path.join(xdgDataHome, "omp", "natives")', 'path.join(xdgDataHome, "veyyon", "natives")')

    # report-tool-issue agent name
    if rel == "packages/coding-agent/src/tools/report-tool-issue.ts":
        content = content.replace('agent: { name: "omp", version: VERSION }', 'agent: { name: "veyyon", version: VERSION }')

    # dirs.ts constants (script may run before manual pass; idempotent)
    if rel == "packages/utils/src/dirs.ts":
        content = content.replace('export const APP_NAME: string = "omp";', 'export const APP_NAME: string = "veyyon";')
        content = content.replace('export const CONFIG_DIR_NAME: string = ".veyyon";', 'export const CONFIG_DIR_NAME: string = ".veyyon";')
        content = content.replace(
            'const PROFILE_ENV_KEYS = ["OMP_PROFILE", "PI_PROFILE"] as const;',
            'const PROFILE_ENV_KEYS = ["VEYYON_PROFILE", "OMP_PROFILE", "PI_PROFILE"] as const;',
        )
        content = content.replace("omp config migrate", "veyyon config migrate")
        content = content.replace("omp config init-xdg", "veyyon config init-xdg")
        content = content.replace("omp worktree", "veyyon worktree")
        content = content.replace("omp-plugins.lock.json", "veyyon-plugins.lock.json")
        content = content.replace("omp-crash.log", "veyyon-crash.log")
        content = content.replace('Invalid OMP profile', 'Invalid profile')
        # Comments: omp -> veyyon for config dir context
        content = content.replace("Centralized path helpers for omp config directories.", "Centralized path helpers for veyyon config directories.")
        content = content.replace('default ".veyyon"', 'default ".veyyon"')
        content = content.replace("$XDG_*_HOME/omp/", "$XDG_*_HOME/veyyon/")
        content = content.replace("— if the env var is set, omp trusts", "— if the env var is set, veyyon trusts")
        content = content.replace('App name (e.g. "omp")', 'App name (e.g. "veyyon")')
        content = content.replace('Config directory name (e.g. ".veyyon")', 'Config directory name (e.g. ".veyyon")')
        content = content.replace("Resolves and caches all omp directory paths", "Resolves and caches all veyyon directory paths")
        content = content.replace("/omp/sessions", "/veyyon/sessions")
        content = content.replace("/omp/cache/", "/veyyon/cache/")
        content = content.replace("/omp/python-gateway", "/veyyon/python-gateway")
        content = content.replace("concurrent omp", "concurrent veyyon")
        content = content.replace("launch `omp`", "launch `veyyon`")
        content = content.replace("whatever cwd happened to launch `omp`", "whatever cwd happened to launch `veyyon`")

    # env.ts: VEYYON_ mirroring
    if rel == "packages/utils/src/env.ts":
        content = content.replace(
            "\t// OMP_ overrides PI_\n\tfor (const k in result) {\n\t\tif (k.startsWith(\"OMP_\")) {\n\t\t\tresult[`PI_${k.slice(4)}`] = result[k];\n\t\t}\n\t}",
            "\t// VEYYON_ / OMP_ override PI_\n\tfor (const k in result) {\n\t\tif (k.startsWith(\"VEYYON_\")) {\n\t\t\tresult[`PI_${k.slice(7)}`] = result[k];\n\t\t} else if (k.startsWith(\"OMP_\")) {\n\t\t\tresult[`PI_${k.slice(4)}`] = result[k];\n\t\t}\n\t}",
        )

    return content if content != original else original


def update_package_json_names(path: Path) -> bool:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return False
    changed = False
    if isinstance(data.get("name"), str) and data["name"].startswith("@veyyon/"):
        data["name"] = data["name"].replace("@veyyon/", "@veyyon/", 1)
        changed = True
    if path.name == "package.json" and data.get("name") == "omp":
        data["name"] = "veyyon"
        changed = True
    if "homepage" in data and data["homepage"] == "https://omp.sh":
        data["homepage"] = "https://veyyon.dev"
        changed = True
    if "bin" in data and isinstance(data["bin"], dict) and "omp" in data["bin"] and "veyyon" not in data["bin"]:
        data["bin"]["veyyon"] = data["bin"].pop("omp")
        changed = True
    if changed:
        path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return changed


def update_root_catalog(path: Path) -> bool:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return False
    catalog = data.get("workspaces", {}).get("catalog")
    if not isinstance(catalog, dict):
        return False
    new_catalog = {}
    changed = False
    for key, value in catalog.items():
        new_key = key.replace("@veyyon/", "@veyyon/") if key.startswith("@veyyon/") else key
        if new_key != key:
            changed = True
        new_catalog[new_key] = value
    if changed:
        data["workspaces"]["catalog"] = new_catalog
        path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return changed


def main() -> int:
    changed_files: list[str] = []

    for path in sorted(ROOT.rglob("*")):
        if path.is_dir():
            continue
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        if not is_text_file(path):
            continue

        if path.name == "package.json":
            if update_package_json_names(path):
                changed_files.append(path.relative_to(ROOT).as_posix())

        if path == ROOT / "package.json":
            if update_root_catalog(path):
                if path.relative_to(ROOT).as_posix() not in changed_files:
                    changed_files.append(path.relative_to(ROOT).as_posix())

        try:
            content = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue

        new_content = replace_content(path, content)
        if new_content != content:
            path.write_text(new_content, encoding="utf-8")
            rel = path.relative_to(ROOT).as_posix()
            if rel not in changed_files:
                changed_files.append(rel)

    print(f"Changed {len(changed_files)} files")
    for f in changed_files[:50]:
        print(f"  {f}")
    if len(changed_files) > 50:
        print(f"  ... and {len(changed_files) - 50} more")
    return 0


if __name__ == "__main__":
    sys.exit(main())
