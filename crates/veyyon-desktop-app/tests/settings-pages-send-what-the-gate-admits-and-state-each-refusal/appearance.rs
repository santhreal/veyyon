//! The Appearance page draws the window in a palette while the pointer rests
//! on its row and in the chosen one once the pointer leaves or settings
//! close, and Use records the choice in the window's store under the name the
//! window opens in.

use gpui::{Modifiers, TestAppContext};
use veyyon_desktop_app::actions::workspace::CloseSettings;
use veyyon_desktop_ui::theme::{ActiveTheme as _, Appearance};

use super::harness::{Win, window};

fn drawn(w: &mut Win<'_>) -> Appearance {
	w.cx.update(|_, cx| cx.theme().appearance)
}

fn recorded(w: &Win<'_>) -> Option<String> {
	w.state
		.read_with(&*w.cx, |state, _| state.store().persisted.shell.appearance.clone())
}

fn hover(w: &mut Win<'_>, id: &str) {
	let at = w
		.bounds(id)
		.unwrap_or_else(|| panic!("{id} is laid out"))
		.center();
	w.cx.simulate_mouse_move(at, None, Modifiers::none());
	w.cx.run_until_parked();
}

#[gpui::test]
fn a_palette_is_drawn_while_its_row_is_hovered_and_kept_once_use_chooses_it(
	app: &mut TestAppContext,
) {
	let mut w = window(app, Vec::new());
	w.open("appearance");
	let system = w
		.cx
		.update(|_, cx| Appearance::from_system(cx.window_appearance()));
	assert_eq!(recorded(&w), None, "a window no palette was chosen for follows the system");
	assert!(w.bounds("settings.control:use-appearance-system").is_none(), "Match system is chosen");

	hover(&mut w, "settings.control:appearance-light");
	assert_eq!(drawn(&mut w), Appearance::Light, "hovering a row draws its palette");
	hover(&mut w, "settings.control:appearance-dark");
	assert_eq!(drawn(&mut w), Appearance::Dark);
	hover(&mut w, "settings.page:general");
	assert_eq!(drawn(&mut w), system, "leaving the rows draws the chosen palette again");
	assert_eq!(recorded(&w), None, "a preview records nothing");

	w.click("settings.control:use-appearance-light");
	assert_eq!(drawn(&mut w), Appearance::Light);
	assert_eq!(recorded(&w).as_deref(), Some("light"), "Use records the palette by name");
	assert!(w.bounds("settings.control:use-appearance-light").is_none(), "Light is chosen");
	hover(&mut w, "settings.page:general");
	assert_eq!(drawn(&mut w), Appearance::Light, "the chosen palette stays once the pointer leaves");

	hover(&mut w, "settings.control:appearance-dark");
	assert_eq!(drawn(&mut w), Appearance::Dark);
	w.cx.dispatch_action(CloseSettings);
	w.cx.run_until_parked();
	assert_eq!(drawn(&mut w), Appearance::Light, "closing settings ends the preview");

	w.open("appearance");
	w.click("settings.control:use-appearance-system");
	assert_eq!(recorded(&w), None, "Match system records no palette");
	assert_eq!(drawn(&mut w), system);
}
