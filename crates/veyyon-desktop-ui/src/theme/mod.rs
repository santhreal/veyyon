//! The design system: color roles per appearance, spacing, radii, the type
//! ramp and motion.
//!
//! Colors come from one embedded TOML file per appearance
//! (`themes/{dark,light}.toml`); every other measure is a Rust constant. The
//! active theme is an app global read with [`ActiveTheme::theme`].

pub mod motion;
mod palette;
mod scale;

pub use palette::{Accent, Bg, Border, Code, Diff, Palette, Status, Syntax, Text};
pub use scale::{TypeStyle, TypeStyled, radius, size, space, text};
use veyyon_gpui::{App, Global, WindowAppearance};

const DARK: &str = include_str!("../../themes/dark.toml");
const LIGHT: &str = include_str!("../../themes/light.toml");

/// Which palette the window draws with.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Appearance {
	Dark,
	Light,
}

impl Appearance {
	/// Both appearances.
	pub const ALL: [Self; 2] = [Self::Dark, Self::Light];

	/// The appearance matching what the operating system reports.
	#[must_use]
	pub const fn from_system(appearance: WindowAppearance) -> Self {
		match appearance {
			WindowAppearance::Dark | WindowAppearance::VibrantDark => Self::Dark,
			WindowAppearance::Light | WindowAppearance::VibrantLight => Self::Light,
		}
	}

	const fn source(self) -> &'static str {
		match self {
			Self::Dark => DARK,
			Self::Light => LIGHT,
		}
	}
}

/// A palette file that does not parse.
#[derive(Debug, thiserror::Error)]
#[error("the {appearance:?} palette does not parse: {source}")]
pub struct ThemeError {
	pub appearance: Appearance,
	#[source]
	pub source:     toml::de::Error,
}

/// The active appearance and its palette.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Theme {
	pub appearance: Appearance,
	pub palette:    Palette,
}

impl Global for Theme {}

impl Theme {
	/// Parses the embedded palette of `appearance`.
	///
	/// # Errors
	///
	/// Returns [`ThemeError`] when the embedded file is not a complete palette.
	pub fn embedded(appearance: Appearance) -> Result<Self, ThemeError> {
		let palette = toml::from_str(appearance.source())
			.map_err(|source| ThemeError { appearance, source })?;
		Ok(Self { appearance, palette })
	}

	/// Makes `appearance` the active theme. Views that read the theme repaint
	/// on their next notify.
	///
	/// # Errors
	///
	/// Returns [`ThemeError`] when the embedded file is not a complete palette.
	pub fn install(appearance: Appearance, cx: &mut App) -> Result<(), ThemeError> {
		cx.set_global(Self::embedded(appearance)?);
		Ok(())
	}
}

/// Access to the active theme.
pub trait ActiveTheme {
	/// The active theme. Panics only if [`Theme::install`] never ran, which the
	/// window's startup rules out before the first view is built.
	fn theme(&self) -> &Theme;
}

impl ActiveTheme for App {
	fn theme(&self) -> &Theme {
		self.global::<Theme>()
	}
}

#[cfg(test)]
mod tests {
	use super::{Appearance, Theme};

	/// Both embedded palettes are complete: every role is present, every value
	/// is a hex color, and no key is unknown.
	#[test]
	fn every_embedded_palette_parses() {
		for appearance in Appearance::ALL {
			let theme = Theme::embedded(appearance);
			assert!(theme.is_ok(), "{appearance:?}: {:?}", theme.err());
		}
	}

	/// The two appearances differ where it is visible: the window ground and
	/// the primary text trade places between light and dark.
	#[test]
	fn dark_and_light_invert_the_ground_and_the_text() {
		let dark = Theme::embedded(Appearance::Dark).map(|t| t.palette);
		let light = Theme::embedded(Appearance::Light).map(|t| t.palette);
		let (Ok(dark), Ok(light)) = (dark, light) else {
			panic!("both palettes parse");
		};
		assert!(dark.bg.app.l < 0.1 && dark.text.primary.l > 0.9);
		assert!(light.bg.app.l > 0.9 && light.text.primary.l < 0.15);
	}

	/// A palette with a misspelled role fails rather than leaving the role
	/// at a default the views would draw with.
	#[test]
	fn an_unknown_role_is_rejected() {
		let source = super::DARK.replace("[code]\nbg =", "[code]\nbackground =");
		let parsed: Result<super::Palette, _> = toml::from_str(&source);
		let message = parsed.err().map(|e| e.to_string()).unwrap_or_default();
		assert!(message.contains("background"), "{message}");
	}
}
