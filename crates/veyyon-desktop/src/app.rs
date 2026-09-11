//! Application setup, asset location, and token supervision.
//!
//! Section 8.4 and 8.1 define the thread boundary and token reload path:
//! - Startup loads tokens and theme eagerly; any error exits non-zero.
//! - Live updates from `TokenWatcher` are evaluated in the background and
//!   applied to the live window without restarting.

use std::{
	env,
	path::{Path, PathBuf},
	sync::Arc,
};

use flume::Receiver;
use veyyon_desktop_tokens::{
	DEFAULT_APPEARANCE, Theme, TokenError, TokenReloadMessage, TokenWatcher, Tokens,
	load_bundled_themes, load_from_dir,
};

/// Discovered directory paths for desktop tokens and bundled themes.
#[derive(Debug, Clone)]
pub struct AssetPaths {
	pub tokens_dir: PathBuf,
	pub themes_dir: PathBuf,
}

/// Resolved startup bundle: the tokens, every bundled appearance, and the
/// filesystem paths they were read from.
pub struct StartupBundle {
	pub tokens:       Arc<Tokens>,
	/// The theme of the default appearance, which is what a window with
	/// nothing remembered opens in and what a headless render uses when it
	/// names no appearance. The same value as the entry in `themes` whose
	/// appearance is `DEFAULT_APPEARANCE`; `load_startup_bundle` refuses a
	/// build that ships no such entry rather than picking another one.
	pub theme:        Theme,
	/// Every appearance this build ships, loaded and contrast-checked once.
	/// A choice made later restyles the window out of this list rather than
	/// off the disk, so a theme file edited or deleted while the window is up
	/// cannot fail a selection under the operator's pointer.
	pub themes:       Vec<Theme>,
	pub surface_path: PathBuf,
	pub paths:        AssetPaths,
}

impl StartupBundle {
	/// The bundled theme of one appearance, absent when this build ships none.
	#[must_use]
	pub fn theme_of(&self, appearance: &str) -> Option<&Theme> {
		self
			.themes
			.iter()
			.find(|theme| theme.appearance == appearance)
	}
}

/// Discovers the tokens and themes directories from the environment or
/// filesystem.
#[must_use]
pub fn discover_asset_paths() -> AssetPaths {
	let tokens_dir = env::var("VEYYON_DESKTOP_TOKENS_DIR").ok().map_or_else(
		|| find_directory("crates/veyyon-desktop-tokens/tokens", "tokens"),
		PathBuf::from,
	);

	let themes_dir = env::var("VEYYON_DESKTOP_THEMES_DIR").ok().map_or_else(
		|| find_directory("crates/veyyon-desktop-tokens/themes", "themes"),
		PathBuf::from,
	);

	AssetPaths { tokens_dir, themes_dir }
}

/// Finds a directory by checking workspace-relative and manifest-relative
/// candidates.
fn find_directory(workspace_rel: &str, manifest_rel: &str) -> PathBuf {
	let candidates = [
		PathBuf::from(workspace_rel),
		PathBuf::from(manifest_rel),
		PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(manifest_rel),
		PathBuf::from(env!("CARGO_MANIFEST_DIR"))
			.join("../../")
			.join(workspace_rel),
	];

	for candidate in &candidates {
		if candidate.is_dir() {
			return candidate.clone();
		}
	}

	PathBuf::from(workspace_rel)
}

/// Loads the tokens, every bundled appearance, and resolves file paths.
///
/// Fails closed with `TokenError` if any token file or theme is missing or
/// malformed. Every appearance is read here rather than the one the window
/// opens in, because the appearance page offers them all and a contrast
/// failure in the one nobody opened in is still a failure of this build.
pub fn load_startup_bundle(paths: AssetPaths) -> Result<StartupBundle, TokenError> {
	let tokens = load_from_dir(&paths.tokens_dir)?;
	let themes = load_bundled_themes(&paths.themes_dir)?;
	let theme = themes
		.iter()
		.find(|theme| theme.appearance == DEFAULT_APPEARANCE)
		.ok_or_else(|| TokenError::UnknownAppearance {
			appearance: DEFAULT_APPEARANCE.to_string(),
			known:      themes
				.iter()
				.map(|theme| theme.appearance.as_str())
				.collect::<Vec<&str>>()
				.join(", "),
		})?
		.clone();
	let surface_path = paths.tokens_dir.join("surface/transcript.toml");

	Ok(StartupBundle { tokens: Arc::new(tokens), theme, themes, surface_path, paths })
}

/// Spawns a background `TokenWatcher` monitoring the tokens directory.
pub fn start_token_supervision(
	tokens_dir: &Path,
) -> Result<(TokenWatcher, Receiver<TokenReloadMessage>), TokenError> {
	let (tx, rx) = flume::unbounded();
	let watcher = TokenWatcher::new(tokens_dir.to_path_buf(), tx)?;
	Ok((watcher, rx))
}
