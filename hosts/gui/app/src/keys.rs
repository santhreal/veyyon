//! Every key the window answers to, in one table.
//!
//! The keymap the app installs and the list the settings page shows are built
//! from the same rows, so a key that works is a key that is documented and a
//! key that is documented is a key that works. There is no second table to
//! forget.
//!
//! `secondary-` is Command on macOS and Control everywhere else, which is why
//! the rows are written in keystroke syntax and turned into a label for display
//! rather than the other way round.
//!
//! The editor's own rows are here too, at the bottom, with no description: a
//! field that did not answer to Home would be a defect rather than a feature,
//! and a shortcuts page listing thirty caret motions hides the ten that matter.

use gpui::{Action, DummyKeyboardMapper, KeyBinding, KeyBindingContextPredicate};

use crate::{input, shell};

/// A row: the keystroke, the context it applies in, what it does for the
/// reader, and the action it dispatches.
///
/// An empty description keeps the row out of the settings page.
pub struct Row {
	pub keys:    &'static str,
	pub context: Option<&'static str>,
	pub what:    &'static str,
	pub action:  fn() -> Box<dyn Action>,
}

/// Every binding the app installs.
pub const TABLE: &[Row] = &[
	Row {
		keys:    "secondary-k",
		context: Some("Shell"),
		what:    "Search sessions and run a command",
		action:  || Box::new(shell::OpenPalette),
	},
	Row {
		keys:    "secondary-n",
		context: Some("Shell"),
		what:    "New session",
		action:  || Box::new(shell::NewSession),
	},
	Row {
		keys:    "secondary-b",
		context: Some("Shell"),
		what:    "Show or hide the session list",
		action:  || Box::new(shell::ToggleSidebar),
	},
	Row {
		keys:    "ctrl-`",
		context: Some("Shell"),
		what:    "Show or hide the terminal panel",
		action:  || Box::new(shell::ToggleTerminal),
	},
	Row {
		keys:    "secondary-,",
		context: Some("Shell"),
		what:    "Settings",
		action:  || Box::new(shell::OpenSettings),
	},
	Row {
		keys:    "secondary-shift-m",
		context: Some("Shell"),
		what:    "Change the model",
		action:  || Box::new(shell::PickModel),
	},
	Row {
		keys:    "secondary-shift-p",
		context: Some("Shell"),
		what:    "Change the theme",
		action:  || Box::new(shell::PickTheme),
	},
	Row {
		keys:    "ctrl-tab",
		context: Some("Shell"),
		what:    "Next session",
		action:  || Box::new(shell::CycleNext),
	},
	Row {
		keys:    "ctrl-shift-tab",
		context: Some("Shell"),
		what:    "Previous session",
		action:  || Box::new(shell::CyclePrev),
	},
	Row {
		keys:    "secondary-.",
		context: Some("Shell"),
		what:    "Stop the reply",
		action:  || Box::new(shell::Interrupt),
	},
	Row {
		keys:    "secondary-shift-l",
		context: Some("Shell"),
		what:    "Flip light and dark",
		action:  || Box::new(shell::FlipAppearance),
	},
	Row {
		keys:    "secondary-i",
		context: Some("Shell"),
		what:    "Put the caret back in the composer",
		action:  || Box::new(shell::FocusComposer),
	},
	Row {
		keys:    "secondary-q",
		context: None,
		what:    "Quit",
		action:  || Box::new(crate::Quit),
	},
	Row {
		keys:    "escape",
		context: Some("Shell"),
		what:    "Close what is open, or stop the reply",
		action:  || Box::new(shell::Cancel),
	},
	Row {
		keys:    "enter",
		context: Some("MultilineEditor"),
		what:    "Send",
		action:  || Box::new(input::Submit),
	},
	Row {
		keys:    "shift-enter",
		context: Some("MultilineEditor"),
		what:    "Newline without sending",
		action:  || Box::new(input::Newline),
	},
	// The palette's field. Up, down and enter belong to the list while it is
	// open, which is why that field dispatches in its own context.
	Row {
		keys:    "up",
		context: Some("PaletteSearch"),
		what:    "",
		action:  || Box::new(shell::PaletteUp),
	},
	Row {
		keys:    "down",
		context: Some("PaletteSearch"),
		what:    "",
		action:  || Box::new(shell::PaletteDown),
	},
	Row {
		keys:    "enter",
		context: Some("PaletteSearch"),
		what:    "",
		action:  || Box::new(shell::PaletteAccept),
	},
	// Caret and selection. Both field contexts, because a single-line field
	// takes the same motions as a growing one.
	Row {
		keys:    "left",
		context: Some("Editing"),
		what:    "",
		action:  || Box::new(input::Left),
	},
	Row {
		keys:    "right",
		context: Some("Editing"),
		what:    "",
		action:  || Box::new(input::Right),
	},
	Row { keys: "up", context: Some("Rows"), what: "", action: || Box::new(input::Up) },
	Row { keys: "down", context: Some("Rows"), what: "", action: || Box::new(input::Down) },
	Row {
		keys:    "alt-left",
		context: Some("Editing"),
		what:    "",
		action:  || Box::new(input::WordLeft),
	},
	Row {
		keys:    "alt-right",
		context: Some("Editing"),
		what:    "",
		action:  || Box::new(input::WordRight),
	},
	Row {
		keys:    "secondary-left",
		context: Some("Editing"),
		what:    "",
		action:  || Box::new(input::Home),
	},
	Row {
		keys:    "secondary-right",
		context: Some("Editing"),
		what:    "",
		action:  || Box::new(input::End),
	},
	Row {
		keys:    "home",
		context: Some("Editing"),
		what:    "",
		action:  || Box::new(input::Home),
	},
	Row { keys: "end", context: Some("Editing"), what: "", action: || Box::new(input::End) },
	Row {
		keys:    "secondary-up",
		context: Some("Editing"),
		what:    "",
		action:  || Box::new(input::DocStart),
	},
	Row {
		keys:    "secondary-down",
		context: Some("Editing"),
		what:    "",
		action:  || Box::new(input::DocEnd),
	},
	Row {
		keys:    "shift-left",
		context: Some("Editing"),
		what:    "",
		action:  || Box::new(input::SelectLeft),
	},
	Row {
		keys:    "shift-right",
		context: Some("Editing"),
		what:    "",
		action:  || Box::new(input::SelectRight),
	},
	Row {
		keys:    "shift-up",
		context: Some("Rows"),
		what:    "",
		action:  || Box::new(input::SelectUp),
	},
	Row {
		keys:    "shift-down",
		context: Some("Rows"),
		what:    "",
		action:  || Box::new(input::SelectDown),
	},
	Row {
		keys:    "alt-shift-left",
		context: Some("Editing"),
		what:    "",
		action:  || Box::new(input::SelectWordLeft),
	},
	Row {
		keys:    "alt-shift-right",
		context: Some("Editing"),
		what:    "",
		action:  || Box::new(input::SelectWordRight),
	},
	Row {
		keys:    "secondary-shift-left",
		context: Some("Editing"),
		what:    "",
		action:  || Box::new(input::SelectHome),
	},
	Row {
		keys:    "secondary-shift-right",
		context: Some("Editing"),
		what:    "",
		action:  || Box::new(input::SelectEnd),
	},
	Row {
		keys:    "secondary-a",
		context: Some("Editing"),
		what:    "",
		action:  || Box::new(input::SelectAll),
	},
	Row {
		keys:    "backspace",
		context: Some("Editing"),
		what:    "",
		action:  || Box::new(input::Backspace),
	},
	Row {
		keys:    "delete",
		context: Some("Editing"),
		what:    "",
		action:  || Box::new(input::Delete),
	},
	Row {
		keys:    "alt-backspace",
		context: Some("Editing"),
		what:    "",
		action:  || Box::new(input::DeleteWordLeft),
	},
	Row {
		keys:    "alt-delete",
		context: Some("Editing"),
		what:    "",
		action:  || Box::new(input::DeleteWordRight),
	},
	Row {
		keys:    KILL_LINE,
		context: Some("Editing"),
		what:    "",
		action:  || Box::new(input::DeleteToLineEnd),
	},
	Row {
		keys:    "secondary-c",
		context: Some("Editing"),
		what:    "",
		action:  || Box::new(input::Copy),
	},
	Row {
		keys:    "secondary-x",
		context: Some("Editing"),
		what:    "",
		action:  || Box::new(input::Cut),
	},
	Row {
		keys:    "secondary-v",
		context: Some("Editing"),
		what:    "",
		action:  || Box::new(input::Paste),
	},
	Row {
		keys:    "ctrl-secondary-space",
		context: Some("Editing"),
		what:    "",
		action:  || Box::new(input::ShowCharacterPalette),
	},
];

