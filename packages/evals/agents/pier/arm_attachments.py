"""
Read the arm attachments the runner staged, without naming any of them.
Shared implementation lives in common.arm_attachments.
"""

from __future__ import annotations

from pathlib import Path
import sys

_agents_dir = str(Path(__file__).resolve().parents[1])
if _agents_dir not in sys.path:
    sys.path.insert(0, _agents_dir)

from common.arm_attachments import (
    DELIVERY_ENV_JSON,
    DELIVERY_RULES_DIR,
    MANIFEST_FILE,
    SUPPORTED_DELIVERIES,
    SUPPORTED_MANIFEST_VERSION,
    ArmAttachment,
    attachment_directories,
    environment_prefix,
    missing_attachment_files,
    parse_arm_attachments,
    read_arm_attachments,
    rules_setup_command,
)

__all__ = [
    "DELIVERY_ENV_JSON",
    "DELIVERY_RULES_DIR",
    "MANIFEST_FILE",
    "SUPPORTED_DELIVERIES",
    "SUPPORTED_MANIFEST_VERSION",
    "ArmAttachment",
    "attachment_directories",
    "environment_prefix",
    "missing_attachment_files",
    "parse_arm_attachments",
    "read_arm_attachments",
    "rules_setup_command",
]
