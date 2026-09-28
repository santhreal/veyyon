//! The rows the palette lists: every registered window action, every slash
//! command the host advertises, the requests the palette sends itself, every
//! thread, the files the host matched and every settings page.

use veyyon_desktop_model::{
	CommandView, Gate, HostAction, HostActionKind, SessionId, SurfaceId, domain::ShareRole, gate,
	gate_kind,
};
use veyyon_gpui::{SharedString, Window};

use super::item::{ActionData, Group, Hint, Item, Run, shortcut};
use crate::{actions, settings::Page, state::AppState};

/// The threads listed while the query is empty.
const RECENT_THREADS: usize = 8;

/// What the palette lists.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Scope {
	/// Every source.
	Root,
	/// The subcommands of the command with this name.
	Subcommands(String),
	/// The argument of a command line, which Enter appends and runs.
	Argument {
		/// The command line the argument is appended to.
		line: String,
		/// What the command expects.
		hint: String,
	},
}

/// Why the host would refuse `action` now, or `None` when it would take it.
pub fn refusal(app: &AppState, action: &HostAction) -> Option<SharedString> {
	reason(gate(action, &app.store().capabilities, app.registry()))
}

/// Why the host would refuse an action of `kind` now.
pub fn refusal_kind(app: &AppState, kind: HostActionKind) -> Option<SharedString> {
	reason(gate_kind(kind, &app.store().capabilities, app.registry()))
}

fn reason(gate: Gate) -> Option<SharedString> {
	match gate {
		Gate::Unavailable { reason } => Some(reason.into()),
		Gate::Enabled | Gate::Pending { .. } | Gate::Unknown => None,
	}
}

/// Every row `scope` lists, in no particular order.
pub fn collect(scope: &Scope, query: &str, app: &AppState, window: &Window) -> Vec<Item> {
	let items = match scope {
		Scope::Root => root(query, app, window),
		Scope::Subcommands(name) => subcommands(name, app),
		Scope::Argument { .. } => Vec::new(),
	};
	items.into_iter().map(|item| gated(item, app)).collect()
}

fn root(query: &str, app: &AppState, window: &Window) -> Vec<Item> {
	let mut items = Vec::new();
	window_actions(window, &mut items);
	commands(&app.store().domains.commands, &mut items);
	requests(app, &mut items);
	threads(app, query.trim().is_empty(), &mut items);
	files(app, query, &mut items);
	for page in Page::ALL {
		items.push(
			Item::new(
				Group::Settings,
				page.label(),
				Run::ActionWith(ActionData::OpenSettings(page.name().into())),
			)
			.detail(page.description())
			.also(
				page
					.spellings()
					.iter()
					.map(|spelling| (*spelling).to_owned()),
			),
		);
	}
	items.push(
		Item::new(
			Group::Settings,
			"Sign out of an account…",
			Run::ActionWith(ActionData::OpenSettings(ACCOUNTS.into())),
		)
		.detail("Stored accounts, under Providers")
		.also(["/logout", "logout", "sign out", "/account logout"].map(str::to_owned)),
	);
	items.push(
		Item::new(
			Group::Settings,
			"Status line",
			Run::ActionWith(ActionData::OpenSettings(STATUS_LINE.into())),
		)
		.detail("The Status Line group, under General")
		.also(["/statusline", "statusline", "footline"].map(str::to_owned)),
	);
	items.push(
		Item::new(
			Group::Settings,
			"Search MCP registry",
			Run::ActionWith(ActionData::OpenSettings(REGISTRY.into())),
		)
		.detail("The Smithery registry, under MCP servers")
		.also(
			["smithery", "/mcp smithery-search", "/mcp smithery-login", "/mcp smithery-logout"]
				.map(str::to_owned),
		),
	);
	items
}

/// The settings page and section that list the stored accounts.
const ACCOUNTS: &str = "providers#accounts";
/// The General page's tab and group holding the status line settings.
const STATUS_LINE: &str = "general#appearance/Status Line";
/// The MCP page's Smithery registry section.
const REGISTRY: &str = "mcp#registry";

