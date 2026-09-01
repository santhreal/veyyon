//! Rasterized frame data, owned here rather than in `veyyon-gpui`.
//!
//! WHY THIS TYPE LIVES HERE: §8.29 places RGBA extraction helpers in
//! `veyyon-gpui`, and §8.31 gives two of the six clutter metrics a
//! `&RgbaFrame` input. If the type were declared in the gpui wrapper, every
//! metric would link a renderer and the claim in §7 that the whole state layer
//! and its gates are testable with no window and no renderer would be false.
//! So the frame is plain data here, and the P10 helper in `veyyon-gpui`
//! converts a headless surface readback into one.
//!
//! Coordinates: `width` and `height` are DEVICE pixels. Layout bounds
//! (`crate::layout`) are LOGICAL pixels. `scale_factor` converts between them,
//! and every metric that reads both states which space it works in.

use thiserror::Error;

/// A frame whose length disagrees with its declared dimensions, or whose
/// dimensions cannot describe a raster.
#[derive(Debug, Error, PartialEq)]
pub enum FrameError {
	#[error(
		"frame is {width}x{height} device px at scale {scale_factor}, which needs {expected} bytes \
		 of RGBA8, but {actual} were supplied"
	)]
	ByteCountMismatch {
		width:        u32,
		height:       u32,
		scale_factor: f32,
		expected:     usize,
		actual:       usize,
	},
	#[error("frame dimensions must both be non-zero, got {width}x{height}")]
	ZeroDimension { width: u32, height: u32 },
	#[error("scale factor must be finite and greater than zero, got {scale_factor}")]
	InvalidScaleFactor { scale_factor: f32 },
	#[error("frames differ in geometry: {a_width}x{a_height} against {b_width}x{b_height}")]
	GeometryMismatch { a_width: u32, a_height: u32, b_width: u32, b_height: u32 },
}

/// One straight sRGB colour, unpremultiplied.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Default)]
pub struct RgbaColor {
	pub r: u8,
	pub g: u8,
	pub b: u8,
	pub a: u8,
}

impl RgbaColor {
	pub const TRANSPARENT: Self = Self { r: 0, g: 0, b: 0, a: 0 };

	pub const fn opaque(r: u8, g: u8, b: u8) -> Self {
		Self { r, g, b, a: 255 }
	}

	pub const fn new(r: u8, g: u8, b: u8, a: u8) -> Self {
		Self { r, g, b, a }
	}

	/// True when the colour paints nothing.
	pub const fn is_invisible(&self) -> bool {
		self.a == 0
	}

	/// Rec. 709 luma on the sRGB bytes, in `0.0..=255.0`.
	///
	/// This is the quantity §8.31 metric 4 divides by 255 to get `ΔL`. It is
	/// deliberately NOT the linearized luminance below: metric 4 wants a
	/// cheap perceptual-ish delta over every pixel in the frame, and metric 3
	/// wants a WCAG contrast ratio at a handful of boundaries.
	pub fn luma_255(&self) -> f32 {
		0.0722_f32.mul_add(
			f32::from(self.b),
			0.7152_f32.mul_add(f32::from(self.g), 0.2126 * f32::from(self.r)),
		)
	}

	/// WCAG 2.1 relative luminance in `0.0..=1.0`, over linearized channels.
	pub fn relative_luminance(&self) -> f32 {
		fn linearize(channel: u8) -> f32 {
			let c = f32::from(channel) / 255.0;
			if c <= 0.040_45 {
				c / 12.92
			} else {
				((c + 0.055) / 1.055).powf(2.4)
			}
		}
		0.0722_f32.mul_add(
			linearize(self.b),
			0.7152_f32.mul_add(linearize(self.g), 0.2126 * linearize(self.r)),
		)
	}

	/// WCAG contrast ratio against `other`, always `>= 1.0`.
	pub fn contrast_ratio(&self, other: &Self) -> f32 {
		let a = self.relative_luminance();
		let b = other.relative_luminance();
		let (hi, lo) = if a >= b { (a, b) } else { (b, a) };
		(hi + 0.05) / (lo + 0.05)
	}

	/// Composite `self` over an opaque `ground` using straight alpha.
	pub fn over(&self, ground: &Self) -> Self {
		if self.a == 255 {
			return *self;
		}
		let alpha = f32::from(self.a) / 255.0;
		let mix = |src: u8, dst: u8| -> u8 {
			let v = f32::from(dst).mul_add(1.0 - alpha, f32::from(src) * alpha);
			v.round().clamp(0.0, 255.0) as u8
		};
		Self { r: mix(self.r, ground.r), g: mix(self.g, ground.g), b: mix(self.b, ground.b), a: 255 }
	}
}

