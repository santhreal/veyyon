//! WHY THIS SUITE EXISTS.
//! Every setting a reader can change, and the bounds it is held to: the
//! sidebar's width at both ends, the text size at both ends, the appearance's
//! two states, the grouping switch, and the notice that has to retire by
//! itself. A bound that is not enforced here is a window that draws text it
//! cannot fit or a pane that cannot be dragged back.
//!
//! WHAT IT DOES NOT CATCH. Whether the settings pages draw the value, which
//! is the feature crate's suite.

use super::{
	super::{
		model::{Appearance, Route, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, SettingsPage},
		moves,
	},
	store,
};

#[test]
fn a_notice_retires_by_itself_and_says_so_once() {
	let mut store = store();
	store.now_ms = 1_000;
	moves::notify(&mut store, "Deleted something");
	let until = store
		.notice_until
		.expect("a notice with no deadline never leaves");
	assert!(until > 1_000);

	assert!(!moves::tick(&mut store, until - 1), "retired early");
	assert!(store.notice.is_some());
	assert!(moves::tick(&mut store, until), "the frame that retires it has to be reported");
	assert!(store.notice.is_none());
	assert_eq!(store.notice_until, None);
	assert!(!moves::tick(&mut store, until + 5_000), "a retired notice retires again");
}

#[test]
fn the_store_only_asks_for_a_frame_while_it_has_a_deadline() {
	let mut store = store();
	assert_eq!(store.deadline(), None, "an idle window that keeps drawing never sleeps");
	moves::notify(&mut store, "something");
	assert!(store.deadline().is_some());
	let until = store.notice_until.unwrap();
	moves::tick(&mut store, until);
	assert_eq!(store.deadline(), None);
}

// ---- the sidebar's width ----

#[test]
fn the_sidebar_width_is_clamped_at_both_ends_and_resets_to_the_default() {
	let mut store = store();
	moves::set_sidebar_width(&mut store, 40.0);
	assert_eq!(store.settings.sidebar_width, SIDEBAR_MIN);
	moves::set_sidebar_width(&mut store, 4_000.0);
	assert_eq!(store.settings.sidebar_width, SIDEBAR_MAX);
	moves::set_sidebar_width(&mut store, 300.0);
	assert_eq!(store.settings.sidebar_width, 300.0);
	moves::reset_sidebar_width(&mut store);
	assert_eq!(store.settings.sidebar_width, SIDEBAR_DEFAULT);
}

#[test]
fn hiding_the_sidebar_keeps_its_width_for_when_it_comes_back() {
	let mut store = store();
	moves::set_sidebar_width(&mut store, 320.0);
	moves::toggle_sidebar(&mut store);
	assert!(!store.settings.sidebar_open);
	assert_eq!(store.settings.sidebar_width, 320.0);
	moves::toggle_sidebar(&mut store);
	assert!(store.settings.sidebar_open);
	assert_eq!(store.settings.sidebar_width, 320.0);
}

// ---- settings ----

#[test]
fn every_settings_page_is_reachable_and_leaving_returns_to_the_conversation() {
	let mut store = store();
	for page in SettingsPage::ALL {
		moves::open_settings(&mut store, page);
		assert_eq!(store.route, Route::Settings(page), "{} is unreachable", page.label());
		assert!(!store.overlay.is_open(), "the palette stayed over the page it opened");
	}
	moves::close_settings(&mut store);
	assert_eq!(store.route, Route::Chat);
}

#[test]
fn every_settings_page_has_a_label_of_its_own() {
	let mut labels: Vec<&str> = SettingsPage::ALL.iter().map(|page| page.label()).collect();
	let count = labels.len();
	labels.sort_unstable();
	labels.dedup();
	assert_eq!(labels.len(), count, "two pages with one name are one row in the nav");
	assert!(labels.iter().all(|label| !label.is_empty()));
}

#[test]
fn the_appearance_is_set_to_one_of_exactly_two_states() {
	let mut store = store();
	assert_eq!(store.settings.appearance, Appearance::Dark);
	moves::set_appearance(&mut store, Appearance::Light);
	assert_eq!(store.settings.appearance, Appearance::Light);
	moves::set_appearance(&mut store, Appearance::Dark);
	assert_eq!(store.settings.appearance, Appearance::Dark);
}

#[test]
fn the_text_size_is_clamped_to_what_the_window_can_draw() {
	use super::super::model::{FONT_MAX, FONT_MIN};
	let mut store = store();
	// An integer sweep, because stepping by a float accumulates.
	for step in 0..=40 {
		let asked = 5.0 + step as f32;
		moves::set_font_size(&mut store, asked);
		let got = store.settings.font_size;
		assert!(
			(FONT_MIN..=FONT_MAX).contains(&got),
			"{asked} became {got}, which is outside what the window draws"
		);
		if (FONT_MIN..=FONT_MAX).contains(&asked) {
			assert_eq!(got, asked);
		}
	}
}

#[test]
fn grouping_by_checkout_is_a_two_way_switch() {
	let mut store = store();
	let was = store.settings.group_by_folder;
	moves::toggle_group_by_folder(&mut store);
	assert_ne!(store.settings.group_by_folder, was);
	moves::toggle_group_by_folder(&mut store);
	assert_eq!(store.settings.group_by_folder, was);
}
