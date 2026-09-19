//! Seeds shell states that draw the transcript surface across its geometry
//! clamps.
//!
//! Covers user and assistant typography ramps, horizontal column bounds, block
//! rhythm gaps, and the expansion caps for mono panes, code fences, images, and
//! plans.

use std::time::Duration;

use image::{ExtendedColorType, ImageBuffer, ImageEncoder, Rgba, codecs::png::PngEncoder};
use veyyon_desktop_scene::Headless;
use veyyon_desktop_surface::{
	fixture,
	model::{Artifact, Block, ShellState, ToolInvocationViews, Turn},
};
use veyyon_desktop_tokens::Tokens;

use crate::dead_token_probe::{
	Observation,
	shell::{self, Prepared, Seeded},
};

fn make_png(width: u32, height: u32) -> Vec<u8> {
	let mut img: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::new(width, height);
	for pixel in img.pixels_mut() {
		*pixel = Rgba([180, 80, 80, 255]);
	}
	let mut bytes = Vec::new();
	let enc = PngEncoder::new(&mut bytes);
	ImageEncoder::write_image(enc, &img, width, height, ExtendedColorType::Rgba8)
		.expect("the probe png must encode");
	bytes
}

fn seeded_overview() -> ShellState {
	let mut state = fixture::populated();
	state.transcript = vec![
		Turn::Operator(
			"What does the transcript surface render across its tokens? This operator prompt is \
			 authored with sufficient length to test the user turn width ratio and column width \
			 constraints, forcing the bubble to hit maximum width and wrap across multiple lines."
				.to_owned(),
		),
		Turn::Agent {
			blocks: vec![
				Block::Prose(
					"The transcript renders assistant prose at reading size with structured markdown. \
					 This text spans the full column width to ensure that changes in column width \
					 alter the line wrap layout in the raster output."
						.to_owned(),
				),
				Block::Note { label: "Model", text: "gpt-4o".to_owned(), boundary: false },
				Block::Note { label: "Mode", text: "plan".to_owned(), boundary: false },
				Block::Unknown { producer: "event".to_owned(), lines: vec![] },
				Block::Reason("Thinking through token layout and geometry clamps.".to_owned()),
			],
			model:  Some("claude-sonnet-4-6".to_owned()),
		},
		Turn::Agent {
			blocks: vec![Block::Prose("A subsequent turn proves the turns gap.".to_owned())],
			model:  None,
		},
	];
	state
}

fn seeded_operator_only() -> ShellState {
	let mut state = fixture::populated();
	state.cards = vec![];
	state.drawer_open = false;
	state.transcript = vec![Turn::Operator(
		"What does the transcript surface render across its tokens? This operator prompt is \
		 authored with sufficient length to test the user turn width ratio and column width \
		 constraints, forcing the bubble to hit maximum width and wrap across multiple lines."
			.to_owned(),
	)];
	state
}

fn seeded_prose_only() -> ShellState {
	let mut state = fixture::populated();
	state.cards = vec![];
	state.drawer_open = false;
	state.transcript = vec![Turn::Agent {
		blocks: vec![Block::Prose(
			"| Alpha | Beta | Gamma | Delta |\n|---|---|---|---|\n| 1 | 2 | 3 | 4 |".to_owned(),
		)],
		model:  None,
	}];
	state
}
fn seeded_table() -> ShellState {
	let mut state = fixture::populated();
	state.transcript = vec![Turn::Agent {
		blocks: vec![Block::Prose(
			"| Step | Name | Status |\n|---|---|---|\n| 1 | Measurement | Active |\n| 2 | \
			 Verification | Pending |\n| 3 | Delivery | Queued |"
				.to_owned(),
		)],
		model:  None,
	}];
	state
}

fn seeded_invoke() -> ShellState {
	let mut state = fixture::populated();
	let multiline_output = (1..30)
		.map(|i| format!("Output row {i} produced by tool"))
		.collect::<Vec<_>>()
		.join("\n");
	state.transcript = vec![Turn::Agent {
		blocks: vec![Block::Invoke {
			call_id: "c-invoke".to_owned(),
			tool:    "read_file".to_owned(),
			target:  "src/main.rs".to_owned(),
			result:  Some(multiline_output),
			views:   ToolInvocationViews::default(),
		}],
		model:  None,
	}];
	state.keymap.focused_turn = Some(0);
	state.keymap.focused_block_collapsed = true;
	state
}

