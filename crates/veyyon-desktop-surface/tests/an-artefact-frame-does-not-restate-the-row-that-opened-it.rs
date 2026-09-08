//! WHY: an artefact block is a 24px row and a frame it discloses. The row
//! states the artefact's identity and one summary of it — a pixel size, a line
//! and byte count, or the reason there is nothing to read. The frame restated
//! all of it: a mention of `src/architecture.png` opened onto `File:
//! src/architecture.png` above `image/webp · 200 × 200 px · 408 B`, with the
//! path and the pixel size already 24px above, and an unavailable file opened
//! onto `Unavailable: binary file` under a row whose summary was `binary file`.
//! Disclosure that repeats its own row spends a full column width saying
//! nothing.
//!
//! CLASS CLOSED:
//! 1. Any artefact shape whose frame restates the summary its row states, the
//!    identity its row titles, or the pixel size a decoded image put on the
//!    row.
//! 2. The other half of the same wiring: a frame that states nothing where the
//!    row had no room for a fact, which is what a mechanical "delete the
//!    duplicate line" fix produces. A decoded image's frame states its encoding
//!    and payload size; an unavailable file's frame states what was recorded of
//!    it.
//! 3. A new artefact shape arriving with no decision: the shape of every
//!    fixture is read through an exhaustive match that names every field of
//!    every `Artifact` variant, so a new variant or field fails to compile, and
//!    the fixture set is asserted to cover every shape the match can return.
//!
//! NOT CAUGHT: where the frame draws each fact, and the wording of a fact. This
//! suite reads the decision both halves render from, not the boxes GPUI lays
//! out for it; the rendered geometry of the row and the frame is what
//! `artifact-blocks-render-images-files-and-dispatch-actions` and
//! `artifact-image-geometry-enforces-height-ceiling-and-aspect-ratio` hold.

use std::{collections::BTreeSet, sync::Arc};

use image::{ImageBuffer, Rgba};
use veyyon_desktop_surface::{
	model::Artifact,
	transcript::blocks::artifact::{
		ArtifactFact, ArtifactRow, ImageStatus, artifact_facts, artifact_image_status, artifact_row,
	},
};

/// Every projection an artefact can take. A shape is a variant plus the fields
/// that steer what the row spends its one summary on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Shape {
	ImageDecoded,
	ImageCorrupt,
	FileWithDecodedImage,
	FileWithCorruptImage,
	FileCounted,
	FileLinesOnly,
	FileBytesOnly,
	FileContentOnly,
	FileBare,
	FileUnavailableMeasured,
	FileUnavailableBare,
}

impl Shape {
	/// The whole space, so a fixture set that misses one fails.
	const ALL: [Self; 11] = [
		Self::ImageDecoded,
		Self::ImageCorrupt,
		Self::FileWithDecodedImage,
		Self::FileWithCorruptImage,
		Self::FileCounted,
		Self::FileLinesOnly,
		Self::FileBytesOnly,
		Self::FileContentOnly,
		Self::FileBare,
		Self::FileUnavailableMeasured,
		Self::FileUnavailableBare,
	];
}

/// The shape of an artefact, read from the artefact rather than declared beside
/// it. Every field is named, so a new one on either variant fails to compile
/// here before it can reach a frame with no decision.
const fn shape_of(artifact: &Artifact, status: Option<&ImageStatus>) -> Shape {
	match artifact {
		Artifact::Image { media_type: _, data: _, alt: _ } => match status {
			Some(ImageStatus::Valid { .. }) => Shape::ImageDecoded,
			Some(ImageStatus::Error { .. }) | None => Shape::ImageCorrupt,
		},
		Artifact::File { path: _, has_content, lines, bytes, unavailable_reason, image } => {
			if image.is_some() {
				return match status {
					Some(ImageStatus::Valid { .. }) => Shape::FileWithDecodedImage,
					Some(ImageStatus::Error { .. }) | None => Shape::FileWithCorruptImage,
				};
			}
			match (unavailable_reason.is_some(), lines.is_some(), bytes.is_some(), *has_content) {
				(true, false, false, _) => Shape::FileUnavailableBare,
				(true, ..) => Shape::FileUnavailableMeasured,
				(false, true, true, _) => Shape::FileCounted,
				(false, true, false, _) => Shape::FileLinesOnly,
				(false, false, true, _) => Shape::FileBytesOnly,
				(false, false, false, true) => Shape::FileContentOnly,
				(false, false, false, false) => Shape::FileBare,
			}
		},
	}
}