/// An RGBA8 raster, row-major, four bytes per pixel, no row padding.
#[derive(Clone, PartialEq, Eq)]
pub struct RgbaFrame {
	width:               u32,
	height:              u32,
	scale_factor_millis: u32,
	pixels:              Vec<u8>,
}

impl std::fmt::Debug for RgbaFrame {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("RgbaFrame")
			.field("width", &self.width)
			.field("height", &self.height)
			.field("scale_factor", &self.scale_factor())
			.field("bytes", &self.pixels.len())
			.finish()
	}
}

impl RgbaFrame {
	/// Wrap a readback buffer. `width` and `height` are device pixels.
	pub fn new(
		width: u32,
		height: u32,
		scale_factor: f32,
		pixels: Vec<u8>,
	) -> Result<Self, FrameError> {
		if width == 0 || height == 0 {
			return Err(FrameError::ZeroDimension { width, height });
		}
		if !scale_factor.is_finite() || scale_factor <= 0.0 {
			return Err(FrameError::InvalidScaleFactor { scale_factor });
		}
		let expected = (width as usize)
			.checked_mul(height as usize)
			.and_then(|n| n.checked_mul(4))
			.ok_or(FrameError::ByteCountMismatch {
				width,
				height,
				scale_factor,
				expected: usize::MAX,
				actual: pixels.len(),
			})?;
		if pixels.len() != expected {
			return Err(FrameError::ByteCountMismatch {
				width,
				height,
				scale_factor,
				expected,
				actual: pixels.len(),
			});
		}
		Ok(Self {
			width,
			height,
			scale_factor_millis: (scale_factor * 1000.0).round().max(1.0) as u32,
			pixels,
		})
	}

	/// A frame filled with one colour, for tests and for sweep baselines.
	pub fn filled(
		width: u32,
		height: u32,
		scale_factor: f32,
		colour: RgbaColor,
	) -> Result<Self, FrameError> {
		let count = (width as usize).saturating_mul(height as usize);
		let mut pixels = Vec::with_capacity(count.saturating_mul(4));
		for _ in 0..count {
			pixels.extend_from_slice(&[colour.r, colour.g, colour.b, colour.a]);
		}
		Self::new(width, height, scale_factor, pixels)
	}

	pub const fn width(&self) -> u32 {
		self.width
	}

	pub const fn height(&self) -> u32 {
		self.height
	}

	/// Device pixels per logical pixel. Reconstructed from the stored
	/// thousandths so that `RgbaFrame` can derive `Eq` and `Hash`-free byte
	/// equality, which the §8.30 determinism contract compares directly.
	pub fn scale_factor(&self) -> f32 {
		self.scale_factor_millis as f32 / 1000.0
	}

	pub fn logical_width(&self) -> f32 {
		self.width as f32 / self.scale_factor()
	}

	pub fn logical_height(&self) -> f32 {
		self.height as f32 / self.scale_factor()
	}

	/// The exact bytes the determinism test in §8.30 compares.
	pub fn as_bytes(&self) -> &[u8] {
		&self.pixels
	}

	/// The colour at a device pixel, or `None` when out of bounds.
	pub fn pixel(&self, x: u32, y: u32) -> Option<RgbaColor> {
		if x >= self.width || y >= self.height {
			return None;
		}
		let offset = ((y as usize) * (self.width as usize) + (x as usize)) * 4;
		let bytes = self.pixels.get(offset..offset + 4)?;
		match bytes {
			[red, green, blue, alpha] => Some(RgbaColor::new(*red, *green, *blue, *alpha)),
			_ => None,
		}
	}

	/// Every pixel in raster order.
	pub fn pixels(&self) -> impl Iterator<Item = RgbaColor> + '_ {
		self.pixels.chunks_exact(4).filter_map(|c| match c {
			[r, g, b, a] => Some(RgbaColor::new(*r, *g, *b, *a)),
			_ => None,
		})
	}

	/// Convert a logical x to the nearest device column inside the frame.
	pub fn device_x(&self, logical_x: f32) -> Option<u32> {
		let scaled = (logical_x * self.scale_factor()).round();
		if !scaled.is_finite() || scaled < 0.0 || scaled >= self.width as f32 {
			return None;
		}
		Some(scaled as u32)
	}
}

/// How far two frames of the same geometry diverge. §9.6 reports one of these
/// per scene per token change, so a change aimed at the queue that moved the
/// composer is caught in the same second.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PerceptualDiff {
	/// Fraction of pixels whose `ΔL` exceeds the metric-4 noise floor.
	pub changed_fraction: f32,
	pub mean_delta:       f32,
	pub max_delta:        f32,
}

impl PerceptualDiff {
	/// True when no pixel moved past the noise floor.
	pub fn is_unchanged(&self) -> bool {
		self.changed_fraction == 0.0
	}
}
