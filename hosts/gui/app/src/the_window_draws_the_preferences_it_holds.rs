//! WHY THIS SUITE EXISTS. Switching to a light appearance changed the store
//! and nothing else. The theme lives in a process-wide global that every
//! element reads through `Theme::get`, and it was written once while the
//! process was starting, so the preference had no path to a drawn frame: the
//! window stayed dark and only the settings row that reports the choice
//! redrew. It looked like a repaint problem and was a preference that reached
//! no reader.
//!
//! THE CLASS. Every preference whose effect is a kit global rather than an
//! element's own state: the frame installs it or nobody does, whatever the
//! store says. Both directions are asserted through a drawn frame, so a
//! preference wired only at startup fails here the way this one did.
//!
//! The theme chosen by name is the same class one step further out: the light
//! and dark defaults are two of the palettes, and a build that ships four
//! themes has three ways to install the wrong one. The hover preview is here
//! too, because it is the only preference a frame reads that no press wrote,
//! and because a preview that outlives the pointer is indistinguishable from a
//! selection nobody made.
//!
//! WHAT IT DOES NOT CATCH. Colour. The test platform has no display, so this
//! asserts which palette the frame installed, not what any pixel came out as;
//! a palette whose light and dark tokens were identical would pass. The
//! capture scenes own that.
//!
//! The base font size, which the same line of the frame installs. It is a
//! process-wide static rather than an app global, so every other windowed test
//! in this binary writes it from its own frames and an assertion on it would
//! pass or fail on thread scheduling. Its metrics are asserted in the kit,
//! against the scale itself.

use gpui::TestAppContext;
use veyyon_gui_core::UiCommand;
use veyyon_gui_kit::theme::{Appearance, Theme, resolve_theme};

use crate::the_keyboard_reaches_every_route::open;

#[gpui::test]
fn the_appearance_the_reader_chose_is_the_one_the_frame_installs(cx: &mut TestAppContext) {
	let (shell, cx) = open(cx);
	assert_eq!(
		cx.update(|_, cx| Theme::get(cx).appearance),
		Appearance::Dark,
		"the window did not start on the default appearance"
	);

	for (dark, expected) in [(false, Appearance::Light), (true, Appearance::Dark)] {
		cx.update(|window, cx| {
			shell.update(cx, |shell, cx| {
				shell.perform(UiCommand::SetDarkAppearance(dark), window, cx);
			});
		});
		cx.run_until_parked();

		assert_eq!(
			cx.update(|_, cx| Theme::get(cx).appearance),
			expected,
			"the frame drew the appearance the reader left rather than the one chosen"
		);
	}
}

/// The palette of a library theme, without the font families `install` writes
/// over them from the platform's own list.
fn palette_of(id: &str) -> (gpui::Hsla, gpui::Hsla, gpui::Hsla) {
	let theme = resolve_theme(Some(id), Appearance::Dark).entry.theme;
	(theme.ground, theme.accent, theme.text)
}

fn drawn_palette(cx: &mut gpui::VisualTestContext) -> (gpui::Hsla, gpui::Hsla, gpui::Hsla) {
	cx.update(|_, cx| {
		let theme = Theme::get(cx);
		(theme.ground, theme.accent, theme.text)
	})
}

#[gpui::test]
fn the_theme_the_reader_chose_is_the_one_the_frame_installs(cx: &mut TestAppContext) {
	let (shell, cx) = open(cx);
	let default_palette = drawn_palette(cx);

	for id in ["midnight", "sand", "light", "dark"] {
		cx.update(|window, cx| {
			shell.update(cx, |shell, cx| {
				shell.perform(UiCommand::SetTheme(id.to_owned()), window, cx);
			});
		});
		cx.run_until_parked();
		assert_eq!(
			drawn_palette(cx),
			palette_of(id),
			"the frame kept the palette it had rather than the theme `{id}` the reader chose"
		);
	}

	// A name this build does not ship draws the default rather than the theme
	// left behind, and draws something: a refused name that kept the previous
	// palette would report a fallback in the settings page and contradict it on
	// every other row.
	cx.update(|window, cx| {
		shell.update(cx, |shell, cx| {
			shell.perform(UiCommand::SetTheme("no-such-theme".to_owned()), window, cx);
		});
	});
	cx.run_until_parked();
	assert_eq!(
		drawn_palette(cx),
		default_palette,
		"a refused theme name left the window on the palette it happened to hold"
	);
}

#[gpui::test]
fn the_hovered_theme_is_drawn_while_hovered_and_dropped_on_leaving(cx: &mut TestAppContext) {
	let (shell, cx) = open(cx);
	cx.update(|window, cx| {
		shell.update(cx, |shell, cx| {
			shell.perform(UiCommand::SetTheme("midnight".to_owned()), window, cx);
		});
	});
	cx.run_until_parked();

	// The preview is the pointer's, not the reader's choice: it wins the frame
	// while it lasts and leaves the persisted choice untouched.
	cx.update(|window, cx| {
		shell.update(cx, |shell, cx| {
			shell.perform(UiCommand::PreviewTheme("sand".to_owned()), window, cx);
		});
	});
	cx.run_until_parked();
	assert_eq!(
		drawn_palette(cx),
		palette_of("sand"),
		"hovering a theme row drew the old palette, so the preview reached no frame"
	);

	cx.update(|window, cx| {
		shell.update(cx, |shell, cx| {
			shell.perform(UiCommand::CancelThemePreview, window, cx);
		});
	});
	cx.run_until_parked();
	assert_eq!(
		drawn_palette(cx),
		palette_of("midnight"),
		"leaving the row kept the preview instead of restoring the chosen theme"
	);
}
