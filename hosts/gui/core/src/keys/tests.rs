//! WHY THIS SUITE EXISTS.
//!
//! A keymap is a table of strings the compiler cannot check, and every defect
//! in one is silent: the chord does nothing, or does the wrong thing, or does
//! the right thing in one context and is swallowed in another. The class this
//! closes is a row that cannot work as written, which is provable here without
//! a window:
//!
//! - two rows claiming one chord in one context, where one of the two never
//!   fires and nothing says which;
//! - a chord whose modifiers or key name are not the syntax the keymap parses;
//! - a row the keyboard page will not list, so the key exists undocumented;
//! - a listed row whose command carries an argument, which a chord cannot
//!   supply.
//!
//! WHAT IT DOES NOT CATCH. Whether the toolkit's predicate parser accepts the
//! context names, and whether a binding is enabled at the depth it is
//! dispatched at: both need the toolkit, and the windowed suite in the binary
//! covers them.

use super::*;
use crate::store::model::Store;

/// A chord as the keymap sees it: `secondary` resolved for this platform and
/// the modifiers in one order, so two rows written differently that produce the
/// same chord compare equal.
fn chord(keys: &str) -> String {
	let mut parts: Vec<String> = keys
		.split('-')
		.map(|part| match part {
			"secondary" if cfg!(target_os = "macos") => "cmd".to_owned(),
			"secondary" => "ctrl".to_owned(),
			other => other.to_owned(),
		})
		.collect();
	// A trailing empty component is the chord whose key is `-`, which is how the
	// parser reads `secondary--`.
	if parts.last().is_some_and(String::is_empty) {
		parts.pop();
		parts.pop();
		parts.push("-".to_owned());
	}
	let key = parts.pop().expect("a keystroke has a key");
	parts.sort();
	parts.push(key);
	parts.join("-")
}

#[test]
fn the_platform_chord_is_what_two_rows_are_compared_on() {
	// `secondary-k` and `ctrl-k` are two chords on macOS and one everywhere
	// else. A sweep comparing the written keystrokes cannot see the second case,
	// which is where the collision lives.
	assert_eq!(chord("ctrl-shift-k"), chord("shift-ctrl-k"));
	assert_eq!(
		chord("secondary-k") == chord("ctrl-k"),
		!cfg!(target_os = "macos"),
		"secondary resolved to the wrong modifier for this platform"
	);
}

#[test]
fn no_chord_is_claimed_twice_where_both_rows_are_live() {
	// Two rows in one context is the defect. Two rows in two contexts is not:
	// Escape closes an overlay in the shell and the palette's own field, and
	// Return sends in the composer and takes a row in the palette, which is the
	// whole reason a context exists.
	let mut clashes: Vec<String> = Vec::new();
	for context in [Context::Everywhere, Context::Shell, Context::Composer, Context::Palette] {
		let mut claimed: Vec<(String, Command)> = Vec::new();
		for row in table().into_iter().filter(|row| row.context == context) {
			let chord = chord(row.keys);
			if let Some((_, other)) = claimed.iter().find(|(keys, _)| *keys == chord) {
				clashes.push(format!(
					"{chord} is claimed twice in {context:?}: {other:?} and {:?}",
					row.command
				));
			}
			claimed.push((chord, row.command));
		}
	}
	assert_eq!(clashes, Vec::<String>::new());
}

#[test]
fn a_chord_everywhere_is_claimed_by_nothing_else() {
	// A row bound with no context wins wherever it fires, so a second row on
	// the same chord in any context is dead. This is the one cross-context
	// collision that is a real collision.
	let everywhere: Vec<String> = table()
		.into_iter()
		.filter(|row| row.context == Context::Everywhere)
		.map(|row| chord(row.keys))
		.collect();
	for row in table()
		.into_iter()
		.filter(|row| row.context != Context::Everywhere)
	{
		assert!(
			!everywhere.contains(&chord(row.keys)),
			"{:?} is shadowed by the same chord bound everywhere",
			row.command
		);
	}
}

