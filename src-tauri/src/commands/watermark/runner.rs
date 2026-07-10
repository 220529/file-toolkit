use std::process::{Command, Output};
use std::sync::atomic::AtomicBool;

use super::super::process::{
    kill_tracked_process, new_process_slot, run_tracked_output, ProcessSlot, ProcessTracker,
};

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
    cancelled: Option<&AtomicBool>,
    failure_context: &str,
) -> Result<Output, String> {
    run_tracked_output(command, process_slot, cancelled, failure_context)
}
