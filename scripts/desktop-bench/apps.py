"""The two apps under test: scratch homes, launch argv and environment.

`prepare(app, run_dir, llm_port, ...)` builds a scratch home under `run_dir`
holding the seeded corpus and a provider pointed at the fake LLM, and returns
the `Launch` the probes start. Neither app reads the operator's own config:
HOME, the XDG directories and CODEX_HOME all point into the run directory.

Both apps render on the render node the bench session uses. Vulkan (the
veyyon window's wgpu renderer) sees only the radeon ICD, and GL (Chromium's
GPU process) is pinned to Mesa on the same device; `procs.render_nodes`
reports which node each process opened, and the report records it.
"""

from __future__ import annotations

import json
import shutil
import sqlite3
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

import corpus
import seed
from procs import AppProcess

BENCH_DIR = Path(__file__).resolve().parent
REPO_ROOT = BENCH_DIR.parents[1]
DRM_PCI_TAG = "pci-0000_7a_00_0"

GPU_ENV = {
	"VK_ICD_FILENAMES": "/usr/share/vulkan/icd.d/radeon_icd.json",
	"__GLX_VENDOR_LIBRARY_NAME": "mesa",
	"__EGL_VENDOR_LIBRARY_FILENAMES": "/usr/share/glvnd/egl_vendor.d/50_mesa.json",
	"DRI_PRIME": DRM_PCI_TAG,
}


@dataclass
class Launch:
	app: str
	argv: list[str]
	env: dict[str, str]
	cwd: Path
	home: Path
	# Thread key -> the app's own identifier (session file, thread id).
	threads: dict[str, str] = field(default_factory=dict)

	def start(self, tag: str, log_path: Path) -> AppProcess:
		return AppProcess(self.argv, self.env, self.cwd, tag, log_path)


def _base_env(home: Path, display: str, runtime_dir: str, path_dirs: list[str]) -> dict[str, str]:
	return {
		"HOME": str(home),
		"USER": "bench",
		"LANG": "C.UTF-8",
		"LC_ALL": "C.UTF-8",
		"TZ": "UTC",
		"PATH": ":".join([*path_dirs, "/usr/bin", "/bin"]),
		"DISPLAY": display,
		"XDG_RUNTIME_DIR": runtime_dir,
		"XDG_CONFIG_HOME": str(home / ".config"),
		"XDG_CACHE_HOME": str(home / ".cache"),
		"XDG_DATA_HOME": str(home / ".local" / "share"),
		"XDG_STATE_HOME": str(home / ".local" / "state"),
		**GPU_ENV,
	}


# veyyon ---------------------------------------------------------------------

VEYYON_MODELS = """\
providers:
  bench:
    baseUrl: http://127.0.0.1:{port}/v1
    api: openai-completions
    apiKey: BENCH_LLM_KEY
    models:
      - id: {model}
        name: Bench model
        contextWindow: 200000
        maxTokens: 4096
"""

VEYYON_CONFIG = """\
onboardingVersion: 99
model: bench/{model}
"""


# The design-token and theme directories a pre-rebuild veyyon-desktop reads at
# start (`VEYYON_DESKTOP_TOKENS_DIR`, `VEYYON_DESKTOP_THEMES_DIR`). They are
# extracted from one git revision into the run directory, so the files a
# binary loads do not move while the tree it was built from is edited.
VEYYON_ASSET_DIRS = ("crates/veyyon-desktop-tokens/tokens", "crates/veyyon-desktop-tokens/themes")


def _extract_assets(run_dir: Path, revision: str) -> Path:
	out = run_dir / "veyyon" / "assets"
	out.mkdir(parents=True, exist_ok=True)
	archive = subprocess.run(
		["git", "-C", str(REPO_ROOT), "archive", "--format=tar", revision, *VEYYON_ASSET_DIRS],
		check=True,
		capture_output=True,
	).stdout
	subprocess.run(["tar", "-x", "-C", str(out)], input=archive, check=True)
	return out


def prepare_veyyon(
	run_dir: Path,
	llm_port: int,
	display: str,
	runtime_dir: str,
	binary: Path,
	bun: Path,
	assets_revision: str,
) -> Launch:
	home = run_dir / "veyyon" / "home"
	home.mkdir(parents=True, exist_ok=True)
	threads = seed.seed_veyyon(home)
	root = home / ".veyyon"
	agent = root / "profiles" / seed.PROFILE / "agent"
	agent.mkdir(parents=True, exist_ok=True)
	(root / "config.yml").write_text(VEYYON_CONFIG.format(model=seed.MODEL_ID), encoding="utf-8")
	(agent / "models.yml").write_text(VEYYON_MODELS.format(port=llm_port, model=seed.MODEL_ID), encoding="utf-8")
	assets = _extract_assets(run_dir, assets_revision)
	env = _base_env(home, display, runtime_dir, [str(bun.parent)])
	env.update(
		{
			"VEYYON_PROFILE": seed.PROFILE,
			"VEYYON_BIN": str(BENCH_DIR / "veyyon-host.sh"),
			"BENCH_BUN": str(bun),
			"BENCH_LLM_KEY": "bench",
			"VEYYON_DESKTOP_TOKENS_DIR": str(assets / VEYYON_ASSET_DIRS[0]),
			"VEYYON_DESKTOP_THEMES_DIR": str(assets / VEYYON_ASSET_DIRS[1]),
		}
	)
	return Launch(
		app="veyyon",
		argv=[str(binary)],
		env=env,
		cwd=seed.project_dir(home, corpus.PROJECTS[0]),
		home=home,
		threads=threads,
	)