/// The spellings, beyond its name, that reach the row a window action runs:
/// the slash commands typed for the same thing, by the action's label.
const ACTION_SPELLINGS: &[(&str, &[&str])] = &[
	("Quit", &["exit", "quit", "/exit", "/quit"]),
	("New thread", &["/new"]),
	("Toggle terminal drawer", &["/terminal"]),
	("Stop the turn", &["/abort"]),
	("Move the running command to the background", &["/background"]),
	("Search threads", &["/history", "/resume"]),
	("Search prompt history", &["/prompts"]),
	("Show files", &["/files", "/search"]),
	("Show agents", &["/agents", "/cockpit", "/hub"]),
	("Show diagnostics", &["/settings diagnostics", "diagnostics", "/lsp"]),
	("Show usage", &["/usage", "/context"]),
	("Choose model", &["/model", "/switch"]),
	("Choose thinking level", &["/effort"]),
	("Toggle steer or queue", &["/queue-mode"]),
	("Attach files", &["/attach"]),
	("Plan mode", &["/plan"]),
	("Vibe mode", &["/vibe"]),
	("Loop mode", &["/loop"]),
	("Leave mode", &["/plan off", "/vibe off", "/loop off"]),
	("Review plan", &["/plan-review"]),
	("Delete selected thread", &["/drop"]),
	("Switch profile", &["/profile", "/profiles"]),
];

/// Every action [`actions::registry`] lists, with the shortcut the keymap
/// binds it to and the spellings [`ACTION_SPELLINGS`] gives it.
fn window_actions(window: &Window, items: &mut Vec<Item>) {
	for entry in actions::registry() {
		let action = (entry.build)();
		let spellings = ACTION_SPELLINGS
			.iter()
			.filter(|(label, _)| *label == entry.label)
			.flat_map(|(_, spellings)| spellings.iter().map(|spelling| (*spelling).to_owned()));
		items.push(
			Item::new(Group::Commands, entry.label, Run::Action(entry.build))
				.hint(shortcut(action.as_ref(), window))
				.also([entry.name.to_owned()])
				.also(spellings),
		);
	}
}

/// The requests the palette sends itself: pausing or resuming every agent,
/// and the open thread's own, which are reloading its transcript, `/clear`
/// (the host starts a fresh session in its place), retrying the last turn,
/// rephrasing the last reply, branching, and starting or stopping a share. A
/// request whose direction depends on state is listed only the way that
/// applies, as the thread header draws it.
fn requests(app: &AppState, items: &mut Vec<Item>) {
	let mut row = |label: &'static str, action: HostAction, spellings: &[&str]| {
		items.push(
			Item::new(Group::Commands, label, Run::Host(action, SurfaceId::PaletteInput))
				.also(spellings.iter().map(|spelling| (*spelling).to_owned())),
		);
	};
	let store = app.store();
	if store.paused.paused {
		row("Resume agents", HostAction::ResumeAgents, &["/pause", "/unpause"]);
	} else {
		row("Pause agents", HostAction::PauseAgents, &["/pause"]);
	}
	let Some(session) = app.active_session() else {
		return;
	};
	let session = || session.clone();
	row(
		"Reload the transcript",
		HostAction::LoadTranscript { session: session(), before: None },
		&["/reload-transcript"],
	);
	row("Clear the conversation", HostAction::ClearOutput { session: session() }, &["/clear"]);
	row("Retry the last turn", HostAction::RetryTurn { session: session() }, &["/retry"]);
	row("Rephrase the last reply", HostAction::RephraseReply { session: session() }, &["/rephrase"]);
	row("Branch this thread", HostAction::BranchSession { session: session(), entry: None }, &[
		"/branch", "/fork",
	]);
	let sharing = store
		.domains
		.share
		.as_ref()
		.is_some_and(|share| share.role != ShareRole::Off);
	if sharing {
		row("Stop sharing", HostAction::StopShare, &["/collab stop"]);
	} else {
		row("Share thread", HostAction::StartShare { read_only: false }, &[
			"/collab",
			"/collab start",
		]);
		row("Share a read-only link", HostAction::StartShare { read_only: true }, &["/collab view"]);
	}
}

/// A row per slash command. A command with subcommands lists them; one that
/// takes an argument asks for it; any other runs as chosen.
fn commands(commands: &[CommandView], items: &mut Vec<Item>) {
	for command in commands {
		let line = format!("/{}", command.name);
		let run = if !command.subcommands.is_empty() {
			Run::Subcommands(command.name.clone())
		} else if let Some(hint) = &command.input_hint {
			Run::Argument { line: format!("{line} "), hint: hint.clone() }
		} else {
			Run::Command(line.clone())
		};
		let mut item = Item::new(Group::Commands, line, run)
			.hint(Hint::Text(command.source.label().into()))
			.also(command.aliases.iter().map(|alias| format!("/{alias}")));
		if let Some(description) = &command.description {
			item = item.detail(description.clone());
		}
		items.push(item);
	}
}

