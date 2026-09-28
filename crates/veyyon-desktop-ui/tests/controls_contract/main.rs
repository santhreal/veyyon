//! Contracts of the icon set and the control primitives.
//!
//! WHY: an icon whose file is missing or malformed draws as nothing, with no
//! error at the call site; a disabled button that still runs its handler
//! performs an action the window shows as unavailable; a shortcut spelled
//! for the wrong platform teaches keys that do not exist there.
//!
//! The icon sweep enumerates `IconName` with `EnumIter` and compares the set
//! with the files in `icons/`, so an icon added on either side alone fails.
//! It does not catch a glyph that parses but draws the wrong picture.
//!
//! A hover color that snaps flickers as the pointer crosses a row, and one
//! that never lands asks for frames at rest. The hover suite counts the
//! frames a hover asks for; it does not read the color drawn.

use std::{cell::Cell, collections::BTreeSet, path::Path, rc::Rc, sync::Arc, time::Duration};

use strum::IntoEnumIterator;
use veyyon_desktop_ui::{
	controls::{Button, Kbd, KeyPlatform},
	icons::{Assets, IconName},
	theme::{Appearance, Theme},
};
use veyyon_gpui::{
	AssetSource, Context, IntoElement, Keystroke, Modifiers, Render, SvgRenderer, TestAppContext,
	VisualTestContext, Window, div, point, prelude::*, px,
};

#[test]
fn every_icon_name_is_served_as_a_square_svg() {
	let renderer = SvgRenderer::new(Arc::new(Assets));
	for icon in IconName::iter() {
		let bytes = Assets
			.load(icon.path())
			.unwrap_or_else(|error| panic!("{icon:?} failed to load: {error}"))
			.unwrap_or_else(|| panic!("{icon:?} is not served at {}", icon.path()));
		let parsed = renderer
			.parse_svg(&bytes)
			.unwrap_or_else(|error| panic!("{icon:?} does not parse as SVG: {error}"));
		assert_eq!(parsed.size(), (24.0, 24.0), "{icon:?} is drawn in a square");
		assert_eq!(IconName::from_path(icon.path()), Some(icon));
	}
}

#[test]
fn the_icon_directory_holds_exactly_the_listed_icons() {
	let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("icons");
	let files: BTreeSet<String> = std::fs::read_dir(&directory)
		.expect("the icon directory is readable")
		.map(|entry| entry.expect("an icon entry is readable").path())
		.filter(|path| path.extension().is_some_and(|extension| extension == "svg"))
		.filter_map(|path| {
			path
				.file_name()
				.and_then(|name| name.to_str())
				.map(str::to_owned)
		})
		.map(|name| format!("icons/{name}"))
		.collect();
	let listed: BTreeSet<String> = Assets
		.list("icons/")
		.expect("the icon set lists")
		.into_iter()
		.map(|path| path.to_string())
		.collect();
	assert_eq!(files, listed);
	assert_eq!(listed.len(), IconName::iter().count(), "no two icons share a path");
}

#[test]
fn a_path_outside_the_icon_set_loads_nothing() {
	for path in ["icons/unknown.svg", "plus.svg", "icons/plus", "fonts/Inter-Regular.ttf"] {
		assert!(
			Assets.load(path).expect("a load never fails").is_none(),
			"{path} is outside the set"
		);
	}
}

/// A window holding one button at its top-left corner that counts clicks.
struct ButtonHarness {
	disabled: bool,
	clicks:   Rc<Cell<u32>>,
}

impl Render for ButtonHarness {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		let clicks = Rc::clone(&self.clicks);
		div().size_full().child(
			Button::new("button", "Run")
				.disabled(self.disabled)
				.on_click(move |_, _, _| clicks.set(clicks.get() + 1)),
		)
	}
}

/// Clicks inside a button drawn `disabled` or enabled and returns how many
/// times its handler ran.
fn clicks_on_button(disabled: bool) -> u32 {
	let mut cx = TestAppContext::single();
	cx.update(|cx| Theme::install(Appearance::Dark, cx))
		.expect("the dark palette parses");
	let clicks = Rc::new(Cell::new(0));
	let harness_clicks = Rc::clone(&clicks);
	let (_, window) =
		cx.add_window_view(move |_, _| ButtonHarness { disabled, clicks: harness_clicks });
	window.simulate_click(point(px(4.0), px(4.0)), Modifiers::none());
	window.run_until_parked();
	clicks.get()
}