fn seeded_artifact() -> ShellState {
	let mut state = fixture::populated();
	state.transcript = vec![Turn::Agent {
		blocks: vec![Block::Artifact(Artifact::Image {
			media_type: "image/png".to_owned(),
			data:       make_png(300, 600).into(),
			alt:        None,
		})],
		model:  None,
	}];
	state.keymap.focused_turn = Some(0);
	state.keymap.focused_block_collapsed = true;
	state
}

/// A single reasoning block, whose expanded summary is the only thing that
/// draws the reasoning summary strength.
fn seeded_reason() -> ShellState {
	let mut state = fixture::populated();
	state.transcript = vec![Turn::Agent {
		blocks: vec![Block::Reason(
			"Weighing the column clamp against the wrap width, then settling on the narrower of the \
			 two so the summary keeps its own measure across the whole reveal."
				.to_owned(),
		)],
		model:  None,
	}];
	state
}

fn seeded_code_pane() -> ShellState {
	let mut state = fixture::populated();
	let lines = (1..50)
		.map(|i| format!("fn line_{i}() {{ println!(\"row {i}\"); }}"))
		.collect();
	state.transcript = vec![Turn::Agent {
		blocks: vec![Block::Pane { caption: "code.rs".to_owned(), lines }],
		model:  None,
	}];
	state.keymap.focused_turn = Some(0);
	state.keymap.focused_block_collapsed = true;
	state
}

fn seeded_plan_pane() -> ShellState {
	let mut state = fixture::populated();
	let lines = (1..50)
		.map(|i| format!("{i}. Execute step {i} of the verification plan"))
		.collect();
	state.transcript = vec![Turn::Agent {
		blocks: vec![Block::Pane { caption: "Plan".to_owned(), lines }],
		model:  None,
	}];
	state.keymap.focused_turn = Some(0);
	state.keymap.focused_block_collapsed = true;
	state
}

pub fn observations(cx: &mut Headless, tokens: &Tokens) -> Vec<Observation> {
	let states = vec![
		Seeded {
			name:    "transcript_operator",
			options: shell::wide(),
			state:   seeded_operator_only(),
		},
		Seeded { name: "transcript_prose", options: shell::wide(), state: seeded_prose_only() },
		Seeded { name: "transcript_overview", options: shell::wide(), state: seeded_overview() },
		Seeded { name: "transcript_table", options: shell::wide(), state: seeded_table() },
		Seeded { name: "transcript_invoke", options: shell::wide(), state: seeded_invoke() },
		Seeded { name: "transcript_artifact", options: shell::wide(), state: seeded_artifact() },
		Seeded {
			name:    "transcript_code_pane",
			options: shell::wide(),
			state:   seeded_code_pane(),
		},
		Seeded {
			name:    "transcript_plan_pane",
			options: shell::wide(),
			state:   seeded_plan_pane(),
		},
	];
	let mut observations = shell::render(cx, tokens, states);
	observations.extend(shell::render_prepared(cx, tokens, vec![Prepared {
		name:    "transcript_reason_expanded",
		options: shell::wide(),
		state:   seeded_reason(),
		// The reveal fades over 60ms even reduced, so it is started far enough
		// in the past that the first frame samples it settled and the summary
		// draws at its own strength rather than at the fade's.
		prepare: |view, installed, now| {
			// The first frame switches the viewport onto the session, which
			// clears the expansion it restores for that id, so the switch
			// happens here first and the frame's own is a no-op.
			let viewport = view.transcript_viewport();
			viewport.switch_session(view.state().current_id, view.state().transcript.len());
			let settled = now.checked_sub(Duration::from_secs(1)).unwrap_or(now);
			viewport.set_block_expanded(0, 0, true, &installed.motion, true, settled);
		},
	}]));
	observations
}
