//! One-time carry-over from builds named Muse Code. Their bundle identifier,
//! `com.musecode.desktop`, named the app data and log folders and the keychain
//! service, and the rename to Glitter changed all three. On first launch this
//! moves an existing install's settings, threads, snapshots, logs and keys
//! across, so nothing has to be set up again.
//!
//! Worktrees stay where they are. Their paths are recorded in each
//! repository's git metadata, in the workspace grants and in every agent CLI's
//! own session store, which this app cannot rewrite, so moving them would break
//! resuming those threads. The app keeps serving them from the old folder
//! (`legacy_worktree_store` in `lib.rs`) until each one is removed.

use std::path::{Path, PathBuf};

/// The bundle identifier of builds named Muse Code.
pub const IDENTIFIER: &str = "com.musecode.desktop";
/// Left in the app data folder once nothing is left to carry over.
const DONE: &str = ".muse-code-migrated";

/// The folder a Muse Code build used in place of `dir`, one of this app's
/// identifier-named folders.
pub fn sibling(dir: &Path) -> PathBuf {
    dir.with_file_name(IDENTIFIER)
}

/// New name for an entry of the old app data folder; `None` leaves it there.
fn data_name(name: &str) -> Option<String> {
    match name {
        "harness" | "turn-snapshots" => Some(name.to_string()),
        // The settings document and its `.bak`, `.tmp.*` and `.corrupt` siblings.
        _ => name.strip_prefix("muse-desktop.json").map(|rest| format!("glitter.json{rest}")),
    }
}

/// New name for an entry of the old log folder; `None` leaves it there.
fn log_name(name: &str) -> Option<String> {
    match name {
        "muse-desktop.log" => Some("glitter.log".into()),
        "muse-desktop.previous.log" => Some("glitter.previous.log".into()),
        "security-audit.log" | "security-audit.previous.log" => Some(name.to_string()),
        _ => None,
    }
}

/// Move the entries `rename` names from `from` into `to`, never over one that
/// is already there, then drop `from` if that emptied it. Returns what failed.
fn move_entries(from: &Path, to: &Path, rename: fn(&str) -> Option<String>) -> Vec<String> {
    let entries = match std::fs::read_dir(from) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(err) => return vec![format!("{}: {err}", from.display())],
    };
    let mut failed = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(new_name) = rename(&name) else {
            continue;
        };
        let target = to.join(new_name);
        // Whatever this app already saved there is newer.
        if target.symlink_metadata().is_ok() {
            continue;
        }
        if let Err(err) = std::fs::create_dir_all(to).and_then(|_| std::fs::rename(entry.path(), &target)) {
            failed.push(format!("{name}: {err}"));
        }
    }
    let _ = std::fs::remove_dir(from);
    failed
}

/// Move a Muse Code install's files into this app's data and log folders.
fn move_files(data: &Path, logs: &Path) -> Vec<String> {
    let mut failed = move_entries(&sibling(data), data, data_name);
    failed.extend(move_entries(&sibling(logs), logs, log_name));
    failed
}

/// Carry a Muse Code install over to this app's folders and keychain service.
/// Runs at startup before anything reads them. Once a pass finishes cleanly it
/// leaves a marker and later launches only check for it; a failed step is
/// retried on the next launch. Returns a line for the app log when there was
/// anything to do.
pub fn migrate(data: &Path, logs: &Path) -> Option<(&'static str, String)> {
    if data.join(DONE).exists() {
        return None;
    }
    let found = sibling(data).exists() || sibling(logs).exists();
    let mut failed = move_files(data, logs);
    if let Err(err) = crate::credentials::carry_over_legacy_entries() {
        failed.push(err);
    }
    if !failed.is_empty() {
        return Some(("warn", format!("Muse Code data not fully moved, retrying next launch: {}", failed.join("; "))));
    }
    if let Err(err) = std::fs::create_dir_all(data).and_then(|_| std::fs::write(data.join(DONE), b"")) {
        return Some(("warn", format!("could not record the Muse Code data move: {err}")));
    }
    found.then(|| ("info", format!("moved Muse Code data from {IDENTIFIER}")))
}

