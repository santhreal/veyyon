//! The Appearance page draws the window in a palette while the pointer rests
//! on its row and in the chosen one once the pointer leaves or settings
//! close, and Use records the choice in the window's store under the name the
//! window opens in. A host theme's Use writes the setting of its ground, the
//! one key a settings page names itself rather than reading from the host's
//! section.
//!
//! WHY: a key the window writes by hand is checked by nothing upstream, and
//! one the host's schema does not have is refused while the row draws as
//! though it worked. The two ground keys are pinned by name and by the ground
//! each carries, so swapping them or collapsing both onto one fails.
//!
//! Gap: that the host's schema spells these keys this way is pinned on the
//! host side, by
//! `a-setting-written-from-the-window-reaches-what-is-already-running.test.ts`.

use gpui::{Modifiers, TestAppContext};
use serde_json::json;
use veyyon_desktop_app::actions::workspace::CloseSettings;
use veyyon_desktop_model::{HostAction, HostEvent, SnapshotSection, ThemeView, ThemesView};
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

#[gpui::test]
fn using_a_theme_writes_the_key_of_its_ground_and_asks_for_the_list_again(
	app: &mut TestAppContext,
) {
	let theme = |id: &str, dark: bool| ThemeView { id: id.to_owned(), name: id.to_owned(), dark };
	let themes = ThemesView {
		themes: vec![
			theme("titanium", true),
			theme("obsidian", true),
			theme("paper", false),
			theme("linen", false),
		],
		dark:   "titanium".to_owned(),
		light:  "paper".to_owned(),
	};
	let mut w = window(app, vec![HostEvent::Snapshot(SnapshotSection::Themes(themes))]);
	w.open("appearance");
	assert_eq!(w.sent(), vec![HostAction::LoadThemes]);
	for (id, dark, key) in [("obsidian", true, "theme.dark"), ("linen", false, "theme.light")] {
		let used = format!("settings.control:use-theme-{id}-{dark}");
		w.click(&used);
		let set = HostAction::SetSetting { key: key.to_owned(), value: json!(id) };
		assert_eq!(w.sent(), vec![set, HostAction::LoadThemes], "{id} is written as {key}");
		assert_eq!(w.bounds(&used), None, "{id} is drawn chosen before the host answers");
	}
}
