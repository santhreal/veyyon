"""Contracts for the generated agent provider routing (`src/agent_models.py`).

veybot generates `~/.veyyon/agent/models.yml` from `VEYBOT_LLM_*` rather than
requiring a hand-written host file bind-mounted into the container. These tests
lock the properties that made that replacement safe, because every one of them
fails silently in production if it regresses: a wrong-shaped document makes the
agent fall back to some other routing and quietly talk to the wrong provider,
and a leaked credential is unrecoverable once the file is on disk.
"""

from __future__ import annotations

import os
import stat
from pathlib import Path

import pytest
import yaml

from veybot.agent_models import (
    LLM_API_KEY_ENV,
    render_models_config,
    render_models_yaml,
    write_agent_models_config,
)
from veybot.config import Settings


def _settings(**overrides: str) -> Settings:
    """Build a real `Settings`, as production does.

    Deliberately not a stub: `extra="forbid"` and the field aliases are part of
    the contract under test, so a typo'd alias must fail here too. Every field
    these tests read is passed explicitly rather than inherited from the
    developer's environment, so the assertions cannot flip on someone who has
    `VEYBOT_MODEL` exported.
    """
    values = {
        "GITHUB_WEBHOOK_SECRET": "s3cret",
        "GITHUB_TOKEN": "ghp_test",
        "VEYBOT_BOT_LOGIN": "veybot",
        "VEYBOT_GIT_AUTHOR_EMAIL": "veybot@example.invalid",
        "VEYBOT_MODEL": "gemini-3.6-flash-medium",
        "VEYBOT_LLM_BASE_URL": "http://llm-gateway.internal:4000/v1",
        "VEYBOT_LLM_API_KEY": "sk-live-do-not-leak",
        "VEYBOT_LLM_API": "openai-completions",
        "VEYBOT_LLM_PROVIDER_ID": "veybot-gateway",
        **overrides,
    }
    return Settings(**values)  # type: ignore[arg-type]


class TestRoutingOwnership:
    """Whether veybot owns the file at all is a deliberate, documented choice."""

    def test_empty_base_url_means_veybot_does_not_manage_routing(self):
        """An unset gateway URL yields None, not an empty or half-built document.

        A native run on a developer machine uses the operator's own veyyon
        profile. Emitting a providers block with an empty baseUrl there would
        overwrite working routing with an unusable one.
        """
        assert render_models_config(_settings(VEYBOT_LLM_BASE_URL="")) is None
        assert render_models_yaml(_settings(VEYBOT_LLM_BASE_URL="")) is None

    def test_whitespace_only_base_url_is_treated_as_unset(self):
        """`VEYBOT_LLM_BASE_URL="   "` must not produce a provider with a blank URL."""
        assert render_models_config(_settings(VEYBOT_LLM_BASE_URL="   ")) is None

    def test_write_returns_none_and_creates_nothing_when_unmanaged(self, tmp_path: Path):
        """Unmanaged routing must not leave a stray file that shadows the real one."""
        assert write_agent_models_config(_settings(VEYBOT_LLM_BASE_URL=""), tmp_path) is None
        assert not (tmp_path / ".veyyon" / "agent" / "models.yml").exists()


class TestDocumentShape:
    """The document must match the schema veyyon's model registry actually reads."""

    def test_provider_block_carries_the_four_fields_veyyon_requires(self):
        """baseUrl/api/apiKey/models under `providers.<id>` is the schema.

        Anything else loads as a provider with no models and the agent cannot
        resolve VEYBOT_MODEL at all.
        """
        doc = render_models_config(_settings())
        assert set(doc) == {"providers"}
        block = doc["providers"]["veybot-gateway"]
        assert block["baseUrl"] == "http://llm-gateway.internal:4000/v1"
        assert block["api"] == "openai-completions"
        assert block["models"] == [{"id": "gemini-3.6-flash-medium", "name": "gemini-3.6-flash-medium"}]

    def test_provider_id_is_configurable(self):
        """The block is keyed by VEYBOT_LLM_PROVIDER_ID, not a hardcoded name."""
        doc = render_models_config(_settings(VEYBOT_LLM_PROVIDER_ID="acme"))
        assert list(doc["providers"]) == ["acme"]

    def test_api_is_configurable_for_a_gateway_speaking_another_protocol(self):
        doc = render_models_config(_settings(VEYBOT_LLM_API="anthropic-messages"))
        assert doc["providers"]["veybot-gateway"]["api"] == "anthropic-messages"

    def test_rendered_yaml_parses_back_to_the_same_document(self):
        """The serialized bytes are what veyyon reads, so round-trip is the contract."""
        settings = _settings()
        assert yaml.safe_load(render_models_yaml(settings)) == render_models_config(settings)

    def test_rendered_yaml_says_it_is_generated(self):
        """A hand-edit is silently destroyed on next launch; the file must warn."""
        text = render_models_yaml(_settings())
        assert text.startswith("#")
        assert "overwritten" in text


