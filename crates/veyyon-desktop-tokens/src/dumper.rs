use std::{fmt::Write, fs, path::Path};

use crate::{
	Tokens,
	dumper_surface::{
		dump_attached_cards, dump_breakpoints, dump_composer, dump_palette, dump_panels, dump_queue,
		dump_settings, dump_shell, dump_transcript,
	},
	error::TokenError,
	schema::SpacingStep,
};

/// Serializes in-memory live token set into authored TOML files.
pub fn dump_to_dir(tokens: &Tokens, dir: &Path) -> Result<(), TokenError> {
	fs::create_dir_all(dir.join("surface"))
		.map_err(|e| TokenError::Io { path: dir.to_path_buf(), source: e })?;

	dump_scale(tokens, &dir.join("scale.toml"))?;
	dump_elevation(tokens, &dir.join("elevation.toml"))?;
	dump_ceilings(tokens, &dir.join("ceilings.toml"))?;
	dump_motion(tokens, &dir.join("motion.toml"))?;
	dump_queue(tokens, &dir.join("surface/queue.toml"))?;
	dump_transcript(tokens, &dir.join("surface/transcript.toml"))?;
	dump_composer(tokens, &dir.join("surface/composer.toml"))?;
	dump_attached_cards(tokens, &dir.join("surface/attached-cards.toml"))?;
	dump_panels(tokens, &dir.join("surface/panels.toml"))?;
	dump_palette(tokens, &dir.join("surface/palette.toml"))?;
	dump_settings(tokens, &dir.join("surface/settings.toml"))?;
	dump_breakpoints(tokens, &dir.join("surface/breakpoints.toml"))?;
	dump_shell(tokens, &dir.join("surface/shell.toml"))?;

	Ok(())
}

pub(crate) fn write_file(path: &Path, content: &str) -> Result<(), TokenError> {
	fs::write(path, content).map_err(|e| TokenError::Io { path: path.to_path_buf(), source: e })
}

fn dump_scale(tokens: &Tokens, path: &Path) -> Result<(), TokenError> {
	let mut out = String::from("[meta]\nversion = 1\nname = \"scale\"\n\n[spacing]\n");
	for step in SpacingStep::all() {
		let _ = writeln!(out, "{:<3} = {}", step.as_token(), tokens.scale.spacing(step) as i64);
	}
	out.push_str(
		"\n[radius]\nnone = 0\nxs   = 4\nsm   = 6\nmd   = 8\nlg   = 10\nxl   = 14\nxxl  = 18\nfull \
		 = 9999\n",
	);
	out.push_str(
		"\n[type.size]\nmicro = { size = 11, line_height = 16, tracking_em = 0.04 }\nsmall = { size \
		 = 12, line_height = 16, tracking_em = 0.00 }\nbody  = { size = 13, line_height = 18, \
		 tracking_em = 0.00 }\nread  = { size = 14, line_height = 22, tracking_em = 0.00 }\nhead  = \
		 { size = 18, line_height = 24, tracking_em = -0.01 }\nlead  = { size = 26, line_height = \
		 32, tracking_em = -0.02 }\n",
	);
	out.push_str("\n[type.weight]\nregular  = 400\nmedium   = 500\nsemibold = 600\n");
	out.push_str(
		"\n[type.mono]\nsmall = { size = 11, line_height = 16 }\nbody  = { size = 12, line_height = \
		 18 }\n",
	);
	out.push_str("\n[stroke]\nhairline = 1.0\nicon     = 1.5\nheavy    = 2.0\n");
	write_file(path, &out)
}

fn dump_elevation(tokens: &Tokens, path: &Path) -> Result<(), TokenError> {
	let mut out = String::from("[meta]\nversion = 1\nname = \"elevation\"\n\n");
	for lvl in &tokens.elevation.levels {
		let _ = write!(
			out,
			"[[level]]\nindex = {}\nrole = \"{}\"\nground_role = \"{}\"\ngrain_enabled = {}\n",
			lvl.index, lvl.role, lvl.ground_role, lvl.grain_enabled
		);
		if let Some(tex) = &lvl.grain_texture {
			let _ = writeln!(out, "grain_texture = \"{tex}\"");
		}
		if let Some(op) = lvl.grain_opacity {
			let _ = writeln!(out, "grain_opacity = {op}");
		}
		let _ = writeln!(out, "blur_px = {}", lvl.blur_px as i64);
		if let Some(sat) = lvl.saturation {
			let _ = writeln!(out, "saturation = {sat}");
		}
		if let Some(gop) = lvl.ground_opacity {
			let _ = writeln!(out, "ground_opacity = {gop}");
		}
		let _ = writeln!(out, "edge = \"{}\"\nhas_shadow = {}", lvl.edge, lvl.has_shadow);
		if let Some(sx) = lvl.shadow_x {
			let _ = writeln!(out, "shadow_x = {}", sx as i64);
		}
		if let Some(sy) = lvl.shadow_y {
			let _ = writeln!(out, "shadow_y = {}", sy as i64);
		}
		if let Some(sb) = lvl.shadow_blur {
			let _ = writeln!(out, "shadow_blur = {}", sb as i64);
		}
		if let Some(ss) = lvl.shadow_spread {
			let _ = writeln!(out, "shadow_spread = {}", ss as i64);
		}
		if let Some(so) = lvl.shadow_opacity {
			let _ = writeln!(out, "shadow_opacity = {so}");
		}
		out.push('\n');
	}
	write_file(path, &out)
}

