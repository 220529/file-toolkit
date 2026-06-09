use std::process::{Command, Output, Stdio};

use super::super::process::{kill_tracked_process, new_process_slot, ProcessSlot, ProcessTracker};

lazy_static::lazy_static! {
    static ref WATERMARK_FFMPEG_PROCESS: ProcessSlot = new_process_slot();
}

pub(super) fn ffmpeg_process_slot() -> &'static ProcessSlot {
    &WATERMARK_FFMPEG_PROCESS
}

pub(super) fn kill_current_ffmpeg() {
    kill_tracked_process(&WATERMARK_FFMPEG_PROCESS);
}

pub(super) fn track_process(slot: &ProcessSlot, pid: u32) -> ProcessTracker {
    ProcessTracker::register(slot, pid)
}

pub(super) fn run_command_output(
    command: &mut Command,
    process_slot: Option<&ProcessSlot>,
    failure_context: &str,
) -> Result<Output, String> {
    let child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("{}: {}", failure_context, error))?;
    let _process_tracker = process_slot.map(|slot| ProcessTracker::register(slot, child.id()));

    child
        .wait_with_output()
        .map_err(|error| format!("{}: {}", failure_context, error))
}
