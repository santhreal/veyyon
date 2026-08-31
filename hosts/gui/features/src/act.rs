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
use veyyon_gui_core::{UiCommand, keys};

/// Do one thing the window can be asked to do.
///
/// `no_json` because these are never loaded from a keymap file: the table in
/// [`veyyon_gui_core::keys`] is the keymap, and it is Rust.
#[derive(Clone, Debug, PartialEq, Action)]
#[action(namespace = veyyon, no_json)]
pub struct Do(pub UiCommand);

/// Send a command up the tree from an event listener.
pub fn run(command: UiCommand, window: &mut Window, cx: &mut App) {
	window.dispatch_action(Box::new(Do(command)), cx);
}

/// A click handler that runs one command.
///
/// What a surface writes: `.on_click(act::click(UiCommand::ToggleSidebar))`.
/// The command is cloned per press rather than moved, since a control lives one
/// frame and its handler may outlive several.
pub fn click(command: UiCommand) -> impl Fn(&ClickEvent, &mut Window, &mut App) + 'static {
	move |_, window, cx| run(command.clone(), window, cx)
}

/// The one binding a row becomes.
///
/// `None` for a row the toolkit rejects, which is a development failure the
/// table's own suite reports rather than a launch that panics.
fn one(row: keys::Row) -> Option<KeyBinding> {
	let context = match row.context.predicate() {
		Some(source) => Some(std::rc::Rc::new(KeyBindingContextPredicate::parse(source).ok()?)),
		None => None,
	};
	KeyBinding::load(row.keys, Box::new(Do(row.command)), context, false, None, &DummyKeyboardMapper)
		.ok()
}

/// Every documented binding, ready for `App::bind_keys`.
///
/// The caret's own bindings are not here: they belong to the field, and the
/// window installs both tables.
pub fn bindings() -> Vec<KeyBinding> {
	keys::table().into_iter().filter_map(one).collect()
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

	use veyyon_gui_core::navigation::{BottomTab, Overlay, Route};

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
		let action = Do(UiCommand::ResizeSidebar { width_milli_px: 321_000 });
		let boxed: Box<dyn Action> = Box::new(action.clone());
		let back = boxed
			.as_any()
			.downcast_ref::<Do>()
			.expect("the action is a Do");
		assert_eq!(back, &action);
		assert!(boxed.partial_eq(&Do(UiCommand::ResizeSidebar { width_milli_px: 321_000 })));
		assert!(!boxed.partial_eq(&Do(UiCommand::QuitWindow)));
	}

	#[test]
	fn the_caret_table_and_this_one_claim_no_chord_twice() {
		// Both tables are installed into one keymap. A chord claimed by both in
		// contexts that can match at once is a chord whose second binding never
		// fires, and the caret's rows are the ones nobody would think to check:
		// `secondary-a`, `home`, `end`, `enter`.
		//
		// The rule, and why the palette is not a violation of it: a repeat is
		// safe exactly when no caret row claims that chord in the field the
		// shell row names. `up` and `down` are the case this turns on, because
		// the caret deliberately leaves them alone in the palette's field so
		// they can walk the list under it. A row moved into a field the caret
		// does claim fails here rather than going quiet in the window.
		let caret: Vec<(String, String)> = veyyon_gui_kit::input::keys::bindings()
			.iter()
			.map(|binding| {
				(format!("{:?}", binding.keystrokes()), format!("{:?}", binding.predicate()))
			})
			.collect();
		for row in keys::table() {
			let context = row.context;
			let keys = row.keys;
			let Some(binding) = one(row) else {
				panic!("{keys} in {context:?} is not a binding the toolkit accepts");
			};
			let chord = format!("{:?}", binding.keystrokes());
			// `None` applies with nothing named, so it matches inside a field
			// too: any caret row on that chord shadows it.
			let field = context.predicate();
			for (claimed, predicate) in caret.iter().filter(|(claimed, _)| *claimed == chord) {
				let shadowed = match field {
					Some(field) => predicate.contains(field),
					None => true,
				};
				assert!(
					!shadowed,
					"{claimed} is claimed by the caret in {predicate} and by the window in \
					 {context:?}, which the same field matches"
				);
			}
		}
	}

	#[test]
	fn the_shell_table_claims_no_chord_twice() {
		// Two rows on one chord in contexts that can both match is a row that
		// never fires. `Everywhere` matches inside every field, so it collides
		// with a row in any context; two field rows collide only with the same
		// field. The settings and files rows on `up` are the case this allows,
		// and the reason the check is not a plain duplicate scan.
		let rows = keys::table();
		for (index, row) in rows.iter().enumerate() {
			for other in rows.iter().skip(index + 1) {
				if row.keys != other.keys {
					continue;
				}
				let overlaps = row.context == other.context
					|| row.context == keys::Context::Everywhere
					|| other.context == keys::Context::Everywhere;
				assert!(
					!overlaps,
					"{} is claimed twice, in {:?} and {:?}",
					row.keys, row.context, other.context
				);
			}
		}
	}

	#[test]
	fn every_dock_tab_and_route_has_a_chord() {
		// Swept from the sets themselves, so a tab or a route added later turns
		// this red rather than shipping reachable with the pointer only. The
		// settings pages are deliberately not swept: the arrows walk them, and
		// ten chords for ten pages is a keymap nobody reads.
		let mut unbound: Vec<String> = Vec::new();
		for tab in BottomTab::ALL {
			if keys::chord_for(&UiCommand::SetBottomTab(tab)).is_none() {
				unbound.push(format!("{tab:?}"));
			}
		}
		for route in [Route::Conversation, Route::Changes, Route::Files, Route::Agents] {
			if keys::chord_for(&UiCommand::Navigate(route)).is_none() {
				unbound.push(format!("{route:?}"));
			}
		}
		// The verbs a reader repeats all day. Each is reachable by pointer, and
		// a chord is what makes it reachable at speed.
		let verbs = [
			UiCommand::CreateSession { workspace: None, parent: None },
			UiCommand::CycleSession { forward: true },
			UiCommand::CycleSession { forward: false },
			UiCommand::ToggleSidebar,
			UiCommand::ToggleInspector,
			UiCommand::ToggleBottomDock,
			UiCommand::OpenOverlay(Overlay::ModelPicker),
			UiCommand::OpenOverlay(Overlay::SessionSwitcher),
		];
		for verb in verbs {
			if keys::chord_for(&verb).is_none() {
				unbound.push(format!("{verb:?}"));
			}
		}
		assert_eq!(unbound, Vec::<String>::new());
	}
}
