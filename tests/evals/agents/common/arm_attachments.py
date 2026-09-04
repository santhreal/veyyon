"""
Loading treatment-arm attachments from the runner-staged assets directory.

WHY THIS EXISTS. An arm may carry prompt overrides, rules, skills, or dictionary
assets that must be staged into the container BEFORE the agent runs. The runner
writes an `attachments.json` manifest describing every staged asset, its target
delivery mode, and which arm it belongs to.

This module is the container-side reader: pure JSON and path parsing, fail-closed
on any discrepancy, with no dependencies beyond the standard library.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import re
import shlex
from typing import Any

MANIFEST_FILE = "attachments.json"

# The one manifest shape this reader understands. An assets directory outlives the run
# that wrote it and is hashed into that run's provenance, so a later shape change must be
# a refusal here rather than a misread: a stale directory staged by an older runner is a
# stale treatment.
SUPPORTED_MANIFEST_VERSION = 1

DELIVERY_ENV_JSON = "env-json"
DELIVERY_RULES_DIR = "rules-dir"
SUPPORTED_DELIVERIES = (DELIVERY_ENV_JSON, DELIVERY_RULES_DIR)

# An env var name and a staged path are both interpolated into a shell command, so both
# are constrained to what the runner can legitimately emit. A name that is not a name, or
# a path that leaves the assets directory, is a broken or hostile manifest, not something
# to pass through to `sh -c`.
_ENV_VAR_NAME = re.compile(r"\A[A-Z][A-Z0-9_]*\Z")


@dataclass(frozen=True)
class ArmAttachment:
    """One staged file, and how it reaches the agent."""

    kind: str
    """The semantic kind: `prompts`, `rules`, `skills`, `dictionaries`."""

    file: str
    """Path relative to the assets directory, e.g. `prompts/candidate.json`."""

    delivery: str
    """How the file is handed to veyyon: `env-json` or `rules-dir`."""

    env_var: str | None = None
    """The variable an `env-json` attachment rides; `None` for any other delivery."""


def parse_arm_attachments(manifest_text: str, arm_name: str) -> tuple[ArmAttachment, ...]:
    """
    The attachments the manifest lists for one arm, in the order the runner staged them.

    An empty tuple means the arm carries nothing, which is the ordinary case for a
    baseline. An arm the manifest does not mention is a different fact -- the runner never
    staged for it -- and raises, because that arm would otherwise run as an unlabelled
    control under a treatment's name.
    """
    try:
        manifest = json.loads(manifest_text)
    except json.JSONDecodeError as err:
        raise ValueError(f"{MANIFEST_FILE} is not valid JSON: {err}") from err
    if not isinstance(manifest, dict):
        raise ValueError(f"{MANIFEST_FILE} must be an object, got {type(manifest).__name__}")
    version = manifest.get("version")
    if version != SUPPORTED_MANIFEST_VERSION:
        raise ValueError(
            f"{MANIFEST_FILE} has version {version!r}, this agent reads "
            f"version {SUPPORTED_MANIFEST_VERSION}. The assets directory was staged by a "
            f"different runner; re-stage it with the runner from this checkout."
        )
    arms = manifest.get("arms")
    if not isinstance(arms, dict):
        raise ValueError(f"{MANIFEST_FILE} 'arms' must be an object, got {type(arms).__name__}")
    if arm_name not in arms:
        raise ValueError(
            f"{MANIFEST_FILE} does not name arm {arm_name!r} (it names: "
            f"{', '.join(sorted(arms)) or 'nothing'}). The runner stages an entry for every "
            f"arm it runs, so this assets directory was not staged for this arm."
        )
    entries = arms[arm_name]
    if not isinstance(entries, list):
        raise ValueError(
            f"{MANIFEST_FILE} arm {arm_name!r} must hold a list, got {type(entries).__name__}"
        )
    return tuple(_parse_entry(entry, arm_name) for entry in entries)


def _parse_entry(entry: Any, arm_name: str) -> ArmAttachment:
    if not isinstance(entry, dict):
        raise ValueError(
            f"{MANIFEST_FILE} arm {arm_name!r} has an entry that is not an object: {entry!r}"
        )
    kind = entry.get("kind")
    file = entry.get("file")
    delivery = entry.get("delivery")
    for label, value in (("kind", kind), ("file", file), ("delivery", delivery)):
        if not isinstance(value, str) or not value:
            raise ValueError(
                f"{MANIFEST_FILE} arm {arm_name!r} entry is missing a usable {label!r}: {entry!r}"
            )
    if delivery not in SUPPORTED_DELIVERIES:
        raise ValueError(
            f"{MANIFEST_FILE} arm {arm_name!r} attachment {kind!r} has delivery {delivery!r}, "
            f"this agent handles {', '.join(SUPPORTED_DELIVERIES)}. A delivery this agent "
            f"cannot perform would drop the attachment silently."
        )
    _require_contained(file, arm_name, kind)
    env_var = entry.get("envVar")
    if delivery == DELIVERY_ENV_JSON:
        if not isinstance(env_var, str) or not _ENV_VAR_NAME.match(env_var):
            raise ValueError(
                f"{MANIFEST_FILE} arm {arm_name!r} attachment {kind!r} is delivered as "
                f"{DELIVERY_ENV_JSON} but names no usable environment variable: {env_var!r}"
            )
    elif env_var is not None:
        raise ValueError(
            f"{MANIFEST_FILE} arm {arm_name!r} attachment {kind!r} is delivered as "
            f"{delivery!r} and cannot also name an environment variable ({env_var!r})"
        )
    return ArmAttachment(kind=kind, file=file, delivery=delivery, env_var=env_var)


def _require_contained(file: str, arm_name: str, kind: str) -> None:
    """Refuse a staged path that is absolute or climbs out of the assets directory."""
    parts = file.replace("\\", "/").split("/")
    if file.startswith("/") or ":" in parts[0] or ".." in parts:
        raise ValueError(
            f"{MANIFEST_FILE} arm {arm_name!r} attachment {kind!r} names a path outside the "
            f"assets directory: {file!r}"
        )


def read_arm_attachments(assets_dir: Path, arm_name: str) -> tuple[ArmAttachment, ...]:
    """
    The arm's attachments, read from the assets directory the runner staged.

    An absent manifest is a refusal, not an empty result: it means the directory was
    staged by a runner from before the manifest existed, so what it holds and how each
    file is delivered are both unknown, and an attachment read by guesswork is the class
    of defect this module closes.
    """
    manifest = assets_dir / MANIFEST_FILE
    try:
        text = manifest.read_text(encoding="utf-8")
    except FileNotFoundError as err:
        raise ValueError(
            f"veyyon asset missing on host: {manifest}. The runner writes it for every run, "
            f"so this assets directory is stale; re-stage it."
        ) from err
    return parse_arm_attachments(text, arm_name)


def missing_attachment_files(
    attachments: tuple[ArmAttachment, ...], assets_dir: Path
) -> tuple[str, ...]:
    """The manifest entries whose staged file is not on the host, checked before upload."""
    return tuple(
        attachment.file
        for attachment in attachments
        if not (assets_dir / attachment.file).is_file()
    )


def attachment_directories(attachments: tuple[ArmAttachment, ...], container_dir: str) -> tuple[str, ...]:
    """The container directories the uploads need, deduplicated, parents first."""
    directories: list[str] = []
    for attachment in attachments:
        parent = f"{container_dir}/{attachment.file}".rsplit("/", 1)[0]
        if parent not in directories:
            directories.append(parent)
    return tuple(directories)


def environment_prefix(attachments: tuple[ArmAttachment, ...], container_dir: str) -> str:
    """
    The `VAR="$(cat file)" ` prefix that scopes every env-json attachment to one command.

    Scoped to the command rather than exported, so the override exists for the veyyon
    process and nothing else, and read through `$(cat ...)` so the JSON reaches the
    process verbatim -- braces, quotes and newlines -- with no shell re-parsing of its
    content.
    """
    parts = [
        f'{attachment.env_var}="$(cat {shlex.quote(f"{container_dir}/{attachment.file}")})" '
        for attachment in attachments
        if attachment.delivery == DELIVERY_ENV_JSON
    ]
    return "".join(parts)


def rules_setup_command(attachments: tuple[ArmAttachment, ...], container_dir: str) -> str:
    """
    The ` && ...` fragment that installs every rules-dir attachment as an always-apply rule.

    Each file is copied by name rather than with a glob: a glob would also copy whatever
    else happened to be staged in that directory, which is how an arm inherits another
    arm's treatment.
    """
    fragments = ""
    for attachment in attachments:
        if attachment.delivery != DELIVERY_RULES_DIR:
            continue
        source = shlex.quote(f"{container_dir}/{attachment.file}")
        fragments += f" && mkdir -p ~/.veyyon/rules && cp {source} ~/.veyyon/rules/"
    return fragments
