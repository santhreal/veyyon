//! The only transport boundary in the desktop host.
//!
//! Production starts detached and performs no I/O. A later backend replaces the
//! adapter behind [`Bridge`]; feature modules continue to dispatch commands and
//! read replicas. Debug proof scenes are fully decoded before a window opens
//! and then enter through the same [`Bridge::apply`] method as live events.

use veyyon_gui_core::{
	Changes, Store,
	host::{HostEvent, HostRequest},
};

pub trait Adapter {
	fn submit(&mut self, request: HostRequest);
	fn next_event(&mut self) -> Option<HostEvent>;
}

#[derive(Default)]
struct Detached;

impl Adapter for Detached {
	fn submit(&mut self, _request: HostRequest) {}

	fn next_event(&mut self) -> Option<HostEvent> {
		None
	}
}

pub struct Bridge {
	adapter: Box<dyn Adapter>,
	live:    bool,
}

impl Bridge {
	pub fn detached() -> Self {
		Self { adapter: Box::<Detached>::default(), live: false }
	}

	/// A bridge over a live transport. The adapter owns the connection; the
	/// bridge only moves typed values across it.
	pub fn attached(adapter: Box<dyn Adapter>) -> Self {
		Self { adapter, live: true }
	}

	/// Whether events can arrive without anyone touching the window. A detached
	/// window has nothing to look for, so it looks for nothing.
	pub fn is_live(&self) -> bool {
		self.live
	}

	/// Drain typed intent and apply all events currently available from the
	/// adapter. Detached mode consumes intent without performing I/O and reports
	/// no invented success event.
	pub fn drain(&mut self, store: &mut Store, mut on_changes: impl FnMut(Changes)) {
		self.submit(store);
		while let Some(event) = self.adapter.next_event() {
			on_changes(self.apply(store, event));
		}
		// An applied event raises intent of its own: a capability snapshot asks
		// for the values the opening route draws. Written on this pass rather
		// than the next one, because the next one is a poll interval away.
		self.submit(store);
	}

	fn submit(&mut self, store: &mut Store) {
		for request in store.drain_requests() {
			self.adapter.submit(request);
		}
	}

	pub fn apply(&mut self, store: &mut Store, event: HostEvent) -> Changes {
		store.apply(event)
	}
}

#[cfg(debug_assertions)]
pub mod scene {
	use std::{
		fmt,
		fs::File,
		io::{BufRead, BufReader},
		path::Path,
	};

	use serde_json::{Value, json};
	use veyyon_gui_core::host::HostEvent;

	pub const SCHEMA: u64 = 1;

	#[derive(Debug)]
	pub struct Error(String);

	impl fmt::Display for Error {
		fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
			formatter.write_str(&self.0)
		}
	}

	impl std::error::Error for Error {}

	pub fn load(path: &Path) -> Result<Vec<HostEvent>, Error> {
		let file = File::open(path)
			.map_err(|error| Error(format!("cannot open scene {}: {error}", path.display())))?;
		let mut lines = BufReader::new(file).lines();
		let header = lines
			.next()
			.ok_or_else(|| Error(format!("scene {} is empty", path.display())))?
			.map_err(|error| Error(format!("cannot read scene {} line 1: {error}", path.display())))?;
		let value: Value = serde_json::from_str(&header).map_err(|error| {
			Error(format!("invalid scene header {} line 1: {error}", path.display()))
		})?;
		if value != json!({ "schema": SCHEMA }) {
			return Err(Error(format!(
				"unsupported scene header {} line 1: expected {{\"schema\":{SCHEMA}}}",
				path.display()
			)));
		}

		let mut events = Vec::new();
		for (index, line) in lines.enumerate() {
			let line_number = index + 2;
			let line = line.map_err(|error| {
				Error(format!("cannot read scene {} line {line_number}: {error}", path.display()))
			})?;
			if line.trim().is_empty() {
				return Err(Error(format!(
					"invalid HostEvent in scene {} line {line_number}: blank lines are not events",
					path.display()
				)));
			}
			let event = serde_json::from_str::<HostEvent>(&line).map_err(|error| {
				Error(format!(
					"invalid HostEvent in scene {} line {line_number}: {error}",
					path.display()
				))
			})?;
			events.push(event);
		}
		Ok(events)
	}
}
