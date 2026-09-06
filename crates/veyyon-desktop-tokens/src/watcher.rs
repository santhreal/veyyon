use std::{
	path::{Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	thread::{self, JoinHandle},
	time::{Duration, Instant},
};

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};

use crate::{Tokens, error::TokenError, loader::load_from_dir};

/// Message sent across the hot reload channel from watcher to UI thread.
#[derive(Debug)]
pub enum TokenReloadMessage {
	Applied(Arc<Tokens>),
	Failed(TokenError),
}

/// Active background filesystem watcher supervising the tokens directory.
pub struct TokenWatcher {
	stop_signal:   Arc<AtomicBool>,
	thread_handle: Option<JoinHandle<()>>,
}

impl TokenWatcher {
	/// Starts watching the specified tokens directory with a 16ms debounce
	/// window.
	pub fn new(dir: PathBuf, tx: flume::Sender<TokenReloadMessage>) -> Result<Self, TokenError> {
		let stop_signal = Arc::new(AtomicBool::new(false));
		let stop_clone = Arc::clone(&stop_signal);

		let (notify_tx, notify_rx) = flume::unbounded::<notify::Result<Event>>();

		let mut watcher = RecommendedWatcher::new(
			move |res| {
				let _ = notify_tx.send(res);
			},
			notify::Config::default(),
		)
		.map_err(|e| TokenError::Io {
			path:   dir.clone(),
			source: std::io::Error::other(e.to_string()),
		})?;

		watcher
			.watch(&dir, RecursiveMode::Recursive)
			.map_err(|e| TokenError::Io {
				path:   dir.clone(),
				source: std::io::Error::other(e.to_string()),
			})?;

		let thread_handle = thread::spawn(move || {
			let _keep_watcher = watcher;
			let debounce_duration = Duration::from_millis(16);

			while !stop_clone.load(Ordering::Relaxed) {
				match notify_rx.recv_timeout(Duration::from_millis(50)) {
					Ok(Ok(_event)) => {
						// Coalesce rapid bursts within 16ms window
						let deadline = Instant::now() + debounce_duration;
						while Instant::now() < deadline {
							let remaining = deadline.saturating_duration_since(Instant::now());
							if let Ok(Ok(_)) = notify_rx.recv_timeout(remaining) {
								// Event consumed, continue waiting until quiet
							}
						}

						// Evaluate all files as an atomic batch
						let reload_msg = match load_from_dir(&dir) {
							Ok(tokens) => TokenReloadMessage::Applied(Arc::new(tokens)),
							Err(err) => TokenReloadMessage::Failed(err),
						};

						let _ = tx.send(reload_msg);
					},
					Ok(Err(_)) => {},
					Err(flume::RecvTimeoutError::Timeout) => {},
					Err(flume::RecvTimeoutError::Disconnected) => break,
				}
			}
		});

		Ok(Self { stop_signal, thread_handle: Some(thread_handle) })
	}

	/// Triggers an immediate atomic evaluation and send without waiting for a
	/// file event.
	pub fn reload_now(dir: &Path, tx: &flume::Sender<TokenReloadMessage>) {
		let msg = match load_from_dir(dir) {
			Ok(tokens) => TokenReloadMessage::Applied(Arc::new(tokens)),
			Err(err) => TokenReloadMessage::Failed(err),
		};
		let _ = tx.send(msg);
	}
}

impl Drop for TokenWatcher {
	fn drop(&mut self) {
		self.stop_signal.store(true, Ordering::Relaxed);
		if let Some(handle) = self.thread_handle.take() {
			let _ = handle.join();
		}
	}
}
