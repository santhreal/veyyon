//! Level 0 shell ground grain tile inking (§6.5).

use std::sync::Arc;

use veyyon_desktop_tokens::ShellSurfaceTokens;
use veyyon_gpui::{
	AnyElement, Bounds, Corners, IntoElement, ParentElement, Styled, canvas, div, point, px, size,
};

pub use super::blue_noise;

/// Renders the level 0 ground grain layer over the window if configured.
pub fn ground_grain(shell: &ShellSurfaceTokens) -> Option<AnyElement> {
	let tile_size = shell.grain_tile_px;
	let opacity = shell.grain_opacity;
	if tile_size <= 0.0 || opacity <= 0.0 {
		return None;
	}

	let noise_image = blue_noise::blue_noise_image();
	Some(
		div()
			.absolute()
			.inset_0()
			.opacity(opacity.min(1.0))
			.child(
				canvas(
					|_bounds, _window, _cx| (),
					move |bounds, (), window, _cx| {
						let tile = tile_size.max(1.0);
						let width = f32::from(bounds.size.width);
						let height = f32::from(bounds.size.height);
						// The tile count is integral, so the walk does not accumulate a
						// float across a row and compare the sum against the edge.
						let columns = (width / tile).ceil().max(0.0) as u32;
						let rows = (height / tile).ceil().max(0.0) as u32;
						for row in 0..rows {
							let y = row as f32 * tile;
							let h = tile.min(height - y);
							for column in 0..columns {
								let x = column as f32 * tile;
								let w = tile.min(width - x);
								let tile_bounds = Bounds {
									origin: point(bounds.left() + px(x), bounds.top() + px(y)),
									size:   size(px(w), px(h)),
								};
								let image_bounds = Bounds {
									origin: point(bounds.left() + px(x), bounds.top() + px(y)),
									size:   size(px(tile), px(tile)),
								};
								let _ = window.paint_image(
									tile_bounds,
									image_bounds,
									Corners::default(),
									Arc::clone(&noise_image),
									0,
									false,
								);
							}
						}
					},
				)
				.size_full(),
			)
			.into_any_element(),
	)
}