/// Kill to the end of the line.
///
/// `ctrl-k` is the macOS text system's spelling of it. Everywhere else that
/// keystroke is the command palette, which `secondary-` resolves to `ctrl-`,
/// and the palette is the one a reader reaches for: a field motion cannot take
/// the window's primary command surface.
#[cfg(target_os = "macos")]
const KILL_LINE: &str = "ctrl-k";
#[cfg(not(target_os = "macos"))]
const KILL_LINE: &str = "ctrl-shift-k";

/// The context every text field also dispatches in, so a caret motion is
/// written once rather than once per field.
///
/// `Editing` is not a context any element declares; it is a predicate over the
/// three that do, which is what keeps the motions out of the Shell's own keys.
const EDITING: &str = "Editor || MultilineEditor || PaletteSearch";

/// The fields a vertical caret motion means something in.
///
/// Not the palette's field: there, up and down belong to the list under it, and
/// a binding on the same keystroke in a context that also matches would shadow
/// whichever of the two was written second.
const ROWS: &str = "Editor || MultilineEditor";

/// Every binding, ready for `App::bind_keys`.
pub fn bindings() -> Vec<KeyBinding> {
	TABLE
		.iter()
		.map(|row| {
			let context = row.context.map(|context| {
				let source = match context {
					"Editing" => EDITING,
					"Rows" => ROWS,
					named => named,
				};
				let predicate = KeyBindingContextPredicate::parse(source)
					.expect("a context predicate in the key table must parse");
				std::rc::Rc::new(predicate)
			});
			KeyBinding::load(row.keys, (row.action)(), context, false, None, &DummyKeyboardMapper)
				.expect("a keystroke in the key table must parse")
		})
		.collect()
}

