//! Paths, and rasters.

use super::{Badge, Tone};

/// A list of paths and what happened to each.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Files {
	pub entries: Vec<PathEntry>,
	/// Entries the producer dropped, for a listing that hit its own limit.
	pub omitted: usize,
}

impl Files {
	pub fn new(entries: Vec<PathEntry>) -> Files {
		Files { entries, omitted: 0 }
	}

	pub fn omitted(mut self, omitted: usize) -> Files {
		self.omitted = omitted;
		self
	}
}

/// One path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathEntry {
	/// The path as the tool saw it. A host shortens it for display; the data
	/// keeps it whole, because a shortened path cannot be opened.
	pub path:   String,
	/// What happened: `read`, `written`, `skipped`, `+12 −3`.
	pub detail: Option<String>,
	pub tone:   Option<Tone>,
	pub badges: Vec<Badge>,
}

impl PathEntry {
	pub fn new(path: impl Into<String>) -> PathEntry {
		PathEntry { path: path.into(), detail: None, tone: None, badges: Vec::new() }
	}

	pub fn detail(mut self, detail: impl Into<String>) -> PathEntry {
		self.detail = Some(detail.into());
		self
	}

	pub fn tone(mut self, tone: Tone) -> PathEntry {
		self.tone = Some(tone);
		self
	}

	pub fn badge(mut self, badge: Badge) -> PathEntry {
		self.badges.push(badge);
		self
	}
}

/// A raster a tool returned: a screenshot, a decoded image, a captured frame.
///
/// The bytes are not here. A view kind that carried image bytes would put a
/// megabyte on the transport for every redraw, so this names where they are and
/// what shape they are, and a host loads them once.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Image {
	/// Where the bytes are: a path, or a content-addressed key.
	pub source:     String,
	/// The media type, so a host decodes without sniffing.
	pub media_type: String,
	/// Pixel dimensions, when the producer decoded far enough to know them.
	/// A host reserves the right box before the bytes arrive, so an image
	/// appearing does not reflow the transcript under the reader.
	pub size:       Option<(u32, u32)>,
	pub caption:    Option<String>,
}

impl Image {
	pub fn new(source: impl Into<String>, media_type: impl Into<String>) -> Image {
		Image {
			source:     source.into(),
			media_type: media_type.into(),
			size:       None,
			caption:    None,
		}
	}

	pub fn size(mut self, width: u32, height: u32) -> Image {
		self.size = Some((width, height));
		self
	}

	pub fn caption(mut self, caption: impl Into<String>) -> Image {
		self.caption = Some(caption.into());
		self
	}

	/// The box to reserve, scaled to fit `available` width without upscaling.
	///
	/// [`None`] when the size is not known yet, which is a host's cue to draw a
	/// placeholder of its own choosing rather than guess an aspect ratio.
	pub fn fitted(&self, available: f32) -> Option<(f32, f32)> {
		let (width, height) = self.size?;
		let (width, height) = (width as f32, height as f32);
		if width <= 0.0 || height <= 0.0 {
			return None;
		}
		let scale = (available / width).min(1.0);
		Some((width * scale, height * scale))
	}
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! [`Image::fitted`] reserves the box an image occupies before its bytes
	//! load. Upscaling a small raster to the window width is the failure that
	//! looks deliberate, and a zero dimension — which a producer that failed to
	//! decode will report — divides into an infinite height that a layout pass
	//! turns into a blank window rather than an error.
	//!
	//! WHAT IT DOES NOT CATCH. Whether a host honours the box it is given.

	use super::*;

	#[test]
	fn a_wide_image_scales_down_to_the_available_width() {
		let image = Image::new("shot.png", "image/png").size(1600, 900);
		assert_eq!(image.fitted(800.0), Some((800.0, 450.0)));
	}

	#[test]
	fn a_small_image_is_not_upscaled() {
		let image = Image::new("icon.png", "image/png").size(64, 64);
		assert_eq!(image.fitted(800.0), Some((64.0, 64.0)));
	}

	#[test]
	fn an_undecoded_image_reserves_nothing() {
		assert_eq!(Image::new("shot.png", "image/png").fitted(800.0), None);
	}

	#[test]
	fn a_zero_dimension_reserves_nothing_rather_than_an_infinite_box() {
		let image = Image::new("broken.png", "image/png").size(0, 900);
		assert_eq!(image.fitted(800.0), None);
	}
}
