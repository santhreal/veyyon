//! The active theme, and how a component reads a colour out of it.
//!
//! One [`Theme`] in the app's globals. A component asks for a role and gets a
//! colour; it never holds a colour, so switching the theme is one global write
//! and a redraw.

use gpui::{App, Global, Hsla};
use veyyon_gui_theme::{Appearance, Palette, Role, ThemeError, builtin};

/// The theme the window is drawing with.
#[derive(Debug, Clone)]
pub struct Theme {
	pub palette: Palette,
}

impl Global for Theme {}

impl Theme {
	/// Install a palette as the active theme.
	pub fn set(palette: Palette, cx: &mut App) {
		cx.set_global(Theme { palette });
	}

	/// Install a bundled theme by name.
	///
	/// `Ok(false)` when no theme has that name, so a caller can fall back rather
	/// than treating a stale settings value as a broken theme file. `Err` when
	/// the theme exists and does not resolve, which is a defect in the file.
	pub fn set_builtin(name: &str, cx: &mut App) -> Result<bool, ThemeError> {
		match builtin::load(name) {
			None => Ok(false),
			Some(result) => {
				Theme::set(result?, cx);
				Ok(true)
			},
		}
	}

	/// Install the default theme.
	///
	/// # Panics
	///
	/// When the default theme does not resolve. It is embedded in the binary and
	/// covered by the theme crate's own sweep, so a failure here means the build
	/// is broken rather than the operator's configuration.
	pub fn set_default(cx: &mut App) {
		let palette = builtin::load(builtin::DEFAULT)
			.expect("the default theme is bundled")
			.expect("the default theme resolves");
		Theme::set(palette, cx);
	}

	pub fn color(&self, role: Role) -> Hsla {
		self.palette[role]
	}

	pub fn appearance(&self) -> Appearance {
		self.palette.appearance
	}

	pub fn name(&self) -> &str {
		&self.palette.name
	}
}

/// Reading the active theme from anything that holds the app's globals.
///
/// The extension trait rather than `cx.global::<Theme>()` at each call site:
/// the call sites are every component, and `cx.color(Role::TextPrimary)` is the
/// shortest spelling that still names a role instead of a colour.
pub trait ActiveTheme {
	fn theme(&self) -> &Theme;

	fn color(&self, role: Role) -> Hsla {
		self.theme().color(role)
	}
}

impl ActiveTheme for App {
	fn theme(&self) -> &Theme {
		self.global::<Theme>()
	}
}