class TestCredentialNeverTouchesDisk:
    """The whole reason the apiKey field holds a variable name."""

    def test_apikey_field_is_the_env_var_name_not_the_secret(self):
        """veyyon resolves an apiKey from the environment before treating it as a literal.

        Writing the name keeps the credential in the process env, which the
        agent needs anyway, instead of persisting it in a world-readable file.
        """
        doc = render_models_config(_settings())
        assert doc["providers"]["veybot-gateway"]["apiKey"] == LLM_API_KEY_ENV

    def test_secret_value_appears_nowhere_in_the_rendered_file(self, tmp_path: Path):
        """The negative control: the real secret must not survive into the bytes."""
        settings = _settings(VEYBOT_LLM_API_KEY="sk-live-do-not-leak")
        written = write_agent_models_config(settings, tmp_path)
        assert "sk-live-do-not-leak" not in written.read_text(encoding="utf-8")


class TestModelPool:
    """The published ids have to be the ids VEYBOT_MODEL will ask for."""

    def test_every_pool_entry_is_published(self):
        """A pragma may switch to any sibling in the pool mid-run.

        If only the first entry were published, that switch would fail to
        resolve at the moment it is used rather than at startup.
        """
        doc = render_models_config(_settings(VEYBOT_MODEL="a-model,b-model, c-model"))
        assert [m["id"] for m in doc["providers"]["veybot-gateway"]["models"]] == [
            "a-model",
            "b-model",
            "c-model",
        ]

    def test_own_provider_prefix_is_stripped(self):
        """A provider block keys entries by the BARE id.

        Left in, `veybot-gateway/x` published as `veybot-gateway/veybot-gateway/x`
        and never resolved.
        """
        doc = render_models_config(_settings(VEYBOT_MODEL="veybot-gateway/gemini-3.6-flash-medium"))
        assert doc["providers"]["veybot-gateway"]["models"] == [
            {"id": "gemini-3.6-flash-medium", "name": "gemini-3.6-flash-medium"}
        ]

    def test_another_providers_prefix_is_left_alone(self):
        """`anthropic/claude-x` addresses a provider veybot does not generate.

        Rewriting it would silently re-point that request at the gateway, which
        is a wrong answer dressed as a helpful one.
        """
        doc = render_models_config(
            _settings(VEYBOT_MODEL="anthropic/claude-sonnet-4-6", VEYBOT_LLM_PROVIDER_ID="veybot-gateway")
        )
        assert doc["providers"]["veybot-gateway"]["models"] == [
            {"id": "anthropic/claude-sonnet-4-6", "name": "anthropic/claude-sonnet-4-6"}
        ]

    def test_duplicate_pool_entries_collapse(self):
        """`x,veybot-gateway/x` is one model; two identical ids is an invalid block."""
        doc = render_models_config(_settings(VEYBOT_MODEL="x,veybot-gateway/x"))
        assert doc["providers"]["veybot-gateway"]["models"] == [{"id": "x", "name": "x"}]


class TestWrittenFile:
    """Where it lands and who can read it."""

    def test_written_to_the_path_the_agent_reads(self, tmp_path: Path):
        """HOME is /srv/agent-home for the agent subprocess, so this is the path."""
        written = write_agent_models_config(_settings(), tmp_path)
        assert written == tmp_path / ".veyyon" / "agent" / "models.yml"
        assert yaml.safe_load(written.read_text(encoding="utf-8"))["providers"]

    def test_parent_directories_are_created(self, tmp_path: Path):
        """A fresh container has no ~/.veyyon/agent; the write must not need one."""
        assert write_agent_models_config(_settings(), tmp_path / "fresh").is_file()

    def test_file_is_readable_by_the_slot_user(self, tmp_path: Path):
        """The agent runs as an unprivileged slot user, not as the writer.

        Mode 0644 is what makes it readable there; safe only because the
        credential is a variable name.
        """
        written = write_agent_models_config(_settings(), tmp_path)
        assert stat.S_IMODE(written.stat().st_mode) == 0o644

    def test_regenerating_replaces_stale_routing(self, tmp_path: Path):
        """A VEYBOT_MODEL change must not leave the previous pool behind.

        The file is written on every agent launch precisely so an operator
        editing .env cannot end up with the agent routing to a model the pool
        no longer contains.
        """
        write_agent_models_config(_settings(VEYBOT_MODEL="old-model"), tmp_path)
        written = write_agent_models_config(_settings(VEYBOT_MODEL="new-model"), tmp_path)
        text = written.read_text(encoding="utf-8")
        assert "new-model" in text
        assert "old-model" not in text

    def test_unwritable_target_raises_instead_of_misrouting(self, tmp_path: Path):
        """Failing loud beats a run that silently uses whatever routing it finds."""
        if os.geteuid() == 0:
            pytest.skip("root ignores directory permissions")
        locked = tmp_path / "locked"
        locked.mkdir(mode=0o500)
        with pytest.raises(OSError):
            write_agent_models_config(_settings(), locked)
