use std::{
	fs,
	path::Path,
	sync::Arc,
	time::{Duration, Instant},
};

use veyyon_desktop_tokens::{
	SpacingStep, TokenReloadMessage, TokenWatcher, dump_to_dir, load_from_dir,
};
use veyyon_test_scratch::scratch_dir;

#[test]
fn test_hot_reload_lifecycle() {
	let tree = scratch_dir("tokens-hot-reload");
	let shipped_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tokens");
	let initial_tokens = load_from_dir(&shipped_dir).expect("load shipped");
	dump_to_dir(&initial_tokens, tree.path()).expect("dump");

	let (tx, rx) = flume::bounded::<TokenReloadMessage>(4);
	let _watcher = TokenWatcher::new(tree.path().to_path_buf(), tx).expect("watcher new");

	let mut active_tokens = Arc::new(initial_tokens);

	// 1. Modify a surface file with a valid change (e.g. change queue default
	//    width)
	let queue_path = tree.path().join("surface/queue.toml");
	let content = fs::read_to_string(&queue_path).unwrap();
	let modified = content.replace("default_px = 256", "default_px = 280");
	fs::write(&queue_path, modified).unwrap();

	// Receive Applied within bounded timeout
	let start = Instant::now();
	let mut received_applied = false;
	while start.elapsed() < Duration::from_secs(3) {
		if let Ok(msg) = rx.recv_timeout(Duration::from_millis(100)) {
			match msg {
				TokenReloadMessage::Applied(new_tokens) => {
					assert_eq!(new_tokens.surface.queue.width_default_px, 280.0);
					active_tokens = new_tokens;
					received_applied = true;
					break;
				},
				TokenReloadMessage::Failed(err) => {
					panic!("unexpected reload failure: {err}");
				},
			}
		}
	}
	assert!(received_applied, "must receive Applied message after valid edit");

	// Drain any remaining messages in channel
	while rx.try_recv().is_ok() {}

	// 2. Modify with a malformed edit (e.g. off scale spacing "s99")
	let current_content = fs::read_to_string(&queue_path).unwrap();
	let malformed = current_content.replace("content_inset = \"s4\"", "content_inset = \"s99\"");
	fs::write(&queue_path, malformed).unwrap();

	let start = Instant::now();
	let mut received_failed = false;
	while start.elapsed() < Duration::from_secs(3) {
		if let Ok(msg) = rx.recv_timeout(Duration::from_millis(100)) {
			match msg {
				TokenReloadMessage::Applied(_) => {
					panic!("malformed file should not emit Applied");
				},
				TokenReloadMessage::Failed(_err) => {
					// Active tokens retained without modification!
					assert_eq!(active_tokens.surface.queue.width_default_px, 280.0);
					received_failed = true;
					break;
				},
			}
		}
	}
	assert!(received_failed, "must receive Failed message on malformed edit");

	// Drain any remaining messages in channel
	while rx.try_recv().is_ok() {}

	// 3. Fix the edit and verify Applied is received again
	let fixed = current_content.replace("default_px = 280", "default_px = 300");
	fs::write(&queue_path, fixed).unwrap();

	let start = Instant::now();
	let mut received_recovered = false;
	while start.elapsed() < Duration::from_secs(3) {
		if let Ok(msg) = rx.recv_timeout(Duration::from_millis(100)) {
			match msg {
				TokenReloadMessage::Applied(new_tokens) => {
					assert_eq!(new_tokens.surface.queue.width_default_px, 300.0);
					active_tokens = new_tokens;
					received_recovered = true;
					break;
				},
				TokenReloadMessage::Failed(_) => {},
			}
		}
	}
	assert!(received_recovered, "must recover and emit Applied on valid fix");
	assert_eq!(active_tokens.scale.spacing(SpacingStep::S4), 8.0);
}