# T3 Code --------------------------------------------------------------------

CODEX_CONFIG = """\
model = "{model}"
model_provider = "bench"
approval_policy = "never"
sandbox_mode = "danger-full-access"
check_for_update_on_startup = false

[model_providers.bench]
name = "Bench"
base_url = "http://127.0.0.1:{port}/v1"
wire_api = "responses"
requires_openai_auth = false
"""

# T3 Code's defaults, except the two that would make the runs incomparable:
# `responseStreamingMode` defaults to "paragraph", which holds assistant text
# until a paragraph ends, so a token-to-paint probe would time paragraph
# boundaries; "token" forwards every delta, the mode veyyon runs in. Provider
# update checks query the npm registry and raise a toast over the transcript
# when the installed Codex is not the latest.
T3_SERVER_SETTINGS = {"responseStreamingMode": "token", "enableProviderUpdateChecks": False}


def _t3_home(run_dir: Path, llm_port: int) -> Path:
	home = run_dir / "t3" / "home"
	userdata = home / ".t3" / "userdata"
	userdata.mkdir(parents=True, exist_ok=True)
	(userdata / "client-settings.json").write_text(json.dumps({"onboardingCompletedAt": "2026-01-01T00:00:00.000Z"}))
	(userdata / "desktop-settings.json").write_text(json.dumps({"mainWindowMaximized": True}))
	(userdata / "settings.json").write_text(json.dumps(T3_SERVER_SETTINGS))
	codex_home = home / ".codex"
	codex_home.mkdir(parents=True, exist_ok=True)
	config = CODEX_CONFIG.format(model=seed.MODEL_ID, port=llm_port)
	for project in corpus.PROJECTS:
		config += f'\n[projects."{seed.project_dir(home, project)}"]\ntrust_level = "trusted"\n'
	(codex_home / "config.toml").write_text(config)
	return home


def _tool_dir(run_dir: Path, codex: Path, node: Path) -> Path:
	"""A PATH directory holding only the `codex` and `node` T3 Code runs."""
	bin_dir = run_dir / "t3" / "bin"
	bin_dir.mkdir(parents=True, exist_ok=True)
	for name, target in (("codex", codex), ("node", node)):
		link = bin_dir / name
		if link.is_symlink() or link.exists():
			link.unlink()
		link.symlink_to(target)
	return bin_dir


def _wait_for(predicate, timeout_s: float, what: str) -> None:
	deadline = time.monotonic() + timeout_s
	while time.monotonic() < deadline:
		if predicate():
			return
		time.sleep(0.2)
	raise TimeoutError(f"timed out after {timeout_s:.0f} s waiting for {what}")


def _t3_schema_ready(db: Path) -> bool:
	if not db.exists():
		return False
	try:
		with sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=1) as conn:
			tables = {row[0] for row in conn.execute("select name from sqlite_master where type = 'table'")}
	except sqlite3.Error:
		return False
	return {"orchestration_events", "projection_state", "projection_thread_messages"} <= tables


def _t3_projected(db: Path) -> bool:
	try:
		with sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=1) as conn:
			(last,) = conn.execute("select coalesce(max(sequence), 0) from orchestration_events").fetchone()
			rows = conn.execute(
				"select last_applied_sequence from projection_state"
				" where projector like 'projection.%' and projector != 'projection.attachment-cleanup'"
			)
			applied = [row[0] for row in rows if row[0] is not None]
	except sqlite3.Error:
		return False
	return last > 0 and bool(applied) and min(applied) >= last


def prepare_t3(
	run_dir: Path,
	llm_port: int,
	display: str,
	runtime_dir: str,
	app_binary: Path,
	codex: Path,
	node: Path,
) -> Launch:
	home = _t3_home(run_dir, llm_port)
	bin_dir = _tool_dir(run_dir, codex, node)
	env = _base_env(home, display, runtime_dir, [str(bin_dir)])
	env["CODEX_HOME"] = str(home / ".codex")
	launch = Launch(
		app="t3",
		argv=[str(app_binary), "--ozone-platform=x11", "--no-sandbox", "--password-store=basic"],
		env=env,
		cwd=home,
		home=home,
	)
	seed.make_projects(home)
	db = seed.t3_database(home)
	logs = run_dir / "t3"
	# First launch: T3 Code creates and migrates its state database.
	proc = launch.start("t3-init", logs / "init.log")
	try:
		_wait_for(lambda: _t3_schema_ready(db), 90, "T3 Code to create its state database")
		time.sleep(2.0)
	finally:
		proc.stop()
	launch.threads = seed.seed_t3(home)
	# Second launch: the projection pipeline projects the seeded events, so the
	# measured launches start from a projected database.
	proc = launch.start("t3-project", logs / "project.log")
	try:
		_wait_for(lambda: _t3_projected(db), 300, "T3 Code to project the seeded corpus")
	finally:
		proc.stop()
	for leftover in ("server-runtime.json",):
		path = home / ".t3" / "userdata" / leftover
		if path.exists():
			path.unlink()
	return launch


def remove_run(run_dir: Path) -> None:
	if run_dir.exists():
		shutil.rmtree(run_dir)
