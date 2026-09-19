//! What a float is made of: its ground, its backdrop, its grain and its
//! shadows (§6.5).
//!
//! A float is the one surface the system draws off the ground, so the values
//! that lift it are resolved together here rather than restated at each float.
//! Every value comes from the elevation token file. A level that carries no
//! glass, no grain and no shadow resolves to the identity of each — opaque,
//! unsaturated, uninked — rather than to a second copy of what the file
//! states.

use veyyon_desktop_tokens::elevation::ShadowCurve;
use veyyon_gpui::{BoxShadow, Hsla, Pixels, point, px};

use super::TokenSet;
use crate::ColorRole;

impl TokenSet {
	/// Resolves background color for float elevation (level 4) with token
	/// opacity.
	#[must_use]
	pub fn float_ground(&self) -> Hsla {
		let mut bg = self.color(ColorRole::Float);
		bg.a = self.elevation().float().ground_opacity();
		bg
	}

	/// Resolves backdrop blur radius in pixels for floating surfaces.
	#[must_use]
	pub fn float_blur(&self) -> Pixels {
		px(self.elevation().float().blur_px)
	}

	/// Resolves backdrop blur radius for menu and dialog frosted overlays
	/// (§2.1).
	#[must_use]
	pub fn overlay_blur(&self) -> Pixels {
		px(self.elevation().overlay_blur_px)
	}

	/// Resolves backdrop saturation factor for floating surfaces.
	#[must_use]
	pub fn float_saturation(&self) -> f32 {
		self.elevation().float().saturation()
	}

	/// Resolves top inner highlight color for lit top edges (§6.5).
	#[must_use]
	pub fn inner_highlight(&self) -> Hsla {
		let model = &self.elevation().float_shadow;
		let a = if self.ground_is_dark() {
			model.inner_highlight_dark
		} else {
			model.inner_highlight_light
		};
		Hsla { h: 0.0, s: 0.0, l: 1.0, a }
	}

	/// Resolves whether grain is enabled on level 0 (shell ground) (§6.5).
	#[must_use]
	pub fn grain_enabled(&self) -> bool {
		self.elevation().shell_ground().grain_enabled
	}

	/// Resolves grain opacity for level 0 (shell ground) (§6.5).
	#[must_use]
	pub fn grain_opacity(&self) -> f32 {
		self.elevation().shell_ground().grain_opacity()
	}

	/// Resolves grain texture name for level 0 (§6.5).
	#[must_use]
	pub fn grain_texture(&self) -> Option<&str> {
		self.elevation().shell_ground().grain_texture.as_deref()
	}

	/// Whether the window sits on a dark ground, which decides whether a
	/// shadow inks with the ground colour or with the foreground.
	fn ground_is_dark(&self) -> bool {
		self.color(ColorRole::Ground).l < 0.5
	}

	/// Builds one cast shadow of the float model at `rise_px`.
	fn cast_shadow(&self, curve: &ShadowCurve, rise_px: f32, base_opacity: f32) -> BoxShadow {
		let is_dark = self.ground_is_dark();
		let mut color = self.color(if is_dark {
			ColorRole::Ground
		} else {
			ColorRole::Foreground
		});
		color.a = base_opacity * curve.opacity_factor(is_dark);
		BoxShadow {
			color,
			offset: point(px(0.0), px(curve.offset_y(rise_px))),
			blur_radius: px(curve.blur(rise_px)),
			spread_radius: px(curve.spread(rise_px)),
			inset: false,
		}
	}

	/// Resolves physically plausible layered shadows for a float at a given rise
	/// (§6.5).
	#[must_use]
	pub fn float_shadows_elevation(&self, rise_px: f32) -> Vec<BoxShadow> {
		let elevation = self.elevation();
		let model = &elevation.float_shadow;
		let base = elevation.float().shadow_opacity();
		vec![
			self.cast_shadow(&model.ambient, rise_px, base),
			self.cast_shadow(&model.key, rise_px, base),
			BoxShadow {
				color:         self.inner_highlight(),
				offset:        point(px(0.0), px(model.inner_highlight_y_px)),
				blur_radius:   px(0.0),
				spread_radius: px(0.0),
				inset:         true,
			},
		]
	}

	/// Resolves default level 4 box shadow set (outer drop shadows + inner top
	/// highlight) at the rise the design system rests a float at.
	#[must_use]
	pub fn float_shadows(&self) -> Vec<BoxShadow> {
		self.float_shadows_elevation(self.elevation().float_shadow.default_rise_px)
	}

	/// The shadows the elevation level at `index` declares: the float model at
	/// its resting rise for a level that casts one, and none for a level that
	/// does not. A surface states the level it sits at rather than a rise,
	/// because the rise is the design system's and the level is the surface's
	/// (§6.5).
	#[must_use]
	pub fn level_shadows(&self, index: u8) -> Vec<BoxShadow> {
		let elevation = self.elevation();
		let casts = elevation
			.level(usize::from(index))
			.is_some_and(|level| level.shadow_opacity() > 0.0);
		if casts {
			self.float_shadows()
		} else {
			Vec::new()
		}
	}
}