#[test]
fn an_enabled_button_runs_its_handler_on_click() {
	assert_eq!(clicks_on_button(false), 1);
}

#[test]
fn a_disabled_button_ignores_a_click() {
	assert_eq!(clicks_on_button(true), 0);
}

/// Moves the clock a frame on and delivers the frame `window` asked for.
/// Answers whether anything asked for one.
fn frame(window: &mut VisualTestContext) -> bool {
	window.executor().advance_clock(Duration::from_millis(16));
	let asked = window.update(|window, cx| window.simulate_next_frame(cx));
	window.run_until_parked();
	asked > 0
}

/// Delivers frames until none is asked for and answers how long they ran.
fn settle(window: &mut VisualTestContext) -> Duration {
	let mut ran = Duration::ZERO;
	while frame(window) {
		ran += Duration::from_millis(16);
		assert!(ran <= Duration::from_millis(400), "the button still moves {ran:?} in");
	}
	ran
}

/// A hover that snapped its color would ask for no frame; one on a spring
/// or a longer curve would run past the hover's 80 ms.
#[test]
fn a_hovered_button_changes_color_over_80_ms_and_then_asks_for_no_frame() {
	let mut cx = TestAppContext::single();
	cx.update(|cx| Theme::install(Appearance::Dark, cx))
		.expect("the dark palette parses");
	let (_, window) =
		cx.add_window_view(|_, _| ButtonHarness { disabled: false, clicks: Rc::default() });
	window.simulate_mouse_move(point(px(300.0), px(300.0)), None, Modifiers::none());
	settle(window);
	assert!(!frame(window), "a button at rest asks for no frame");

	for (at, move_) in [((4.0, 4.0), "in"), ((300.0, 300.0), "out")] {
		window.simulate_mouse_move(point(px(at.0), px(at.1)), None, Modifiers::none());
		let ran = settle(window);
		assert_eq!(ran, Duration::from_millis(80), "a hover {move_} changes color for {ran:?}");
	}
}

fn keystroke(source: &str) -> Keystroke {
	Keystroke::parse(source).unwrap_or_else(|error| panic!("{source} parses: {error}"))
}

#[test]
fn a_shortcut_is_spelled_in_words_off_macos_and_in_glyphs_on_macos() {
	let palette = Kbd::new(keystroke("ctrl-shift-p"));
	assert_eq!(palette.clone().platform(KeyPlatform::Other).label(), "Ctrl Shift P");
	assert_eq!(palette.platform(KeyPlatform::Mac).label(), "⌃⇧P");

	let every_modifier = Kbd::new(keystroke("ctrl-alt-shift-cmd-k"));
	assert_eq!(
		every_modifier.clone().platform(KeyPlatform::Other).label(),
		"Ctrl Alt Shift Super K"
	);
	assert_eq!(every_modifier.platform(KeyPlatform::Mac).label(), "⌃⌥⇧⌘K");

	let named = Kbd::new(keystroke("alt-enter"));
	assert_eq!(named.clone().platform(KeyPlatform::Other).label(), "Alt Enter");
	assert_eq!(named.platform(KeyPlatform::Mac).label(), "⌥↩");
}

#[test]
fn a_chord_draws_one_cap_per_keystroke() {
	let chord = Kbd::chord("ctrl-k ctrl-s").expect("the chord parses");
	let caps = |platform| -> Vec<String> {
		chord
			.clone()
			.platform(platform)
			.caps()
			.iter()
			.map(ToString::to_string)
			.collect()
	};
	assert_eq!(caps(KeyPlatform::Other), ["Ctrl K", "Ctrl S"]);
	assert_eq!(caps(KeyPlatform::Mac), ["⌃K", "⌃S"]);
}

#[cfg(target_os = "linux")]
#[test]
fn on_linux_a_shortcut_is_spelled_in_words() {
	assert_eq!(Kbd::new(keystroke("ctrl-shift-p")).label(), "Ctrl Shift P");
}
