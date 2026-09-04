"""Contracts for the settings that let veybot service a project it was not built for.

veybot's toolchain steps used to be three hardcoded `bun` command tuples in
`host_tools.py`, which meant the bot could only ever service this workspace.
They are configuration now. Each test here defends one property of that move,
and several of them exist because the naive version of the change was wrong in
a way that would have been invisible in production.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from veybot import host_tools
from veybot.config import Settings, reset_settings_cache
from veybot.worker import _slot_extra_groups


def _bindings(repo_dir: Path, settings: object | None = None) -> SimpleNamespace:
    """Minimal duck-typed stand-in for the parts of `ToolBindings` these read."""
    return SimpleNamespace(workspace=SimpleNamespace(repo_dir=repo_dir), settings=settings)


def _repo(tmp_path: Path, *, files: dict[str, str] | None = None) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir(parents=True, exist_ok=True)
    for name, body in (files or {}).items():
        (repo / name).write_text(body, encoding="utf-8")
    return repo


# ── the `.env` file is authoritative ─────────────────────────────────────────


def test_unknown_key_in_env_file_is_rejected_and_named(tmp_path: Path, env: dict[str, str]) -> None:
    """A misspelled setting must stop startup, not silently do nothing.

    Under the previous `extra="ignore"` a typo like `VEYBOT_MAX_CONCURENCY=2`
    parsed cleanly and was discarded, so the operator read their `.env`, saw
    concurrency 2, and got the default 8 forever with nothing logged anywhere.
    That is the silent-fallback class of bug this project treats as a product
    failure. The error must also name the offending key, or the operator is left
    diffing a 60-line file by eye.
    """
    env_file = tmp_path / ".env"
    env_file.write_text("VEYBOT_MAX_CONCURENCY=2\n", encoding="utf-8")
    reset_settings_cache()
    with pytest.raises(ValidationError) as excinfo:
        Settings(_env_file=str(env_file))  # type: ignore[call-arg]
    # `case_sensitive=False` means pydantic echoes the key lowercased; what
    # matters is that the offending name appears at all.
    assert "veybot_max_concurency" in str(excinfo.value).lower()


def test_correctly_spelled_key_in_env_file_is_accepted(tmp_path: Path, env: dict[str, str]) -> None:
    """The negative twin: forbidding extras must not reject valid config.

    Without this, a test suite passes by rejecting everything.
    """
    env_file = tmp_path / ".env"
    env_file.write_text("VEYBOT_MAX_CONCURRENCY=2\n", encoding="utf-8")
    reset_settings_cache()
    cfg = Settings(_env_file=str(env_file))  # type: ignore[call-arg]
    assert cfg.max_concurrency == 2


def test_veyyon_root_is_a_declared_setting(env: dict[str, str]) -> None:
    """`VEYYON_ROOT` must be declared, not tolerated as an extra.

    It is the one key compose puts in `.env` that is not a `VEYBOT_*` name, and
    it is load-bearing: the `veyyon` shim in the image execs
    `$VEYYON_ROOT/packages/coding-agent/src/cli.ts`, so a wrong value means the
    agent cannot start at all. Declaring it is what keeps `extra="forbid"` from
    rejecting every real `.env`, and it puts the key in the documented surface.
    """
    cfg = Settings()  # type: ignore[call-arg]
    assert cfg.agent_source_root == Path("/work/veyyon")


# ── model selection ──────────────────────────────────────────────────────────


def test_model_default_is_the_deployed_model(monkeypatch: pytest.MonkeyPatch, env: dict[str, str]) -> None:
    """The model id lives in config and nowhere else.

    It used to appear only in README examples while the code defaulted to a
    different provider entirely, so the documented model and the running model
    disagreed. Thinking is `off` deliberately: this model carries its reasoning
    effort in the id, so a separate thinking level fights it.
    """
    # The shared `env` fixture pins a model of its own, so the declared
    # default is only observable once that override is removed.
    monkeypatch.delenv("VEYBOT_MODEL", raising=False)
    monkeypatch.delenv("VEYBOT_THINKING", raising=False)
    reset_settings_cache()
    cfg = Settings()  # type: ignore[call-arg]
    assert cfg.model == "gemini-3.6-flash-medium"
    assert cfg.thinking_level == "off"
    assert cfg.model_pool == ("gemini-3.6-flash-medium",)


def test_model_can_be_overridden_to_a_pool(monkeypatch: pytest.MonkeyPatch, env: dict[str, str]) -> None:
    """Anyone running their own veybot changes the model in their `.env`.

    Proves the default is a default and not a hardcode, and that the
    comma-separated pool form still parses.
    """
    monkeypatch.setenv("VEYBOT_MODEL", "anthropic/claude-sonnet-4-6, openai/gpt-5")
    reset_settings_cache()
    cfg = Settings()  # type: ignore[call-arg]
    assert cfg.model_pool == ("anthropic/claude-sonnet-4-6", "openai/gpt-5")
    assert cfg.pick_model() in cfg.model_pool


# ── command parsing ──────────────────────────────────────────────────────────


def test_commands_parse_with_shell_quoting(monkeypatch: pytest.MonkeyPatch, env: dict[str, str]) -> None:
    """A configured command is argv, not a shell string.

    It is handed to `subprocess.run` without a shell, so quoting has to be
    resolved here. Getting this wrong would split `--message "two words"` into
    two arguments and silently run a different command than the operator wrote.
    """
    monkeypatch.setenv("VEYBOT_PRE_PR_CHECK_COMMAND", "make check ARGS='-v --strict'")
    reset_settings_cache()
    cfg = Settings()  # type: ignore[call-arg]
    assert cfg.pre_pr_check_argv == ("make", "check", "ARGS=-v --strict")


def test_empty_command_disables_the_step(monkeypatch: pytest.MonkeyPatch, env: dict[str, str]) -> None:
    """Empty means disabled, and that has to be expressible.

    A project with no formatter needs a way to say so that is not "point it at
    /bin/true".
    """
    monkeypatch.setenv("VEYBOT_PRE_PR_FIX_COMMAND", "")
    monkeypatch.setenv("VEYBOT_WORKSPACE_BOOTSTRAP_COMMAND", "")
    reset_settings_cache()
    cfg = Settings()  # type: ignore[call-arg]
    assert cfg.pre_pr_fix_argv == ()
    assert cfg.workspace_bootstrap_argv == ()


def test_unparseable_command_fails_at_startup(monkeypatch: pytest.MonkeyPatch, env: dict[str, str]) -> None:
    """An unbalanced quote must fail on load, not hours later mid-task.

    `shlex.split("bun run 'fix")` raises. Without the validator that raise
    happens the moment the agent tries to publish, which is deep inside a task
    the operator is not watching, and it surfaces as a crash rather than as
    "your config is wrong". The error names the setting.
    """
    monkeypatch.setenv("VEYBOT_PRE_PR_FIX_COMMAND", "bun run 'fix")
    reset_settings_cache()
    with pytest.raises(ValidationError, match="not a parseable command line"):
        Settings()  # type: ignore[call-arg]


# ── which repos the toolchain applies to ─────────────────────────────────────


def test_bootstrap_runs_only_on_a_matching_project(tmp_path: Path) -> None:
    """Markers decide whether a repo is this veybot's kind of project.

    One veybot can serve an allowlist holding several repos. Running a bun
    install inside a Cargo checkout is worse than doing nothing, so a repo
    missing any marker is left alone. Every marker must be present, not any.
    """
    settings = SimpleNamespace(project_markers_raw="package.json,bun.lock")
    both = _repo(tmp_path / "both", files={"package.json": "{}", "bun.lock": ""})
    partial = _repo(tmp_path / "partial", files={"package.json": "{}"})
    neither = _repo(tmp_path / "neither", files={"Cargo.toml": ""})

    assert host_tools._project_matches(_bindings(both, settings))
    assert not host_tools._project_matches(_bindings(partial, settings))
    assert not host_tools._project_matches(_bindings(neither, settings))


def test_empty_markers_match_every_repo(tmp_path: Path) -> None:
    """Empty markers mean "every repo", so the gate can be opted out of."""
    settings = SimpleNamespace(project_markers_raw="")
    assert host_tools._project_matches(_bindings(_repo(tmp_path), settings))


def test_publish_gate_is_not_silently_skipped_by_markers(tmp_path: Path) -> None:
    """REGRESSION: the pre-publish gate must never be skipped for a marker miss.

    The first version of this change gated the fix/check steps on the same
    markers as the bootstrap. Because the markers include a lockfile, a repo
    carrying `package.json` with no `bun.lock` then skipped the gate ENTIRELY
    and silently, and veybot would push a bot PR having run no check at all.
    That is the exact outcome the gate exists to prevent, and nothing in the
    output would have said so.

    A gate may refuse, and it may be switched off deliberately in config, but it
    must never quietly not happen. So the publish steps deliberately do not
    consult the markers.
    """
    settings = SimpleNamespace(
        project_markers_raw="package.json,bun.lock",  # a marker the repo lacks
        pre_pr_check_command="bun check",
    )
    repo = _repo(tmp_path, files={"package.json": json.dumps({"scripts": {"check": "tsc"}})})
    assert not host_tools._project_matches(_bindings(repo, settings))
    assert host_tools._publish_step_argv(_bindings(repo, settings), "pre_pr_check_command") == ("bun", "check")


def test_publish_step_skipped_when_manifest_lacks_the_script(tmp_path: Path) -> None:
    """A missing optional script must not block every PR on a repo.

    `bun run fix` against a manifest with no `fix` script exits non-zero. For
    the check step a non-zero exit refuses the publish, so without this probe a
    repo that simply has no such script could never receive a bot PR.
    """
    settings = SimpleNamespace(project_markers_raw="", pre_pr_fix_command="bun run fix")
    repo = _repo(tmp_path, files={"package.json": json.dumps({"scripts": {"build": "tsc"}})})
    assert host_tools._publish_step_argv(_bindings(repo, settings), "pre_pr_fix_command") == ()


def test_publish_step_runs_when_manifest_declares_the_script(tmp_path: Path) -> None:
    """Negative twin of the probe: a declared script is invoked."""
    settings = SimpleNamespace(project_markers_raw="", pre_pr_fix_command="bun run fix")
    repo = _repo(tmp_path, files={"package.json": json.dumps({"scripts": {"fix": "biome check --write"}})})
    assert host_tools._publish_step_argv(_bindings(repo, settings), "pre_pr_fix_command") == ("bun", "run", "fix")


def test_non_javascript_runner_is_invoked_as_written(tmp_path: Path) -> None:
    """A cargo/make/just command must not be filtered by a package.json probe.

    The manifest probe is JS-shaped on purpose. If it engaged for every command
    shape, a Rust project configured with `cargo clippy` would be skipped for
    lack of a `package.json` and its PRs would go out ungated.
    """
    settings = SimpleNamespace(project_markers_raw="", pre_pr_check_command="cargo clippy --workspace")
    repo = _repo(tmp_path, files={"Cargo.toml": ""})
    argv = host_tools._publish_step_argv(_bindings(repo, settings), "pre_pr_check_command")
    assert argv == ("cargo", "clippy", "--workspace")


@pytest.mark.parametrize(
    ("argv", "expected"),
    [
        (("bun", "check"), "check"),  # bun's two-token shorthand
        (("bun", "run", "fix"), "fix"),  # explicit run form
        (("npm", "run", "lint"), "lint"),  # any JS runner
        (("cargo", "clippy"), None),  # not a script runner
        (("bun",), None),  # degenerate
        (("make", "check", "ARGS=-v"), None),  # `run` is not the second token
    ],
)
def test_manifest_script_name_recognises_only_runner_shapes(argv: tuple[str, ...], expected: str | None) -> None:
    """`bun check` names a package script; `cargo clippy` does not.

    The two-token bun shorthand has to be recognised separately or the default
    `bun check` reads as a bun builtin and skips the probe, which is the case
    that actually matters since `check` is a package script.
    """
    assert host_tools._named_manifest_script(argv) == expected


# ── defaults come from one place ─────────────────────────────────────────────


def test_defaults_fall_back_to_the_settings_declaration(tmp_path: Path) -> None:
    """Bindings without a `Settings` still resolve the declared default.

    `ToolBindings.settings` is optional. The fallback reads the default off the
    field declaration rather than repeating the command literals in
    `host_tools.py`, so `config.py` stays the single place any toolchain command
    is written down and the two cannot drift.
    """
    bindings = _bindings(_repo(tmp_path))
    assert host_tools._configured(bindings, "pre_pr_check_command") == Settings.model_fields[
        "pre_pr_check_command"
    ].default
    assert host_tools._configured_argv(bindings, "pre_pr_check_command") == ("bun", "check")


# ── slot group ───────────────────────────────────────────────────────────────


def test_slot_extra_group_comes_from_config() -> None:
    """The supplementary group names a group that must exist in the image.

    A different deployment builds a different image, and a hardcoded group name
    fails at process spawn: far from the config where it should have been
    declared, and only for slotted runs.
    """
    assert _slot_extra_groups(SimpleNamespace(slot_extra_group="veyyon"), 4001) == ["veyyon"]
    assert _slot_extra_groups(SimpleNamespace(slot_extra_group="  agents  "), 4001) == ["agents"]
    assert _slot_extra_groups(SimpleNamespace(slot_extra_group=""), 4001) is None


def test_no_supplementary_group_without_a_slot() -> None:
    """An unslotted run has no slot user, so it gets no supplementary group."""
    assert _slot_extra_groups(SimpleNamespace(slot_extra_group="veyyon"), None) is None