fn subcommands(name: &str, app: &AppState) -> Vec<Item> {
	let Some(command) = app
		.store()
		.domains
		.commands
		.iter()
		.find(|command| command.name == name)
	else {
		return Vec::new();
	};
	command
		.subcommands
		.iter()
		.map(|sub| {
			let line = format!("/{} {}", command.name, sub.name);
			let run = match &sub.usage {
				Some(usage) => Run::Argument { line: format!("{line} "), hint: usage.clone() },
				None => Run::Command(line.clone()),
			};
			let item = Item::new(Group::Subcommands, line, run);
			match &sub.description {
				Some(description) => item.detail(description.clone()),
				None => item,
			}
		})
		.collect()
}

/// Every thread of every project, newest first. An empty query lists the
/// newest few and a row that starts a thread in a folder the platform picks.
fn threads(app: &AppState, recent_only: bool, items: &mut Vec<Item>) {
	let mut rows: Vec<(u64, &str, &SessionId, &str)> = app
		.projects()
		.iter()
		.flat_map(|project| {
			project.sessions.iter().map(move |row| {
				(row.modified_at_ms, row.title.as_str(), &row.id, project.name.as_str())
			})
		})
		.collect();
	rows.sort_by_key(|row| std::cmp::Reverse(row.0));
	if recent_only {
		rows.truncate(RECENT_THREADS);
	}
	for (_, title, id, project) in rows {
		items.push(
			Item::new(Group::Threads, title.to_owned(), Run::OpenSession(id.clone()))
				.detail(project.to_owned()),
		);
	}
	items.push(
		Item::new(Group::Threads, "New thread in folder…", Run::CreateSessionInFolder)
			.also(["/project", "/new", "open folder"].map(str::to_owned)),
	);
}

/// The paths the host matched for the query being typed. Results for an
/// older query are not listed.
fn files(app: &AppState, query: &str, items: &mut Vec<Item>) {
	let Some(results) = &app.store().domains.search else {
		return;
	};
	if results.query != query.trim() || results.query.is_empty() {
		return;
	}
	for path in &results.paths {
		let name = path.rsplit('/').next().unwrap_or(path.as_str());
		items.push(
			Item::new(
				Group::Files,
				name.to_owned(),
				Run::ActionWith(ActionData::OpenFile { path: path.clone(), line: None }),
			)
			.detail(path.clone())
			.also([path.clone()]),
		);
	}
}

/// Marks a row that sends a host request the gate rejects.
fn gated(item: Item, app: &AppState) -> Item {
	let reason = match &item.run {
		Run::Command(_) | Run::Argument { .. } | Run::Subcommands(_) => {
			if app.active_session().is_none() {
				Some(SharedString::from("Open a thread to run a command"))
			} else {
				refusal_kind(app, HostActionKind::RunCommand)
			}
		},
		Run::OpenSession(_) => refusal_kind(app, HostActionKind::OpenSession),
		Run::CreateSession(_) | Run::CreateSessionInFolder => {
			refusal_kind(app, HostActionKind::CreateSession)
		},
		Run::ActionWith(ActionData::OpenFile { .. }) => refusal_kind(app, HostActionKind::ReadFile),
		Run::Host(action, _) => refusal(app, action),
		Run::Action(_) | Run::ActionWith(ActionData::OpenSettings(_)) => None,
	};
	item.blocked(reason)
}

#[cfg(test)]
mod tests {
	use super::ACTION_SPELLINGS;
	use crate::actions;

	/// A spelling keyed by a label no registered action carries reaches no
	/// row, so renaming an action in the registry would drop its terminal
	/// spellings without a sound.
	#[test]
	fn every_spelled_label_is_a_registered_action() {
		let orphaned: Vec<&str> = ACTION_SPELLINGS
			.iter()
			.map(|(label, _)| *label)
			.filter(|label| {
				!actions::registry()
					.iter()
					.any(|entry| entry.label == *label)
			})
			.collect();
		assert_eq!(orphaned, Vec::<&str>::new());
	}
}
