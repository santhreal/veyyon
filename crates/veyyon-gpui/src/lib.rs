//! The desktop front end's view of GPUI.
//!
//! Santh GPUI is resolved from the canonical `santhreal/gpui` repository.
//! The workspace manifest pins one revision for GPUI and its companion crates.
//! Integration tests exercise the renderer capabilities used by the desktop.

pub use gpui::*;

#[cfg(test)]
mod tests {
	/// The renderer types used by the desktop must remain available through
	/// this crate when the shared framework revision changes.
	#[test]
	fn the_shared_renderer_exports_the_types_the_surfaces_are_built_on() {
		use crate::{Bounds, Hsla, Pixels, Point, Size, px};

		let origin = Point { x: px(12.0), y: px(52.0) };
		let size = Size { width: px(256.0), height: px(800.0) };
		let bounds = Bounds { origin, size };

		let right: Pixels = bounds.right();
		assert_eq!(f32::from(right), 268.0);
		assert_eq!(f32::from(bounds.bottom()), 852.0);

		let opaque: Hsla = crate::hsla(0.0, 0.0, 0.5, 1.0);
		assert_eq!(opaque.a, 1.0);
	}
}
