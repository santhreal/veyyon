//! Searchable model picker backed by the display-safe catalog projection.

use gpui::{AnyElement, App, Entity, ScrollHandle};
use veyyon_gui_core::{Store, navigation::PaletteMode};
use veyyon_gui_kit::input::Editor;

use crate::palette::{self, PaletteMotion};

pub fn render(
	store: &Store,
	field: &Entity<Editor>,
	scroll: &ScrollHandle,
	motion: &mut PaletteMotion,
	open: bool,
	cx: &mut App,
) -> AnyElement {
	palette::render(store, PaletteMode::Models, field, scroll, motion, open, cx)
}
