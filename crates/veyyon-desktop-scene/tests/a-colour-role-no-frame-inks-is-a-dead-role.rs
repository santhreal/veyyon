//! Every colour role a theme declares reaches a pixel.
//!
//! `a_bundled_theme_declares_every_role` proves the file is complete and that
//! every pair clears its contrast floor. Neither says a surface ever draws the
//! colour, so a role can be authored, checked for contrast, shipped, and never
//! inked, and an operator who retunes it sees nothing change. This sweep
//! repaints one role at a time and fails on any whose repaint moves no pixel
//! of any seeded state.
//!
//! The states below reach each register the theme declares: the five grounds
//! and the hairline need the whole window with a rail, a canvas, an inset and
//! a float over it; the eight tints need a row carrying each badge, so the
//! queue is seeded with one of every kind rather than the six a realistic
//! fixture holds; the accent pair needs a primary control, the focus ring the
//! open session's card, and the placeholder ink an empty field. A role
//! reported dead here is a state nobody seeded or a surface nobody wrote, and
//! the answer is one of those two, never a row in the exemption list.
//!
//! PROVED RED. Mapping `TintRole::Plan` to the working pair in the kit's tint
//! table, which is the single place a tint becomes two roles, leaves
//! `PlanFill` and `PlanInk` reachable from nothing; the sweep then fails
//! naming exactly those two.

mod colour_probe;
mod dead_token_probe;

use veyyon_desktop_scene::Headless;
use veyyon_desktop_surface::{
	Badge, Overlay, Row, Section, SettingsPage, fixture, palette::PaletteState,
	settings::SettingsState,
};
use veyyon_desktop_tokens::Theme;

use crate::dead_token_probe::{Observation, shell};

/// One row per badge, so every tint fill and ink is drawn in one frame.
fn every_badge_section() -> (Section, Vec<Row>) {
	let badges = [
		Badge::Working,
		Badge::Watching,
		Badge::Approval,
		Badge::Input,
		Badge::Plan,
		Badge::Due,
		Badge::Done,
		Badge::Failed,
	];
	let rows = badges
		.into_iter()
		.enumerate()
		.map(|(index, badge)| {
			let id = 900 + index as u64;
			Row {
				id,
				title: format!("Row carrying the {badge:?} badge"),
				subtitle: "veyyon/crates/veyyon-desktop-surface".to_owned(),
				badge: Some(badge),
				meta: Some("1m".to_owned()),
				placement: Section::Live,
			}
		})
		.collect();
	(Section::Live, rows)
}

fn observations(cx: &mut Headless, theme: &Theme) -> Vec<Observation> {
	let tokens = veyyon_desktop_tokens::load_bundled_tokens().expect("the tokens must load");
	let mut seeded = Vec::new();

	// Every badge at once: the eight tint fills and their eight inks.
	let mut badges = fixture::populated();
	let live = every_badge_section();
	badges
		.sections
		.retain(|(section, _)| *section != Section::Live);
	badges.sections.insert(2, live);
	seeded.push(shell::Seeded { name: "colour-badges", options: shell::wide(), state: badges });

	// The whole window with the drawer open: ground, rail, canvas, inset and
	// the hairlines between them, plus the terminal grid's own ink.
	seeded.push(shell::Seeded {
		name:    "colour-drawer",
		options: shell::wide(),
		state:   fixture::with_drawer(),
	});

	// A float over the window, which is the one ground the docked panes never
	// draw, with a selected row for the accent pair.
	let mut palette_state = fixture::populated();
	palette_state.overlay = Some(Overlay::Palette(PaletteState::commands()));
	seeded.push(shell::Seeded {
		name:    "colour-palette",
		options: shell::wide(),
		state:   palette_state,
	});

	// The settings sheet, whose controls carry the focus ring and the
	// placeholder ink a populated surface never shows.
	let mut settings_state = fixture::populated();
	settings_state.overlay =
		Some(Overlay::Settings(Box::new(SettingsState::new(SettingsPage::General))));
	seeded.push(shell::Seeded {
		name:    "colour-settings",
		options: shell::wide(),
		state:   settings_state,
	});

	shell::render_with_theme(cx, &tokens, theme, seeded)
}

#[test]
fn every_declared_role_inks_a_pixel() {
	colour_probe::assert_every_role_is_inked(observations);
}
