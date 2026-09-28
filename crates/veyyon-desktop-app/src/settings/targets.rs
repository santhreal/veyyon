//! The driver targets one render of the settings view registers, so the
//! view forgets each target the page drew before and no longer draws: a
//! control of the page left, a row of an account signed out.
//!
//! The widgets that register a target are free functions with no access to
//! the view, so they note each id here while the view renders; the view
//! takes the set once its render returns. Nothing is noted while the driver
//! is off.

use std::{cell::RefCell, collections::HashSet};

use veyyon_gpui::{AnyElement, IntoElement, SharedString};

use crate::driver::{self, TargetId};

thread_local! {
	static DRAWN: RefCell<HashSet<SharedString>> = RefCell::new(HashSet::new());
}

/// Registers `element` as the driver target `id` and notes the id as drawn
/// by the render running now.
pub fn target(id: impl TargetId, element: impl IntoElement) -> AnyElement {
	if !driver::is_enabled() {
		return element.into_any_element();
	}
	let id = id.into_target_id();
	DRAWN.with_borrow_mut(|drawn| drawn.insert(id.clone()));
	driver::target(id, element)
}

/// The ids noted since the last take.
pub fn take() -> HashSet<SharedString> {
	DRAWN.with_borrow_mut(std::mem::take)
}
