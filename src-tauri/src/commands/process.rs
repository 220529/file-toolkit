use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub type ProcessSlot = Arc<Mutex<Option<u32>>>;

pub fn new_process_slot() -> ProcessSlot {
    Arc::new(Mutex::new(None))
}

pub struct ProcessTracker {
    slot: ProcessSlot,
    pid: u32,
    active: bool,
}

impl ProcessTracker {
    pub fn register(slot: &ProcessSlot, pid: u32) -> Self {
        *slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(pid);
        Self {
            slot: Arc::clone(slot),
            pid,
            active: true,
        }
    }

    pub fn clear(&mut self) {
        if !self.active {
            return;
        }

        let mut slot = self
            .slot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if *slot == Some(self.pid) {
            *slot = None;
        }
        self.active = false;
    }
}

impl Drop for ProcessTracker {
    fn drop(&mut self) {
        self.clear();
    }
}

pub fn kill_tracked_process(slot: &ProcessSlot) {
    let pid = *slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(pid) = pid {
        kill_process(pid);
    }
}

pub fn run_tracked_output(
    command: &mut Command,
    process_slot: Option<&ProcessSlot>,
    cancelled: Option<&AtomicBool>,
    failure_context: &str,
) -> Result<Output, String> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("{}: {}", failure_context, error))?;
    let _process_tracker = process_slot.map(|slot| ProcessTracker::register(slot, child.id()));

    if cancelled.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
        let _ = child.kill();
        let _ = child.wait();
        return Err("操作已取消".into());
    }

    let output = child
        .wait_with_output()
        .map_err(|error| format!("{}: {}", failure_context, error))?;
    if cancelled.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
        return Err("操作已取消".into());
    }
    Ok(output)
}

fn kill_process(pid: u32) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill").arg(pid.to_string()).status();
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .status();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracker_clears_registered_pid_on_drop() {
        let slot = new_process_slot();
        {
            let _tracker = ProcessTracker::register(&slot, 42);
            assert_eq!(
                *slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner()),
                Some(42)
            );
        }

        assert_eq!(
            *slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner()),
            None
        );
    }

    #[test]
    fn tracker_does_not_clear_replaced_pid() {
        let slot = new_process_slot();
        {
            let _tracker = ProcessTracker::register(&slot, 42);
            *slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(7);
        }

        assert_eq!(
            *slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner()),
            Some(7)
        );
    }
}
