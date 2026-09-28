//! The drawer's tabs: one per terminal the host runs, the supervisor's
//! process list, and one per supervised process's output.
//!
//! A tab is known by what it shows, never by its place in the strip: a
//! terminal that exits and leaves the list moves every tab after it, so the
//! shown tab and the persisted one are a terminal's id or a process's name.

use veyyon_desktop_model::{Capability, CapabilityStatus, ProcessView, TerminalStatus};

use crate::AppState;

/// One tab of the drawer's strip.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum DrawerTab {
	/// The terminal with this id.
	Terminal(String),
	/// The supervised processes and the controls that start and stop them.
	Processes,
	/// The output of the supervised process with this name.
	Process(String),
}

impl DrawerTab {
	/// The name the tab is persisted and targeted under: `terminal:<id>`,
	/// `processes` or `process:<name>`.
	pub fn slug(&self) -> String {
		match self {
			Self::Terminal(id) => format!("terminal:{id}"),
			Self::Processes => "processes".to_owned(),
			Self::Process(name) => format!("process:{name}"),
		}
	}

	/// The tab `slug` names; `None` for a slug no tab writes.
	pub fn from_slug(slug: &str) -> Option<Self> {
		match slug.split_once(':') {
			Some(("terminal", id)) => Some(Self::Terminal(id.to_owned())),
			Some(("process", name)) => Some(Self::Process(name.to_owned())),
			None if slug == "processes" => Some(Self::Processes),
			_ => None,
		}
	}

	/// Whether the tab draws the terminal grid rather than the process list.
	pub const fn is_screen(&self) -> bool {
		!matches!(self, Self::Processes)
	}
}

/// The tabs `app` offers, in strip order: every terminal, the process list
/// while the host has not declined to supervise, then every process.
pub fn offered(app: &AppState) -> Vec<DrawerTab> {
	let domains = &app.store().domains;
	let mut tabs: Vec<DrawerTab> = domains
		.terminals
		.iter()
		.map(|terminal| DrawerTab::Terminal(terminal.id.clone()))
		.collect();
	if app.supervisor_offered() {
		tabs.push(DrawerTab::Processes);
	}
	tabs.extend(
		domains
			.processes
			.iter()
			.map(|process| DrawerTab::Process(process.name.clone())),
	);
	tabs
}

/// The tab shown when nothing chose one, or the chosen one is gone: the last
/// running terminal, which a turn most likely writes to, else the last
/// terminal, else the process list.
pub fn default_tab(app: &AppState) -> Option<DrawerTab> {
	let terminals = &app.store().domains.terminals;
	terminals
		.iter()
		.rev()
		.find(|terminal| terminal.status == TerminalStatus::Running)
		.or_else(|| terminals.last())
		.map(|terminal| DrawerTab::Terminal(terminal.id.clone()))
		.or_else(|| app.supervisor_offered().then_some(DrawerTab::Processes))
}

/// The tab the drawer shows: `chosen` while the host still offers it, else
/// the default.
pub fn shown(app: &AppState, chosen: Option<&DrawerTab>) -> Option<DrawerTab> {
	chosen
		.filter(|tab| offered(app).contains(tab))
		.cloned()
		.or_else(|| default_tab(app))
}

/// What a tab reads: its name and, once it stopped, how it ended. `title` is
/// the terminal's own title as it last set it, empty when it set none.
pub fn label(app: &AppState, tab: &DrawerTab, title: &str) -> String {
	match tab {
		DrawerTab::Processes => "Processes".to_owned(),
		DrawerTab::Terminal(id) => {
			let terminal = app
				.store()
				.domains
				.terminals
				.iter()
				.find(|terminal| &terminal.id == id);
			let base = match terminal {
				_ if !title.trim().is_empty() => title.trim().to_owned(),
				Some(terminal) if !terminal.shell.is_empty() => shell_name(&terminal.shell).to_owned(),
				_ => "Terminal".to_owned(),
			};
			match terminal.map(|terminal| &terminal.status) {
				Some(TerminalStatus::Exited { code: 0 }) => format!("{base} (exited)"),
				Some(TerminalStatus::Exited { code }) => format!("{base} (exit {code})"),
				Some(TerminalStatus::Failed { .. }) => format!("{base} (failed)"),
				Some(TerminalStatus::Running) | None => base,
			}
		},
		DrawerTab::Process(name) => {
			let process = app
				.store()
				.domains
				.processes
				.iter()
				.find(|process| &process.name == name);
			match process.and_then(ended) {
				Some(end) => format!("{name} ({end})"),
				None => name.clone(),
			}
		},
	}
}

/// How `process` ended, `None` while the supervisor still holds it.
pub fn ended(process: &ProcessView) -> Option<String> {
	if process.is_alive() {
		return None;
	}
	Some(match process.exit_code {
		Some(0) => "exited".to_owned(),
		Some(code) => format!("exit {code}"),
		None => process.status.clone(),
	})
}

/// Whether `process` stopped on a failure: the supervisor says so, or it
/// exited non-zero.
pub fn failed(process: &ProcessView) -> bool {
	process.status == "failed" || process.exit_code.is_some_and(|code| code != 0)
}

/// The last path component of `shell`, `zsh` for `/bin/zsh`.
fn shell_name(shell: &str) -> &str {
	shell.rsplit(['/', '\\']).next().unwrap_or(shell)
}

/// Whether the host runs terminals, so the drawer offers to open one.
pub fn terminals_offered(app: &AppState) -> bool {
	*app.store().capabilities.get(Capability::Terminals) == CapabilityStatus::Available
}
