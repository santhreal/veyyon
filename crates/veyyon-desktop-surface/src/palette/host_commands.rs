//! The slash commands the host advertises, as palette rows (§5.8).
//!
//! The window holds no table of these. A workspace that installs a command
//! file, a skill or an MCP prompt gets a row for it because the host lists it
//! in a `Commands` snapshot, so the palette states what this workspace can run
//! rather than what the binary was built knowing.

use veyyon_desktop_model::{Capability, CommandSource, CommandSubcommandView, CommandView};

use super::{PaletteItem, PaletteMeta};
use crate::Intent;

/// Row ids for host commands start here, clear of the native rows and of the
/// file, match and directory rows the other modes number.
const ID_BASE: u64 = 5000;

/// What a row states about where its command came from. A builtin says
/// nothing: it is what an operator expects a slash to reach, and a note on
/// every row states nothing about any of them.
const fn source_note(source: CommandSource) -> Option<&'static str> {
	match source {
		CommandSource::Builtin => None,
		CommandSource::Skill => Some("skill"),
		CommandSource::Extension => Some("extension"),
		CommandSource::Custom => Some("project"),
		CommandSource::McpPrompt => Some("mcp"),
		CommandSource::File => Some("prompt file"),
	}
}

/// One row per command the host lists, and one more per subcommand it names,
/// skipping a command a native row already reaches.
///
/// `native` is the titles the window's own rows carry, spelled with their
/// leading slash. A host command with the same spelling is the same command,
/// and the native row runs it through the surface the window already draws
/// for it, so listing both would offer one command twice.
#[must_use]
pub fn host_command_items(commands: &[CommandView], native: &[&str]) -> Vec<PaletteItem> {
	let mut items: Vec<PaletteItem> = Vec::new();
	for command in commands {
		let spelled = format!("/{}", command.name);
		if native
			.iter()
			.any(|taken| taken.eq_ignore_ascii_case(&spelled))
		{
			continue;
		}
		items.push(command_row(&spelled, command));
		for sub in &command.subcommands {
			items.push(subcommand_row(&spelled, command, sub));
		}
	}
	for (index, item) in items.iter_mut().enumerate() {
		item.id = ID_BASE + index as u64;
	}
	items
}

/// The row a command itself carries.
fn command_row(spelled: &str, command: &CommandView) -> PaletteItem {
	let mut item = mark(row(spelled, spelled), command);
	item.subtitle.clone_from(&command.description);
	// What the command takes is drawn only when the host stated it, so a row
	// reading `/agent <name>` is the host's own spelling rather than the
	// window's guess at an argument. The hint is not part of what is run.
	if let Some(hint) = &command.input_hint {
		item.title = format!("{spelled} {hint}");
	}
	// An alias reaches the row without being drawn on it: two spellings of
	// one command are one row, and an operator who typed the other finds it.
	if !command.aliases.is_empty() {
		item.search = Some(command.aliases.join(" "));
	}
	item
}

/// The row one subcommand carries, spelled under its command.
fn subcommand_row(
	spelled: &str,
	command: &CommandView,
	sub: &CommandSubcommandView,
) -> PaletteItem {
	let run = format!("{spelled} {}", sub.name);
	let mut item = mark(row(&run, &run), command);
	item.title = sub.usage.clone().unwrap_or(run);
	item.subtitle.clone_from(&sub.description);
	item
}

/// A row that runs `run` when it is taken, drawn as `title`.
fn row(title: &str, run: &str) -> PaletteItem {
	let text = run.trim_start_matches('/').to_owned();
	PaletteItem::command(0, title, Intent::RunCommand(text), None)
}

/// The note and the capability every host row carries.
fn mark(mut item: PaletteItem, command: &CommandView) -> PaletteItem {
	item.meta = source_note(command.source).map(|note| PaletteMeta::Note(note.to_owned()));
	item.capability = Some(Capability::AgentCommands);
	item
}
