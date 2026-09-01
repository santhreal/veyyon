//! The desktop front end's view of GPUI.
//!
//! GPUI is a vendored snapshot of the `santhreal/zed` fork, branch `veyyon`,
//! under `crates/vendor`, at the commit recorded in
//! `crates/vendor/GPUI_VENDOR_REV`. That branch carries the patch series;
//! `scripts/vendor-gpui.ts` extracts one commit of it. The golden tests under
//! `tests/` prove each patch through the snapshot.
//!
//! Every patch extension gets a module here WHEN the patch exists on the
//! branch. Until then this crate is a re-export and nothing more, so that the
//! absence of a capability is visible as a missing symbol at the call site
//! rather than as a module that compiles and does nothing.

pub use gpui::*;

#[cfg(test)]
mod tests {
	/// The snapshot is only useful if the symbols the desktop front end builds
	/// on are actually reachable through this crate. A re-export that resolves
	/// to nothing still compiles, so name the types the surfaces are written
	/// against and let a failed re-vendor break here rather than in every
	/// consumer.
	#[test]
	fn the_vendored_renderer_exports_the_types_the_surfaces_are_built_on() {
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