fn png(w: u32, h: u32) -> Arc<[u8]> {
	let mut buffer: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::new(w, h);
	for pixel in buffer.pixels_mut() {
		*pixel = Rgba([0, 128, 255, 255]);
	}
	let mut bytes = Vec::new();
	let encoder = image::codecs::png::PngEncoder::new(&mut bytes);
	image::ImageEncoder::write_image(encoder, &buffer, w, h, image::ExtendedColorType::Rgba8)
		.expect("encoded png");
	Arc::from(bytes)
}

/// A PNG header followed by refuse, which decodes to an error rather than being
/// rejected before the decoder is reached.
fn corrupt_png() -> Arc<[u8]> {
	let mut bytes = png(4, 4).to_vec();
	let tail = bytes.len() - 16;
	bytes.truncate(tail);
	bytes.extend_from_slice(&[0xff; 16]);
	Arc::from(bytes)
}

fn file(
	lines: Option<u32>,
	bytes: Option<u64>,
	unavailable_reason: Option<&str>,
	image: Option<Arc<[u8]>>,
	has_content: bool,
) -> Artifact {
	Artifact::File {
		path: "src/vendor/architecture.png".to_owned(),
		has_content,
		lines,
		bytes,
		unavailable_reason: unavailable_reason.map(str::to_owned),
		image,
	}
}

fn fixtures() -> Vec<Artifact> {
	vec![
		Artifact::Image {
			media_type: "image/png".to_owned(),
			data:       png(200, 120),
			alt:        Some("a diagram of the ingest path".to_owned()),
		},
		Artifact::Image {
			media_type: "image/png".to_owned(),
			data:       corrupt_png(),
			alt:        None,
		},
		file(Some(4), Some(2048), None, Some(png(64, 64)), true),
		file(Some(4), Some(2048), None, Some(corrupt_png()), true),
		file(Some(12), Some(4096), None, None, true),
		file(Some(12), None, None, None, true),
		file(None, Some(4096), None, None, true),
		file(None, None, None, None, true),
		file(None, None, None, None, false),
		file(Some(9), Some(6144), Some("binary file"), None, false),
		file(None, None, Some("too large to read"), None, false),
	]
}

/// The row and the frame of one fixture, both read from the decode result the
/// production renderers pass them.
fn projected(artifact: &Artifact) -> (Shape, ArtifactRow, Vec<ArtifactFact>) {
	let status = artifact_image_status(artifact);
	(
		shape_of(artifact, status.as_ref()),
		artifact_row(artifact, status.as_ref()),
		artifact_facts(artifact, status.as_ref()),
	)
}

#[test]
fn every_artefact_shape_has_a_fixture() {
	let covered: BTreeSet<Shape> = fixtures()
		.iter()
		.map(|artifact| projected(artifact).0)
		.collect();
	let declared: BTreeSet<Shape> = Shape::ALL.into_iter().collect();
	assert_eq!(
		covered, declared,
		"a shape with no fixture has no decision anyone checked: covered {covered:?}"
	);
}

#[test]
fn a_frame_never_states_the_summary_its_row_states() {
	for artifact in fixtures() {
		let (shape, row, facts) = projected(&artifact);
		let Some(summary) = row.summary.as_deref() else {
			continue;
		};
		for fact in &facts {
			assert_ne!(
				fact.text, summary,
				"the {shape:?} frame states {:?}, which its row already states",
				fact.text
			);
			assert!(
				!fact.text.contains(summary),
				"the {shape:?} frame states {:?}, which carries the row's own summary {summary:?}",
				fact.text
			);
		}
	}
}

#[test]
fn a_frame_never_states_the_identity_its_row_titles() {
	for artifact in fixtures() {
		let (shape, row, facts) = projected(&artifact);
		for fact in &facts {
			assert!(
				!fact.text.contains(&row.title),
				"the {shape:?} frame states {:?}, which carries the row's title {:?}",
				fact.text,
				row.title
			);
		}
	}
}

