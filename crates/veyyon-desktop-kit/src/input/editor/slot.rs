//! Flexible container slot for embedding an `Entity<Editor>` or static text
//! content (§8.25).

use veyyon_gpui::{Entity, SharedString};

use super::Editor;

/// Container slot for editor components accepting either an interactive
/// `Entity<Editor>` or static text.
#[derive(Clone, Debug)]
pub enum EditorSlot {
	/// Live interactive GPUI view entity.
	Entity(Entity<Editor>),
	/// Static string value.
	Static(SharedString),
}

impl From<Entity<Editor>> for EditorSlot {
	fn from(entity: Entity<Editor>) -> Self {
		Self::Entity(entity)
	}
}

impl From<SharedString> for EditorSlot {
	fn from(value: SharedString) -> Self {
		Self::Static(value)
	}
}

impl From<String> for EditorSlot {
	fn from(value: String) -> Self {
		Self::Static(value.into())
	}
}

impl From<&str> for EditorSlot {
	fn from(value: &str) -> Self {
		Self::Static(value.into())
	}
}

impl EditorSlot {
	/// Returns true if slot contains an interactive editor entity.
	#[must_use]
	pub const fn is_entity(&self) -> bool {
		matches!(self, Self::Entity(_))
	}

	/// Returns reference to entity if present.
	#[must_use]
	pub const fn entity(&self) -> Option<&Entity<Editor>> {
		match self {
			Self::Entity(e) => Some(e),
			Self::Static(_) => None,
		}
	}
}
