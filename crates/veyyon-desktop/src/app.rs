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
	Theme, TokenError, TokenReloadMessage, TokenWatcher, Tokens, load_from_dir, load_theme,
};

/// Discovered directory paths for desktop tokens and bundled themes.
#[derive(Debug, Clone)]
pub struct AssetPaths {
	pub tokens_dir: PathBuf,
	pub themes_dir: PathBuf,
}

/// Resolved startup bundle containing tokens, theme, and filesystem paths.
pub struct StartupBundle {
	pub tokens:       Arc<Tokens>,
	pub theme:        Theme,
	pub theme_path:   PathBuf,
	pub surface_path: PathBuf,
	pub paths:        AssetPaths,
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

/// Loads tokens, dark theme, and resolves file paths.
///
/// Fails closed with `TokenError` if any token file or theme is missing or
/// malformed.
pub fn load_startup_bundle(paths: AssetPaths) -> Result<StartupBundle, TokenError> {
	let tokens = load_from_dir(&paths.tokens_dir)?;
	let theme_path = paths.themes_dir.join("dark.toml");
	let theme = load_theme(&theme_path)?;
	let surface_path = paths.tokens_dir.join("surface/transcript.toml");

	Ok(StartupBundle { tokens: Arc::new(tokens), theme, theme_path, surface_path, paths })
}

/// Spawns a background `TokenWatcher` monitoring the tokens directory.
pub fn start_token_supervision(
	tokens_dir: &Path,
) -> Result<(TokenWatcher, Receiver<TokenReloadMessage>), TokenError> {
	let (tx, rx) = flume::unbounded();
	let watcher = TokenWatcher::new(tokens_dir.to_path_buf(), tx)?;
	Ok((watcher, rx))
}