/// Drop the old worktree folders once their worktrees are gone, then the old
/// app data folder if nothing else is left in it. Only empty folders go.
pub fn prune_worktree_store(store: &Path) {
    if let Ok(homes) = std::fs::read_dir(store) {
        for home in homes.flatten() {
            let _ = std::fs::remove_dir(home.path());
        }
    }
    if std::fs::remove_dir(store).is_ok() {
        if let Some(data) = store.parent() {
            let _ = std::fs::remove_dir(data);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("glitter-legacy-{tag}-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn read(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap()
    }

    #[test]
    fn moves_settings_threads_snapshots_and_logs_but_not_worktrees() {
        let root = scratch("move");
        let (data, logs) = (root.join("Application Support/com.glitter.desktop"), root.join("Logs/com.glitter.desktop"));
        let (old_data, old_logs) = (sibling(&data), sibling(&logs));
        write(&old_data.join("muse-desktop.json"), "settings");
        write(&old_data.join("muse-desktop.json.bak"), "backup");
        write(&old_data.join("muse-desktop.json.tmp.12.3"), "pending");
        write(&old_data.join("harness/s1.jsonl"), "harness thread");
        write(&old_data.join("turn-snapshots/records/a.json"), "snapshot");
        write(&old_data.join("worktrees/abcd/one/a.txt"), "checkout");
        write(&old_data.join("notes.txt"), "unknown");
        write(&old_logs.join("muse-desktop.log"), "log");
        write(&old_logs.join("muse-desktop.previous.log"), "older log");
        write(&old_logs.join("security-audit.log"), "audit");

        assert!(move_files(&data, &logs).is_empty());

        assert_eq!(read(&data.join("glitter.json")), "settings");
        assert_eq!(read(&data.join("glitter.json.bak")), "backup");
        assert_eq!(read(&data.join("glitter.json.tmp.12.3")), "pending");
        assert_eq!(read(&data.join("harness/s1.jsonl")), "harness thread");
        assert_eq!(read(&data.join("turn-snapshots/records/a.json")), "snapshot");
        assert_eq!(read(&logs.join("glitter.log")), "log");
        assert_eq!(read(&logs.join("glitter.previous.log")), "older log");
        assert_eq!(read(&logs.join("security-audit.log")), "audit");
        assert!(!old_data.join("muse-desktop.json").exists());
        assert_eq!(read(&old_data.join("worktrees/abcd/one/a.txt")), "checkout", "worktrees stay where git and the agents recorded them");
        assert_eq!(read(&old_data.join("notes.txt")), "unknown", "files this app did not write are left alone");
        assert!(!data.join("worktrees").exists());
        assert!(!old_logs.exists(), "an emptied old folder is removed");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn never_overwrites_what_this_app_already_saved() {
        let root = scratch("keep");
        let (data, logs) = (root.join("data/com.glitter.desktop"), root.join("logs/com.glitter.desktop"));
        write(&sibling(&data).join("muse-desktop.json"), "old settings");
        write(&data.join("glitter.json"), "new settings");

        assert!(move_files(&data, &logs).is_empty(), "a missing log folder is not an error");

        assert_eq!(read(&data.join("glitter.json")), "new settings");
        assert_eq!(read(&sibling(&data).join("muse-desktop.json")), "old settings", "the old copy is kept rather than lost");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pruning_removes_only_empty_folders() {
        let root = scratch("prune");
        let store = root.join(IDENTIFIER).join("worktrees");
        std::fs::create_dir_all(store.join("empty")).unwrap();
        write(&store.join("live/two/a.txt"), "still in use");
        prune_worktree_store(&store);
        assert!(!store.join("empty").exists());
        assert!(store.join("live/two/a.txt").exists(), "a remaining worktree keeps its folders");

        std::fs::remove_dir_all(store.join("live")).unwrap();
        prune_worktree_store(&store);
        assert!(!root.join(IDENTIFIER).exists(), "the old data folder goes with its last worktree");
        std::fs::remove_dir_all(root).unwrap();
    }
}
