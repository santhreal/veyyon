//! How a press becomes a command.
//!
//! One action carries every command: [`Do`]. A button's click handler, a
//! keystroke and a palette row all build the same value and hand it to the
//! toolkit's own dispatch, which walks it up to whoever is listening. Three
//! things follow, and they are why this indirection exists at all:
//!
//! - A surface holds no handle on the window. It says what it wants done, in a
//!   value, and stays a function of the store.
//! - Adding a command adds no wiring. A row in the core table becomes a chord,
//!   a palette row and a pressable control at once.
//! - What a control does is inspectable: the value is `PartialEq`, so a test
//!   can assert on the command a surface would dispatch rather than on a
//!   closure.
//!
//! WHY NOT A CALLBACK PER SURFACE. Because then every surface needs the
//! callback threaded to it, every intermediate has to carry it, and a control
//! three levels down inside a card is either given the callback or given a
//! second way to act. The toolkit already has a dispatch tree; this rides it.

use gpui::{
	Action, App, ClickEvent, DummyKeyboardMapper, KeyBinding, KeyBindingContextPredicate, Window,
};
use veyyon_gui_core::{command::Command, keys};

/// Do one thing the window can be asked to do.
///
/// `no_json` because these are never loaded from a keymap file: the table in
/// [`veyyon_gui_core::keys`] is the keymap, and it is Rust.
#[derive(Clone, Debug, PartialEq, Action)]
#[action(namespace = veyyon, no_json)]
pub struct Do(pub Command);

/// Send a command up the tree from an event listener.
pub fn run(command: Command, window: &mut Window, cx: &mut App) {
	window.dispatch_action(Box::new(Do(command)), cx);
}

/// A click handler that runs one command.
///
/// What a surface writes: `.on_click(act::click(Command::NewSession))`. The
/// command is cloned per press rather than moved, since a control lives one
/// frame and its handler may outlive several.
pub fn click(command: Command) -> impl Fn(&ClickEvent, &mut Window, &mut App) + 'static {
	move |_, window, cx| run(command.clone(), window, cx)
}

/// Every documented binding, ready for `App::bind_keys`.
///
/// The caret's own bindings are not here: they belong to the field, and the
/// window installs both tables.
pub fn bindings() -> Vec<KeyBinding> {
	keys::table()
		.into_iter()
		.map(|row| {
			let context = row.context.predicate().map(|source| {
				let predicate = KeyBindingContextPredicate::parse(source)
					.expect("a context predicate in the key table must parse");
				std::rc::Rc::new(predicate)
			});
			KeyBinding::load(
				row.keys,
				Box::new(Do(row.command)),
				context,
				false,
				None,
				&DummyKeyboardMapper,
			)
			.expect("a keystroke in the key table must parse")
		})
		.collect()
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS. The core table is strings; this is where they
	//! become bindings the toolkit will accept. A row that does not parse
	//! panics, and without this suite that panic happens on a launch. The
	//! second class is a context predicate the toolkit's parser rejects, which
	//! core cannot check for itself because core has no toolkit.
	//!
	//! WHAT IT DOES NOT CATCH. Whether a binding fires: that needs a window and
	//! a focused element, which the windowed suite in the binary covers.

	use super::*;

	#[test]
	fn every_documented_binding_is_one_the_toolkit_accepts() {
		assert_eq!(bindings().len(), keys::table().len());
	}

	#[test]
	fn a_command_survives_the_round_trip_into_an_action() {
		// The dispatch path boxes the command and compares actions by value, so
		// a command that lost its argument on the way in would run against a
		// default.
		let action = Do(Command::SetSidebarWidth(321.0));
		let boxed: Box<dyn Action> = Box::new(action.clone());
		let back = boxed
			.as_any()
			.downcast_ref::<Do>()
			.expect("the action is a Do");
		assert_eq!(back, &action);
		assert!(boxed.partial_eq(&Do(Command::SetSidebarWidth(321.0))));
		assert!(!boxed.partial_eq(&Do(Command::Quit)));
	}

	#[test]
	fn the_caret_table_and_this_one_claim_no_chord_twice() {
		// Both tables are installed into one keymap. A chord in both is a chord
		// whose second binding never fires, and the caret's rows are the ones
		// nobody would think to check: `secondary-a`, `home`, `end`.
		let editor: Vec<String> = veyyon_gui_kit::input::keys::bindings()
			.iter()
			.map(|binding| format!("{:?}", binding.keystrokes()))
			.collect();
		for binding in bindings() {
			let chord = format!("{:?}", binding.keystrokes());
			// A shell chord may repeat a caret chord only if its context cannot
			// match a field. Every shell row is in Shell, Everywhere or the
			// palette's field, and the caret's contexts name the fields, so the
			// overlap that matters is the palette: up, down, enter, escape.
			if editor.contains(&chord) {
				let predicate = format!("{:?}", binding.predicate());
				assert!(
					predicate.contains("PaletteSearch") || predicate.contains("Shell"),
					"{chord} is claimed by both tables with no context to tell them apart"
				);
			}
		}
	}
}
