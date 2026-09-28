//! What the window remembers (§8.10): the persisted stores `AppState` holds,
//! with the window's own placement, written one debounce window after they
//! change and once more when the window or the process ends.

use veyyon_desktop::state::{StateDir, StateTracker, StateWriter};
use veyyon_desktop_model::{PersistedState, WindowStore};
use veyyon_gpui::{Pixels, WindowBounds};

/// The state directory's writer, the state last written, and the window's
/// placement since it last moved.
pub struct Keep {
	/// Absent when no state directory could be resolved: a window that
	/// remembers nothing rather than one that writes somewhere arbitrary.
	disk:      Option<(StateWriter, StateTracker)>,
	placement: WindowStore,
	/// A write is scheduled and has not run yet.
	pending:   bool,
}

impl Keep {
	/// A keeper over `dir`, starting from the state the window was opened
	/// with.
	pub fn new(dir: Option<StateDir>, loaded: &PersistedState) -> Self {
		Self {
			disk:      dir.map(|dir| (StateWriter::new(dir), StateTracker::new(loaded.clone()))),
			placement: loaded.window.clone(),
			pending:   false,
		}
	}

	/// Marks a write as scheduled. Returns `false` when one already is, or
	/// when there is nowhere to write, so the caller schedules at most one.
	pub const fn schedule(&mut self) -> bool {
		if self.pending || self.disk.is_none() {
			return false;
		}
		self.pending = true;
		true
	}

	/// Records where the window is. A maximized or fullscreen window keeps
	/// the rect it returns to, so leaving that state after a relaunch lands
	/// where it was.
	pub fn record_bounds(&mut self, bounds: WindowBounds) {
		match bounds {
			WindowBounds::Windowed(rect) => {
				self.placement.maximized = false;
				self.placement.x = coordinate(rect.origin.x);
				self.placement.y = coordinate(rect.origin.y);
				self.placement.width = measure(rect.size.width);
				self.placement.height = measure(rect.size.height);
			},
			WindowBounds::Maximized(_) | WindowBounds::Fullscreen(_) => {
				self.placement.maximized = true;
			},
		}
	}

	/// Writes every store of `state`, with the recorded placement, that
	/// differs from what was last written. A store that could not be written
	/// is stated on stderr.
	pub fn write(&mut self, state: &PersistedState, now_ms: u64) {
		self.pending = false;
		let Some((writer, tracker)) = self.disk.as_mut() else {
			return;
		};
		let mut next = state.clone();
		next.window.clone_from(&self.placement);
		let mut failures = tracker.sync(&next, writer, now_ms);
		failures.extend(writer.flush_all());
		for failure in failures {
			eprintln!(
				"warn: {store} was not saved: {reason}",
				store = failure.kind.file_name(),
				reason = failure.reason,
			);
		}
	}
}

/// A window coordinate as the whole number the store holds. A window may sit
/// at a negative origin on a display left of the primary one, so the sign is
/// kept.
#[expect(clippy::cast_possible_truncation, reason = "clamped to a range i32 holds")]
fn coordinate(value: Pixels) -> i32 {
	let value = f32::from(value);
	if value.is_finite() {
		value.round().clamp(-100_000.0, 100_000.0) as i32
	} else {
		0
	}
}

/// A window measure as the whole number the store holds, with zero for a
/// measure that is not a size.
#[expect(
	clippy::cast_possible_truncation,
	clippy::cast_sign_loss,
	reason = "clamped to a positive range u32 holds"
)]
fn measure(value: Pixels) -> u32 {
	let value = f32::from(value);
	if value.is_finite() && value > 0.0 {
		value.round().min(f32::from(u16::MAX)) as u32
	} else {
		0
	}
}

#[cfg(test)]
mod tests {
	use veyyon_desktop::state::StateDir;
	use veyyon_desktop_model::{PersistedState, StoreKind};
	use veyyon_gpui::{Bounds, WindowBounds, point, px, size};
	use veyyon_test_scratch::scratch_dir;

	use super::Keep;

	fn windowed(x: f32, y: f32, width: f32, height: f32) -> WindowBounds {
		WindowBounds::Windowed(Bounds {
			origin: point(px(x), px(y)),
			size:   size(px(width), px(height)),
		})
	}

	/// A moved window is written with its new rect, and a maximized one keeps
	/// the rect it returns to.
	#[test]
	fn the_window_store_holds_the_last_windowed_rect() {
		let scratch = scratch_dir("keep-window-rect");
		let dir = StateDir::at(scratch.path().to_path_buf());
		let loaded = PersistedState::new();
		let mut keep = Keep::new(Some(dir.clone()), &loaded);
		keep.record_bounds(windowed(-40.4, 30.6, 1300.2, 900.0));
		keep.record_bounds(WindowBounds::Maximized(Bounds::default()));
		keep.write(&loaded, 0);
		let (written, rejections) = dir.load();
		assert!(rejections.is_empty(), "{rejections:?}");
		assert_eq!(
			(written.window.x, written.window.y, written.window.width, written.window.height),
			(-40, 31, 1300, 900)
		);
		assert!(written.window.maximized);
	}

	/// Only a store that changed is written: an unchanged state writes no
	/// file, and a changed shell store writes the shell file alone.
	#[test]
	fn a_write_touches_only_the_stores_that_changed() {
		let scratch = scratch_dir("keep-changed-only");
		let dir = StateDir::at(scratch.path().to_path_buf());
		let loaded = PersistedState::new();
		let mut keep = Keep::new(Some(dir.clone()), &loaded);
		keep.write(&loaded, 0);
		assert!(!dir.path(StoreKind::Shell).exists(), "nothing changed, nothing written");
		let mut next = loaded;
		next.shell.queue_collapsed = true;
		keep.write(&next, 1);
		assert!(dir.path(StoreKind::Shell).exists());
		assert!(!dir.path(StoreKind::Window).exists());
		assert!(dir.load().0.shell.queue_collapsed);
	}

	/// One write is scheduled at a time, and none without a directory.
	#[test]
	fn a_write_is_scheduled_once_until_it_runs() {
		let loaded = PersistedState::new();
		let mut nowhere = Keep::new(None, &loaded);
		assert!(!nowhere.schedule());
		let scratch = scratch_dir("keep-schedule");
		let mut keep = Keep::new(Some(StateDir::at(scratch.path().to_path_buf())), &loaded);
		assert!(keep.schedule());
		assert!(!keep.schedule());
		keep.write(&loaded, 0);
		assert!(keep.schedule());
	}
}
