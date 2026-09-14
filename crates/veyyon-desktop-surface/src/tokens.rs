//! Installing one resolved token set for both consumers, and the appearances
//! the window can switch between without reading a file again.
//!
//! Colours and the type scale reach the kit primitives through a renderer
//! global, and the §5 surface geometry reaches the views as a plain value. Two
//! consumers of one token file can disagree, and a disagreement is invisible:
//! the kit would draw a badge from one theme while the surface around it drew
//! its ground from another. Both are produced here from a single load, in a
//! single call, so there is no second call site that can pass a different one.
//!
//! Every bundled appearance is loaded and contrast-checked once at startup and
//! held in [`ThemeLibrary`], so the appearance page previews one on hover in
//! the frame the pointer arrives, rather than on a file read whose failure
//! would land under the pointer (§6.9).

use std::path::{Path, PathBuf};

use veyyon_desktop_kit::TokenSet;
use veyyon_desktop_tokens::{ColorRole, SurfaceTokens, Theme, TokenError, Tokens};
use veyyon_gpui::{App, Global};

use crate::model::role_named;

/// What the shell view holds after a successful install.
#[derive(Debug, Clone)]
pub struct InstalledTokens {
	/// Colours and the type scale. The same value is installed as the kit's
	/// global, so a primitive and the surface around it cannot disagree.
	pub set:              TokenSet,
	/// The geometry the §5 surfaces read.
	pub surface:          SurfaceTokens,
	/// Motion parameters converted from the same validated token load.
	pub motion:           veyyon_desktop_motion::MotionTokens,
	/// The role named by `transcript.user_turn_ground`, resolved once here so
	/// the render path indexes a role instead of matching a string per frame.
	pub user_turn_ground: ColorRole,
	/// The appearance of the theme these colours came from, so the window can
	/// state what it is drawing and skip a re-install of what is already up.
	pub appearance:       String,
}

/// Resolves the token set, installs it as the kit's global, and returns what
/// the shell view holds.
///
/// Fails if the theme omits a colour role, if a token file names a role that
/// does not exist, or if this machine has none of the families the scale
/// authors, before anything is drawn. A theme is edited by hand and a role can
/// be dropped or misspelled by a typo; the alternative to failing here is a
/// surface that renders a substituted colour, or a terminal drawn in a
/// proportional face, and looks deliberate.
pub fn install_tokens(
	cx: &mut App,
	tokens: &Tokens,
	theme: &Theme,
	surface_path: &Path,
) -> Result<InstalledTokens, TokenError> {
	let mut set = TokenSet::from_tokens(tokens, theme)?;
	let available = cx.text_system().all_font_names();
	set.resolve_mono_family(&available)?;
	set.resolve_ui_family(&available)?;

	let ground_name = &tokens.surface.transcript.user_turn_ground;
	let user_turn_ground =
		role_named(ground_name).ok_or_else(|| TokenError::UnresolvedReference {
			path:        surface_path.to_path_buf(),
			line:        0,
			column:      0,
			key:         "transcript.user_turn_ground".to_string(),
			reference:   ground_name.clone(),
			source_file: "the colour role table",
		})?;

	cx.set_global(set.clone());
	Ok(InstalledTokens {
		set,
		surface: tokens.surface.clone(),
		motion: tokens.motion.clone().into(),
		user_turn_ground,
		appearance: theme.appearance.clone(),
	})
}

/// Every appearance this build can draw, with the token load they resolve
/// against (§6.9).
///
/// Held as a global rather than on the view: the appearance page reads the
/// names to list them, the window reads one to draw it, and neither is handed
/// a copy through a constructor that every test and scene would have to pass.
#[derive(Debug, Clone)]
pub struct ThemeLibrary {
	tokens:       Tokens,
	themes:       Vec<Theme>,
	surface_path: PathBuf,
}

impl Global for ThemeLibrary {}

impl ThemeLibrary {
	/// The appearances loaded from a themes directory, against one token load.
	#[must_use]
	pub fn new(tokens: &Tokens, themes: Vec<Theme>, surface_path: &Path) -> Self {
		Self { tokens: tokens.clone(), themes, surface_path: surface_path.to_path_buf() }
	}

	/// The themes, in the order they were loaded.
	#[must_use]
	pub fn themes(&self) -> &[Theme] {
		&self.themes
	}

	/// The theme of one appearance, absent when this build ships none.
	#[must_use]
	pub fn theme(&self, appearance: &str) -> Option<&Theme> {
		self
			.themes
			.iter()
			.find(|theme| theme.appearance == appearance)
	}

	/// The appearances this build ships, for an error that names them.
	fn known(&self) -> String {
		self
			.themes
			.iter()
			.map(|theme| theme.appearance.as_str())
			.collect::<Vec<&str>>()
			.join(", ")
	}
}

/// Installs the appearances this build ships and draws the window in one of
/// them.
pub fn install_appearances(
	cx: &mut App,
	library: ThemeLibrary,
	appearance: &str,
) -> Result<InstalledTokens, TokenError> {
	let theme = library
		.theme(appearance)
		.ok_or_else(|| TokenError::UnknownAppearance {
			appearance: appearance.to_string(),
			known:      library.known(),
		})?
		.clone();
	let installed = install_tokens(cx, &library.tokens, &theme, &library.surface_path)?;
	cx.set_global(library);
	Ok(installed)
}

/// Draws the window in another appearance the library already holds.
///
/// The library is taken out and put back rather than borrowed, because the
/// install writes the token set global through the same context.
pub fn apply_appearance(cx: &mut App, appearance: &str) -> Result<InstalledTokens, TokenError> {
	let library =
		cx.try_global::<ThemeLibrary>()
			.cloned()
			.ok_or_else(|| TokenError::UnknownAppearance {
				appearance: appearance.to_string(),
				known:      "no appearance at all: the library was never installed".to_string(),
			})?;
	install_appearances(cx, library, appearance)
}

/// Re-resolves the appearance now drawn against a reloaded token set.
///
/// A token edit arrives as a whole new load, and the appearances it is
/// resolved against are the ones already held, so a hot reload keeps the
/// operator's choice instead of dropping the window back to the default.
pub fn reload_tokens(
	cx: &mut App,
	tokens: &Tokens,
	appearance: &str,
) -> Result<InstalledTokens, TokenError> {
	let mut library =
		cx.try_global::<ThemeLibrary>()
			.cloned()
			.ok_or_else(|| TokenError::UnknownAppearance {
				appearance: appearance.to_string(),
				known:      "no appearance at all: the library was never installed".to_string(),
			})?;
	library.tokens = tokens.clone();
	install_appearances(cx, library, appearance)
}