/// The rows the settings page lists, with their keystrokes written the way the
/// platform writes them.
pub fn documented() -> Vec<(String, &'static str)> {
	TABLE
		.iter()
		.filter(|row| !row.what.is_empty())
		.map(|row| (label(row.keys), row.what))
		.collect()
}

/// A keystroke as a reader sees it. The status strip reads it too, so the
/// window never spells a modifier itself.
pub fn label(keys: &str) -> String {
	let mac = cfg!(target_os = "macos");
	keys
		.split('-')
		.map(|part| match part {
			"secondary" if mac => "⌘".to_owned(),
			"secondary" => "Ctrl".to_owned(),
			"ctrl" if mac => "⌃".to_owned(),
			"ctrl" => "Ctrl".to_owned(),
			"shift" if mac => "⇧".to_owned(),
			"shift" => "Shift".to_owned(),
			"alt" if mac => "⌥".to_owned(),
			"alt" => "Alt".to_owned(),
			"enter" => "⏎".to_owned(),
			"escape" => "Esc".to_owned(),
			"tab" => "Tab".to_owned(),
			"backspace" => "⌫".to_owned(),
			"delete" => "Del".to_owned(),
			"up" => "↑".to_owned(),
			"down" => "↓".to_owned(),
			"left" => "←".to_owned(),
			"right" => "→".to_owned(),
			other if other.chars().count() == 1 => other.to_uppercase(),
			other => other.to_owned(),
		})
		.collect::<Vec<_>>()
		.join(if mac { "" } else { "+" })
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS. The keymap is a table of strings that the
	//! compiler cannot check: a typo in a keystroke or a context predicate is a
	//! key that silently does nothing, and neither the type checker nor a
	//! screenshot catches it. `bindings()` panics on a bad row, so this suite
	//! is what makes that panic happen in a test rather than on a launch.
	//!
	//! WHAT IT DOES NOT CATCH. That a binding reaches the right handler: the
	//! action exists and dispatches, but whether the Shell's `on_action` list
	//! carries a listener for it is proved by driving the window.

	use gpui::KeyContext;

	use super::*;

	#[test]
	fn every_row_in_the_key_table_parses() {
		let bindings = bindings();
		assert_eq!(bindings.len(), TABLE.len());
	}

	#[test]
	fn a_documented_row_is_one_a_reader_can_act_on() {
		let documented = documented();
		assert!(documented.len() >= 12, "the shortcuts page lists {}", documented.len());
		for (keys, what) in &documented {
			assert!(!keys.is_empty(), "a documented row has no keystroke: {what}");
			assert!(!keys.contains("secondary"), "{keys} still reads as keystroke syntax");
			assert!(
				what.chars().next().is_some_and(char::is_uppercase),
				"a description starts mid-sentence: {what}"
			);
		}
	}

	#[test]
	fn the_send_key_and_the_newline_key_are_not_the_same_key() {
		let send = TABLE
			.iter()
			.find(|row| row.what == "Send")
			.expect("the table binds a send key");
		let newline = TABLE
			.iter()
			.find(|row| row.what == "Newline without sending")
			.expect("the table binds a newline key");
		assert_ne!(send.keys, newline.keys);
		assert_eq!(send.context, newline.context);
	}

	#[test]
	fn a_caret_motion_is_bound_in_every_field_and_not_in_the_shell() {
		// A motion bound in the Shell's context would fire while the sidebar
		// has focus, moving a caret in a field nobody is typing in.
		let motions = TABLE
			.iter()
			.filter(|row| row.keys == "left" || row.keys == "right");
		let mut seen = 0;
		for row in motions {
			assert_eq!(row.context, Some("Editing"), "{} is bound outside a field", row.keys);
			seen += 1;
		}
		assert_eq!(seen, 2);
		assert!(KeyBindingContextPredicate::parse(EDITING).is_ok());
	}

	/// Every context an element in this window declares, read off the table's
	/// own predicates rather than typed out, so a new field context that
	/// nothing accounts for turns the sweep below red.
	fn atomic_contexts() -> Vec<String> {
		let mut names: Vec<String> = Vec::new();
		for row in TABLE {
			let Some(context) = row.context else {
				continue;
			};
			let source = match context {
				"Editing" => EDITING,
				"Rows" => ROWS,
				named => named,
			};
			for name in source.split("||") {
				let name = name.trim().to_owned();
				if !names.contains(&name) {
					names.push(name);
				}
			}
		}
		names.sort();
		names
	}

	/// The dispatch stacks the window can be in: the root the shell declares,
	/// alone and with each field context nested under it. A binding is enabled
	/// at the depth its predicate matches, so a chord claimed at two depths of
	/// one stack is claimed twice: the deeper row wins and the shallower action
	/// never fires.
	fn stacks() -> Vec<Vec<KeyContext>> {
		let root = "Shell";
		let mut node = KeyContext::default();
		node.add(root.to_owned());
		let mut stacks = vec![vec![node.clone()]];
		for context in atomic_contexts() {
			if context == root {
				continue;
			}
			let mut field = KeyContext::default();
			field.add(context);
			stacks.push(vec![node.clone(), field]);
		}
		stacks
	}

	#[test]
	fn the_contexts_the_table_dispatches_in_are_the_ones_the_window_declares() {
		// Pinned by equality: a field added with a fourth context, or a context
		// renamed on one side only, is a set of bindings that never fire.
		assert_eq!(atomic_contexts(), vec![
			"Editor".to_owned(),
			"MultilineEditor".to_owned(),
			"PaletteSearch".to_owned(),
			"Shell".to_owned(),
		]);
	}

	/// A keystroke as the platform's keymap sees it: `secondary` resolved, and
	/// the modifiers in one order, so two rows written differently that produce
	/// the same chord compare equal.
	fn chord(keys: &str) -> String {
		let mut parts: Vec<String> = keys
			.split('-')
			.map(|part| match part {
				"secondary" if cfg!(target_os = "macos") => "cmd".to_owned(),
				"secondary" => "ctrl".to_owned(),
				other => other.to_owned(),
			})
			.collect();
		let key = parts.pop().expect("a keystroke has a key");
		parts.sort();
		parts.push(key);
		parts.join("-")
	}

	#[test]
	fn the_platform_chord_is_what_two_rows_are_compared_on() {
		// `secondary-k` and `ctrl-k` are two chords on macOS and one chord
		// everywhere else. A sweep that compares the written keystrokes cannot
		// see the second case, which is where the collision lives.
		assert_eq!(chord("ctrl-shift-k"), chord("shift-ctrl-k"));
		assert_eq!(
			chord("secondary-k") == chord("ctrl-k"),
			!cfg!(target_os = "macos"),
			"secondary resolved to the wrong modifier for this platform"
		);
	}

	#[test]
	fn no_keystroke_is_claimed_twice_in_one_context() {
		// The defect this closes was live: `up` and `down` were bound to the
		// caret in a predicate that covered the palette's field as well as the
		// composer, so the palette's list could not be walked with the arrow
		// keys. Both bindings parsed, both dispatched, and one silently won.
		let mut clashes: Vec<String> = Vec::new();
		for stack in stacks() {
			let context = stack
				.iter()
				.map(|node| format!("{node:?}"))
				.collect::<Vec<_>>()
				.join(" > ");

			let mut claimed: Vec<(String, &str)> = Vec::new();
			for row in TABLE {
				// `depth_of`, not `eval`: this is what gpui's `binding_enabled`
				// calls, and it is the whole defect. `eval` reads the deepest
				// node alone, so a root binding looks disabled the moment a
				// field holds focus and a clash between the two is invisible.
				let enabled = match row.context {
					None => true,
					Some(named) => {
						let source = match named {
							"Editing" => EDITING,
							"Rows" => ROWS,
							other => other,
						};
						KeyBindingContextPredicate::parse(source)
							.expect("a context predicate in the key table must parse")
							.depth_of(&stack)
							.is_some()
					},
				};
				if !enabled {
					continue;
				}
				let chord = chord(row.keys);
				if let Some((_, other)) = claimed.iter().find(|(keys, _)| *keys == chord) {
					clashes.push(format!(
						"{chord} is claimed twice in {context}: {} and {}",
						other,
						row.context.unwrap_or("everywhere")
					));
				}
				claimed.push((chord, row.context.unwrap_or("everywhere")));
			}
		}
		assert_eq!(clashes, Vec::<String>::new());
	}
}
