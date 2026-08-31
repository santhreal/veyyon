//! WHY THIS SUITE EXISTS.
//!
//! Theme preview on hover must remain strictly ephemeral: hovering a theme row
//! must update the preview state without writing to durable preferences or host
//! settings. Mouse exit must restore the active theme immediately. Only a
//! press/click may commit and persist the selected theme. Unknown persisted
//! theme identifiers must gracefully fall back to the default theme while
//! honestly reporting the refused name.
//!
//! THE CLASS. Premature preference mutation during hover, failure to revert
//! preview, and silent drops of unrecognized theme configurations.
//!
//! WHAT IT DOES NOT CATCH. Operating system level font substitutions or
//! hardware display color profiles.
use veyyon_gui_core::{Store, UiCommand};
use veyyon_gui_kit::theme::{Appearance, entries, resolve_theme};

#[test]
fn theme_preview_is_ephemeral_and_does_not_mutate_preferences() {
	let mut store = Store::detached();

	assert_eq!(store.frontend.theme_preview, None);

	// Previewing a theme sets the ephemeral theme_preview state.
	let _ = store.dispatch(UiCommand::PreviewTheme("midnight".to_string()));
	assert_eq!(
		store.frontend.theme_preview.as_deref(),
		Some("midnight"),
		"theme_preview must reflect the previewed theme ID"
	);

	// Leaving the hover target cancels the preview without mutating settings.
	let _ = store.dispatch(UiCommand::CancelThemePreview);
	assert_eq!(store.frontend.theme_preview, None, "cancelling preview must clear theme_preview");

	assert_eq!(
		store.replica.themes.readable(),
		None,
		"hover preview must not write to replica theme selection"
	);
}

#[test]
fn theme_selection_persists_in_preferences_and_clears_the_preview() {
	let mut store = Store::detached();

	// A detached window themes itself: the choice is the window's preference,
	// not an engine setting, so it lands with no host attached.
	let _ = store.dispatch(UiCommand::PreviewTheme("midnight".to_string()));
	assert_eq!(store.frontend.theme_preview.as_deref(), Some("midnight"));

	let _ = store.dispatch(UiCommand::SetTheme("sand".to_string()));
	assert_eq!(
		store.frontend.preferences.theme.as_deref(),
		Some("sand"),
		"pressing a theme row left the choice out of the preferences the window persists"
	);
	assert_eq!(
		store.frontend.theme_preview, None,
		"the hover preview outlived the press that committed a theme"
	);

	// A second choice replaces the first rather than accumulating.
	let _ = store.dispatch(UiCommand::SetTheme("midnight".to_string()));
	assert_eq!(store.frontend.preferences.theme.as_deref(), Some("midnight"));
}

#[test]
fn unknown_theme_identifier_falls_back_to_the_default_of_the_appearance() {
	for (appearance, expected) in [(Appearance::Dark, "dark"), (Appearance::Light, "light")] {
		let report = resolve_theme(Some("missing-theme-name"), appearance);
		assert_eq!(report.entry.id, expected, "fallback ignored the window's appearance");
		assert_eq!(
			report.refused,
			Some("missing-theme-name".to_string()),
			"report must preserve the exact refused theme identifier"
		);
	}
}

#[test]
fn all_library_themes_are_resolvable_without_refusal() {
	for entry in entries() {
		let report = resolve_theme(Some(entry.id), entry.appearance);
		assert_eq!(report.entry.id, entry.id);
		assert_eq!(
			report.refused, None,
			"valid library theme `{}` was unexpectedly refused",
			entry.id
		);
	}
}
