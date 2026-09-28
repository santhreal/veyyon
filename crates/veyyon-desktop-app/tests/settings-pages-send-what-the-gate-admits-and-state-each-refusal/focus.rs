//! Settings hold the keys while shown: Escape backs out one step at a time,
//! a question first, then an input, then settings themselves, and a page
//! opened from the palette takes the keys the palette held.
//!
//! WHY: focus left on an element no longer drawn reaches no binding of the
//! window, so every shortcut goes dead until a click lands on something
//! focusable. A dialog that dropped focus as it closed, or settings opened
//! from the palette with focus still on the palette's hidden query, did
//! that. Each case ends with Escape closing settings, which only a focus
//! inside the page can do.

use gpui::TestAppContext;
use veyyon_desktop_app::actions::workspace::TogglePalette;
use veyyon_desktop_model::HostAction;

use super::harness::{accounts_and_servers, settings, window};

#[gpui::test]
fn escape_closes_a_question_then_leaves_an_input_then_closes_settings(app: &mut TestAppContext) {
	let mut events = accounts_and_servers();
	events.push(settings());
	let mut w = window(app, events);

	w.open("providers");
	w.sent();
	w.click("settings.control:sign-out-anthropic-7");
	assert!(w.bounds("dialog").is_some(), "the sign-out asks first");
	w.keys("escape");
	assert_eq!(w.bounds("dialog"), None, "the first Escape closes the question");
	assert!(w.layout().settings_open, "and leaves settings open");
	w.keys("escape");
	assert!(!w.layout().settings_open, "the next Escape closes settings");

	w.open("general");
	w.sent();
	w.type_into("settings-query", "retry");
	w.keys("escape");
	assert!(w.layout().settings_open, "Escape in an input leaves the input");
	w.keys("escape");
	assert!(!w.layout().settings_open, "and the next one closes settings");
	assert_eq!(w.sent(), Vec::<HostAction>::new(), "Escape sends nothing");
}

#[gpui::test]
fn a_page_picked_in_the_palette_takes_the_keys_the_palette_held(app: &mut TestAppContext) {
	let mut w = window(app, accounts_and_servers());
	w.cx.dispatch_action(TogglePalette);
	w.cx.run_until_parked();
	w.cx.simulate_input("MCP servers");
	w.keys("enter");
	assert!(w.layout().settings_open && !w.layout().palette_open, "the row opens settings");
	assert_eq!(w.page().name(), "mcp", "on the page it names");
	w.keys("escape");
	assert!(!w.layout().settings_open, "Escape reaches the page the palette opened");
}
