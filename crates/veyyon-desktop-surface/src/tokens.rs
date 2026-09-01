//! Installing one resolved token set for both consumers.
//!
//! Colours and the type scale reach the kit primitives through a renderer
//! global, and the §5 surface geometry reaches the views as a plain value. Two
//! consumers of one token file can disagree, and a disagreement is invisible:
//! the kit would draw a badge from one theme while the surface around it drew
//! its ground from another. Both are produced here from a single load, in a
//! single call, so there is no second call site that can pass a different one.

use std::path::Path;

use veyyon_desktop_kit::TokenSet;
use veyyon_desktop_tokens::{ColorRole, SurfaceTokens, Theme, TokenError, Tokens};
use veyyon_gpui::App;

use crate::model::role_named;

/// What the shell view holds after a successful install.
#[derive(Debug, Clone)]
pub struct InstalledTokens {
	/// Colours and the type scale. The same value is installed as the kit's
	/// global, so a primitive and the surface around it cannot disagree.
	pub set:              TokenSet,
	/// The geometry the §5 surfaces read.
	pub surface:          SurfaceTokens,
	/// The role named by `transcript.user_turn_ground`, resolved once here so
	/// the render path indexes a role instead of matching a string per frame.
	pub user_turn_ground: ColorRole,
}

/// Resolves the token set, installs it as the kit's global, and returns what
/// the shell view holds.
///
/// Fails if the theme omits a colour role, or if a token file names a role that
/// does not exist, before anything is drawn. A theme is edited by hand and a
/// role can be dropped or misspelled by a typo; the alternative to failing here
/// is a surface that renders a substituted colour and looks deliberate.
pub fn install_tokens(
	cx: &mut App,
	tokens: &Tokens,
	theme: &Theme,
	surface_path: &Path,
) -> Result<InstalledTokens, TokenError> {
	let set = TokenSet::from_tokens(tokens, theme)?;

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
	Ok(InstalledTokens { set, surface: tokens.surface.clone(), user_turn_ground })
}