#[test]
fn a_frame_never_states_the_pixel_size_a_decoded_image_put_on_its_row() {
	for artifact in fixtures() {
		let (shape, _, facts) = projected(&artifact);
		let Some(ImageStatus::Valid { width, height, .. }) = artifact_image_status(&artifact) else {
			continue;
		};
		for fact in &facts {
			for spelling in [
				format!("{width}×{height}"),
				format!("{width} × {height}"),
				format!("{width}x{height}"),
			] {
				assert!(
					!fact.text.contains(&spelling),
					"the {shape:?} frame states {:?}, which repeats the {spelling} its row states",
					fact.text
				);
			}
		}
	}
}

#[test]
fn a_decoded_image_frame_states_the_encoding_and_payload_its_row_had_no_room_for() {
	for artifact in fixtures() {
		let (shape, _, facts) = projected(&artifact);
		let Some(ImageStatus::Valid { format, .. }) = artifact_image_status(&artifact) else {
			continue;
		};
		let stated = facts
			.iter()
			.map(|fact| fact.text.as_str())
			.collect::<Vec<_>>()
			.join(" | ");
		assert!(
			stated.contains(format.mime_type()),
			"the {shape:?} frame draws an image and never states its encoding: {stated:?}"
		);
		assert!(
			stated.contains(" B") || stated.contains("KB") || stated.contains("MB"),
			"the {shape:?} frame draws an image and never states its payload size: {stated:?}"
		);
	}
}

#[test]
fn an_unavailable_file_frame_states_what_was_recorded_of_it() {
	let measured = file(Some(9), Some(6144), Some("binary file"), None, false);
	let (shape, row, facts) = projected(&measured);
	assert_eq!(shape, Shape::FileUnavailableMeasured);
	assert_eq!(row.summary.as_deref(), Some("binary file"));
	assert!(row.fault, "an unavailable file's row inks its summary as a fault");
	let stated = facts
		.iter()
		.map(|fact| fact.text.as_str())
		.collect::<Vec<_>>()
		.join(" | ");
	assert!(
		stated.contains('9') && stated.contains("6 KB"),
		"the frame of an unavailable file states the line and byte counts its row spent its summary \
		 instead of: {stated:?}"
	);

	let bare = file(None, None, Some("too large to read"), None, false);
	let (_, bare_row, bare_facts) = projected(&bare);
	assert_eq!(bare_row.summary.as_deref(), Some("too large to read"));
	assert!(
		bare_facts.is_empty(),
		"nothing was recorded of this file, so its frame has nothing to state: {bare_facts:?}"
	);
}

#[test]
fn a_file_whose_row_carries_its_counts_opens_onto_the_actions_alone() {
	for (artifact, expected) in [
		(file(Some(12), Some(4096), None, None, true), Shape::FileCounted),
		(file(Some(12), None, None, None, true), Shape::FileLinesOnly),
		(file(None, Some(4096), None, None, true), Shape::FileBytesOnly),
		(file(None, None, None, None, true), Shape::FileContentOnly),
		(file(None, None, None, None, false), Shape::FileBare),
	] {
		let (shape, _, facts) = projected(&artifact);
		assert_eq!(shape, expected);
		assert!(
			facts.is_empty(),
			"the {shape:?} row already states everything the host sent, so its frame states nothing \
			 beyond the artefact and the actions on it: {facts:?}"
		);
	}
}

#[test]
fn a_corrupt_image_frame_states_the_decode_failure_and_not_the_rows_verdict() {
	for artifact in fixtures() {
		let (shape, row, facts) = projected(&artifact);
		if !matches!(artifact_image_status(&artifact), Some(ImageStatus::Error { .. })) {
			continue;
		}
		assert!(row.fault, "the {shape:?} row inks a decode failure as a fault");
		assert_eq!(facts.len(), 1, "a decode failure is one line in the {shape:?} frame: {facts:?}");
		let fault = &facts[0];
		assert_eq!(
			fault.role,
			veyyon_desktop_surface::transcript::blocks::artifact::FactRole::Fault,
			"the {shape:?} frame inks the decode failure as a fault"
		);
		assert!(
			!fault.text.is_empty(),
			"the {shape:?} frame states why the image could not be drawn"
		);
	}
}
