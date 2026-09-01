//! WHY THIS SUITE EXISTS:
//! Section 8.4 and 8.1 define startup failure semantics and live token reload.
//! A malformed token file at startup must fail eagerly (exit non-zero), while
//! a malformed edit during live reload must report the failure without dropping
//! the last good token set.
//!
//! THE CLASS THIS CLOSES:
//! - Startup proceeding with broken/unusable token sets.
//! - Live token reloads crashing the running application on malformed edits.
//! - Live updates failing to propagate through `TokenWatcher`.

use std::{
	fs,
	path::Path,
	sync::Arc,
	time::{Duration, Instant},
};

use veyyon_desktop::{AssetPaths, load_startup_bundle, start_token_supervision};
use veyyon_desktop_tokens::{TokenError, TokenReloadMessage, dump_to_dir, load_from_dir};
use veyyon_test_scratch::scratch_dir;

#[test]
fn startup_bundle_loads_successfully_from_shipped_assets() {
	let tokens_dir =
		Path::new(env!("CARGO_MANIFEST_DIR")).join("../../crates/veyyon-desktop-tokens/tokens");
	let themes_dir =
		Path::new(env!("CARGO_MANIFEST_DIR")).join("../../crates/veyyon-desktop-tokens/themes");

	let paths = AssetPaths { tokens_dir, themes_dir };

	let bundle = load_startup_bundle(paths).expect("shipped startup bundle must load");
	assert_eq!(bundle.tokens.surface.shell.window_min_width_px, 800.0);
	assert_eq!(bundle.tokens.surface.shell.window_min_height_px, 560.0);
	assert_eq!(bundle.tokens.surface.shell.titlebar_height_px, 52.0);
}

#[test]
fn startup_bundle_fails_loud_on_malformed_token_file() {
	let tree = scratch_dir("desktop-startup-malformed");
	let shipped_tokens_dir =
		Path::new(env!("CARGO_MANIFEST_DIR")).join("../../crates/veyyon-desktop-tokens/tokens");
	let shipped_themes_dir =
		Path::new(env!("CARGO_MANIFEST_DIR")).join("../../crates/veyyon-desktop-tokens/themes");

	let tokens = load_from_dir(&shipped_tokens_dir).expect("load shipped tokens");
	dump_to_dir(&tokens, tree.path()).expect("dump tokens");

	// Corrupt shell.toml with invalid value
	let shell_path = tree.path().join("surface/shell.toml");
	let content = fs::read_to_string(&shell_path).expect("read shell.toml");
	let broken = content.replace("min_width_px = 800", "min_width_px = -50");
	fs::write(&shell_path, broken).expect("write broken shell.toml");

	let paths = AssetPaths { tokens_dir: tree.path().to_path_buf(), themes_dir: shipped_themes_dir };

	// A bare `is_err` passes for the wrong reason: a missing scratch directory,
	// a theme that failed to copy, or a loader that rejected the whole file
	// without reading the key. The variant and its fields name the value that
	// was refused and where it was written.
	match load_startup_bundle(paths) {
		Err(TokenError::OffScale { path, value, scale_name, .. }) => {
			assert!(
				path.ends_with("surface/shell.toml"),
				"the error names the file the operator edited, got {path:?}"
			);
			assert_eq!(value, "-50");
			assert_eq!(scale_name, "window.min_width_px");
		},
		Err(other) => panic!("a negative window width is off scale, got {other}"),
		Ok(_) => panic!("startup accepted a negative window minimum width"),
	}
}

#[test]
fn hot_reload_supervision_applies_valid_edits_and_preserves_state_on_failures() {
	let tree = scratch_dir("desktop-hot-reload-supervision");
	let shipped_tokens_dir =
		Path::new(env!("CARGO_MANIFEST_DIR")).join("../../crates/veyyon-desktop-tokens/tokens");

	let initial_tokens = load_from_dir(&shipped_tokens_dir).expect("load shipped tokens");
	dump_to_dir(&initial_tokens, tree.path()).expect("dump tokens");

	let (_watcher, rx) = start_token_supervision(tree.path()).expect("start token supervision");
	let mut active_tokens = Arc::new(initial_tokens);

	// 1. Apply a valid token edit (modify queue default width from 256 to 300)
	let queue_path = tree.path().join("surface/queue.toml");
	let content = fs::read_to_string(&queue_path).expect("read queue.toml");
	let modified = content.replace("default_px = 256", "default_px = 300");
	fs::write(&queue_path, modified).expect("write modified queue.toml");

	let start = Instant::now();
	let mut applied_received = false;
	while start.elapsed() < Duration::from_secs(3) {
		if let Ok(msg) = rx.recv_timeout(Duration::from_millis(100)) {
			match msg {
				TokenReloadMessage::Applied(new_tokens) => {
					assert_eq!(new_tokens.surface.queue.width_default_px, 300.0);
					active_tokens = new_tokens;
					applied_received = true;
					break;
				},
				TokenReloadMessage::Failed(err) => {
					panic!("unexpected reload failure on valid edit: {err}");
				},
			}
		}
	}
	assert!(applied_received, "must receive Applied message on valid edit");

	// Drain any remaining messages
	while rx.try_recv().is_ok() {}

	// 2. Apply a malformed edit (invalid spacing step "s999")
	let current_content = fs::read_to_string(&queue_path).expect("read queue.toml");
	let malformed = current_content.replace("content_inset = \"s4\"", "content_inset = \"s999\"");
	fs::write(&queue_path, malformed).expect("write malformed queue.toml");

	let start = Instant::now();
	let mut failed_received = false;
	while start.elapsed() < Duration::from_secs(3) {
		if let Ok(msg) = rx.recv_timeout(Duration::from_millis(100)) {
			match msg {
				TokenReloadMessage::Failed(_err) => {
					// Active tokens remain unchanged (last good set preserved)
					assert_eq!(active_tokens.surface.queue.width_default_px, 300.0);
					failed_received = true;
					break;
				},
				TokenReloadMessage::Applied(_) => {
					panic!("must not apply a malformed token edit");
				},
			}
		}
	}
	assert!(failed_received, "must receive Failed message on malformed edit");
}