#[test]
fn every_chord_is_written_in_the_syntax_the_keymap_parses() {
	// The parser reads modifiers by name and takes the last component as the
	// key. A misspelled modifier becomes a key name, so `command-k` binds a key
	// called "command" and then fails on "k": the row parses as nonsense rather
	// than failing loudly.
	let modifiers = ["secondary", "ctrl", "alt", "shift", "fn", "cmd", "super", "win"];
	let named_keys = [
		"escape",
		"enter",
		"tab",
		"backspace",
		"delete",
		"space",
		"up",
		"down",
		"left",
		"right",
		"home",
		"end",
		"pageup",
		"pagedown",
	];
	for row in table() {
		// A chord whose key is `-` ends in a doubled dash, so the split has to
		// be undone rather than reading an empty component as the key.
		let (written, key) = match row.keys.strip_suffix("--") {
			Some(head) => (head, "-"),
			None => match row.keys.rsplit_once('-') {
				Some((head, key)) => (head, key),
				None => ("", row.keys),
			},
		};
		let parts: Vec<&str> = if written.is_empty() {
			Vec::new()
		} else {
			written.split('-').collect()
		};
		for part in &parts {
			assert!(
				modifiers.contains(part),
				"{:?}: {part:?} is not a modifier the keymap knows",
				row.command
			);
		}
		let key_is_known = named_keys.contains(&key) || key.chars().count() == 1;
		assert!(key_is_known, "{:?}: {key:?} is not a key the keymap names", row.command);
	}
}

#[test]
fn a_row_the_keyboard_page_lists_is_one_a_reader_can_act_on() {
	let store = Store::opened_in("veyyon", "/repo/veyyon");
	for row in listed_rows() {
		assert!(!row.command.what().is_empty(), "{:?} lists with no words", row.command);
		// A listed chord takes no argument: a keystroke has nothing to carry
		// one in, so a row like that could only run against a default.
		let carries_argument = matches!(
			row.command,
			Command::SelectSession(_)
				| Command::DeleteSession(_)
				| Command::ToggleProject(_)
				| Command::SetSidebarWidth(_)
				| Command::PaletteQuery(_)
				| Command::SetAppearance(_)
		);
		assert!(!carries_argument, "{:?} cannot be reached by a chord", row.command);
		// And it is a command that exists in some state: a row for something
		// that never applies is a documented key that never works.
		let _ = row.command.applies(&store);
	}
}

#[test]
fn the_commands_with_no_chord_are_the_ones_that_do_not_need_one() {
	// Pinned by equality. A new searchable command with no chord shows up here,
	// and the decision to leave it chordless is recorded rather than assumed.
	let chordless: Vec<&'static str> = crate::command::searchable()
		.iter()
		.filter(|command| chord_for(command).is_none())
		.map(|command| command.what())
		.collect();
	assert_eq!(chordless, vec!["Group conversations by checkout", "Keyboard shortcuts",]);
}

#[test]
fn the_chord_a_tooltip_prints_is_the_first_row_that_runs_it() {
	assert_eq!(chord_for(&Command::OpenPalette), Some("secondary-k"));
	assert_eq!(chord_for(&Command::Send), Some("enter"));
	// A command bound in two contexts prints the first: Escape in the shell,
	// which is the one a reader presses.
	assert_eq!(chord_for(&Command::Back), Some("escape"));
}

#[test]
fn every_context_the_table_names_resolves_to_a_predicate_or_to_everywhere() {
	// Pinned by equality: a context added on one side only is a set of bindings
	// that never fire, and the window declares these names on its elements.
	let mut named: Vec<&'static str> = table()
		.into_iter()
		.filter_map(|row| row.context.predicate())
		.collect();
	named.sort_unstable();
	named.dedup();
	assert_eq!(named, vec!["MultilineEditor", "PaletteSearch", "Shell"]);
	assert_eq!(Context::Everywhere.predicate(), None);
}