fn dump_ceilings(tokens: &Tokens, path: &Path) -> Result<(), TokenError> {
	let c = &tokens.ceilings;
	let out = format!(
		r#"[meta]
version = 1
name = "ceilings"

[ceilings.queue_card]
edges = {}
distinct_gaps = {}
text_sizes = {}
interactive_elements = {}

[ceilings.queue_line]
edges = {}
distinct_gaps = {}
text_sizes = {}
interactive_elements = {}

[ceilings.transcript_turn]
edges = {}
distinct_gaps = {}
text_sizes = {}
interactive_elements = {}

[ceilings.block_chrome]
edges = {}
distinct_gaps = {}
text_sizes = {}
interactive_elements = {}

[ceilings.composer]
edges = {}
distinct_gaps = {}
text_sizes = {}
interactive_elements = {}

[ceilings.right_panel_chrome]
edges = {}
distinct_gaps = {}
text_sizes = {}
interactive_elements = {}

[ceilings.terminal_drawer_chrome]
edges = {}
distinct_gaps = {}
text_sizes = {}
interactive_elements = {}

[ceilings.whole_window]
edges = {}
distinct_gaps = {}
text_sizes = {}
interactive_elements = {}

[ceilings.density_region]
sample_box_px = {}
max_interactive_per_1000px2 = {}
"#,
		c.queue_card.edges,
		c.queue_card.distinct_gaps,
		c.queue_card.text_sizes,
		c.queue_card.interactive_elements,
		c.queue_line.edges,
		c.queue_line.distinct_gaps,
		c.queue_line.text_sizes,
		c.queue_line.interactive_elements,
		c.transcript_turn.edges,
		c.transcript_turn.distinct_gaps,
		c.transcript_turn.text_sizes,
		c.transcript_turn.interactive_elements,
		c.block_chrome.edges,
		c.block_chrome.distinct_gaps,
		c.block_chrome.text_sizes,
		c.block_chrome.interactive_elements,
		c.composer.edges,
		c.composer.distinct_gaps,
		c.composer.text_sizes,
		c.composer.interactive_elements,
		c.right_panel_chrome.edges,
		c.right_panel_chrome.distinct_gaps,
		c.right_panel_chrome.text_sizes,
		c.right_panel_chrome.interactive_elements,
		c.terminal_drawer_chrome.edges,
		c.terminal_drawer_chrome.distinct_gaps,
		c.terminal_drawer_chrome.text_sizes,
		c.terminal_drawer_chrome.interactive_elements,
		c.whole_window.edges,
		c.whole_window.distinct_gaps,
		c.whole_window.text_sizes,
		c.whole_window.interactive_elements,
		c.density_region.sample_box_px as i64,
		c.density_region.max_interactive_per_1000px2
	);
	write_file(path, &out)
}

fn dump_motion(_tokens: &Tokens, path: &Path) -> Result<(), TokenError> {
	let out = r#"[meta]
version = 1
name = "motion"

[role.tint]
model = "duration"
duration_ms = 120
curve = "ease_out"
reduced_motion = "instant"

[role.reveal]
model = "spring"
stiffness = 220.0
damping = 26.0
mass = 1.0
reduced_motion = "fade_instant"

[role.float]
model = "spring_fade"
stiffness = 300.0
damping = 24.0
mass = 1.0
rise_px = 4.0
fade_duration_ms = 90
reduced_motion = "opacity_only"

[role.panel]
model = "direct_then_spring"
stiffness = 180.0
damping = 22.0
mass = 1.0
reduced_motion = "direct"

[role.shift]
model = "flip"
duration_ms = 200
curve = "ease_out"
reduced_motion = "instant"

[role.scroll]
model = "duration"
duration_ms = 240
curve = "ease_in_out"
reduced_motion = "instant"

[role.caret]
model = "two_step"
period_ms = 900
reduced_motion = "steady_on"
"#;
	write_file(path, out)
}
