//! Per-thread git worktrees. Each one is a linked worktree of a granted
//! repository, checked out on its own `muse/` branch under the app data
//! directory. The commands in `lib.rs` own grants and locking; this module only
//! runs git and keeps every path inside the store it is handed.

use std::path::{Path, PathBuf};

use sha2::Digest;

use super::{run_git, run_git_read};

/// Branches this app creates. Only these are ever deleted on removal.
const BRANCH_PREFIX: &str = "muse/";

#[derive(Debug)]
pub struct Created {
    pub path: PathBuf,
    pub branch: String,
    /// What the worktree started from, for display: the base the caller named,
    /// or the branch (or short commit) that was checked out.
    pub base: String,
}

#[derive(Debug)]
pub struct Removed {
    pub branch: Option<String>,
    /// The branch still exists because it holds commits no other ref has.
    pub branch_kept: bool,
}

/// Directory name for one repository's worktrees. A digest of the canonical
/// root, so the store never spells out a workspace path or a grant id and a
/// repository's worktrees can be found again from its root alone.
pub fn repo_key(root: &Path) -> String {
    let digest = sha2::Sha256::digest(root.to_string_lossy().as_bytes());
    digest.iter().take(8).map(|byte| format!("{byte:02x}")).collect()
}

/// Every worktree directory of `root` lives directly under this folder.
pub fn repo_store(store: &Path, root: &Path) -> PathBuf {
    store.join(repo_key(root))
}

pub fn create(repo: &Path, store: &Path, base: Option<&str>) -> Result<Created, String> {
    if run_git_read(repo, &["rev-parse", "--is-inside-work-tree"]).map(|out| out.trim() == "true") != Ok(true) {
        return Err("Worktree threads need a Git repository. Initialize one in Changes first.".into());
    }
    // A worktree checks out the whole repository. A grant on a subfolder must
    // not turn into access to its siblings.
    if !run_git_read(repo, &["rev-parse", "--show-prefix"])?.trim().is_empty() {
        return Err("Worktree threads need the workspace folder to be the repository root.".into());
    }
    let head = run_git_read(repo, &["rev-parse", "--verify", "HEAD^{commit}"]).map_err(|_| "Commit at least once before starting a worktree thread.")?.trim().to_string();
    let named = base.map(str::trim).filter(|base| !base.is_empty());
    let (start, label) = match named {
        Some(base) => {
            if base.len() > 256 || base.starts_with('-') || base.contains(['\0', '\r', '\n']) {
                return Err("Choose a valid base branch or commit (at most 256 characters).".into());
            }
            let commit = format!("{base}^{{commit}}");
            let oid = run_git_read(repo, &["rev-parse", "--verify", "--end-of-options", &commit]).map_err(|_| "The base branch or commit was not found. Check its name and try again.")?.trim().to_string();
            (oid, base.to_string())
        }
        None => {
            let branch = run_git_read(repo, &["symbolic-ref", "--short", "-q", "HEAD"]).map(|out| out.trim().to_string()).unwrap_or_default();
            let label = if branch.is_empty() {
                head.chars().take(8).collect()
            } else {
                branch
            };
            (head, label)
        }
    };
    let name: String = uuid::Uuid::new_v4().simple().to_string().chars().take(8).collect();
    let branch = format!("{BRANCH_PREFIX}{name}");
    let parent = repo_store(store, repo);
    std::fs::create_dir_all(&parent).map_err(|err| format!("Could not create the worktree folder: {err}"))?;
    let dir = parent.join(&name);
    let target = dir.to_string_lossy().into_owned();
    run_git(repo, &["worktree", "add", "--quiet", "-b", &branch, "--", &target, &start]).map_err(|err| format!("Could not create the worktree: {err}"))?;
    let path = dir.canonicalize().map_err(|err| format!("The new worktree cannot be opened: {err}"))?;
    Ok(Created {
        path,
        branch,
        base: label,
    })
}

/// Largest patch a handoff will carry. Past this the user is better served by merging the branch.
const HANDOFF_LIMIT: usize = 20 * 1024 * 1024;

/// Everything the worktree changed since it left the repository's history:
/// its commits plus its staged, unstaged and new files, as one patch. Built
/// through a throwaway index, so the worktree's own index and files are not
/// touched. `None` when there is nothing to hand off.
pub fn changes(repo: &Path, dir: &Path) -> Result<Option<Vec<u8>>, String> {
    let theirs = run_git_read(dir, &["rev-parse", "--verify", "HEAD^{commit}"])?.trim().to_string();
    let ours = run_git_read(repo, &["rev-parse", "--verify", "HEAD^{commit}"]).map_err(|_| "The workspace has no commit to compare against.")?.trim().to_string();
    let base = run_git_read(repo, &["merge-base", &ours, &theirs]).map_err(|_| "The worktree and the workspace share no history.")?.trim().to_string();
    let index = std::env::temp_dir().join(format!("muse-handoff-{}.index", uuid::Uuid::new_v4().simple()));
    let with_index = |args: &[&str]| -> Result<Vec<u8>, String> {
        let mut cmd = super::command("git");
        super::strip_ambient_git_env(&mut cmd);
        cmd.current_dir(dir).env("GIT_INDEX_FILE", &index).args(args);
        let output = cmd.output().map_err(|err| format!("git failed: {err}"))?;
        if !output.status.success() {
            return Err(format!("git {} failed: {}", args[0], String::from_utf8_lossy(&output.stderr).trim()));
        }
        Ok(output.stdout)
    };
    let result = (|| {
        with_index(&["read-tree", "HEAD"])?;
        with_index(&["add", "-A", "--", "."])?;
        let tree = String::from_utf8_lossy(&with_index(&["write-tree"])?).trim().to_string();
        // Raw bytes, not text: a file in another encoding must survive the trip.
        with_index(&["diff", "--binary", "--no-color", "--no-ext-diff", "--no-textconv", "--full-index", &base, &tree])
    })();
    let _ = std::fs::remove_file(&index);
    let patch = result?;
    if patch.iter().all(u8::is_ascii_whitespace) {
        return Ok(None);
    }
    if patch.len() > HANDOFF_LIMIT {
        return Err("These changes are too large to apply here. Merge the worktree's branch with git instead.".into());
    }
    Ok(Some(patch))
}

/// The branch `repo` has checked out in `dir`, read from the repository's own
/// worktree table rather than from files inside the worktree, which an agent
/// can rewrite.
fn registered_branch(repo: &Path, dir: &Path) -> Option<String> {
    let listing = run_git_read(repo, &["worktree", "list", "--porcelain"]).ok()?;
    let mut matched = false;
    for line in listing.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            let listed = PathBuf::from(path);
            matched = listed == dir || listed.canonicalize().map(|canon| canon == dir).unwrap_or(false);
        } else if matched {
            if let Some(branch) = line.strip_prefix("branch refs/heads/") {
                return Some(branch.to_string());
            }
        }
    }
    None
}

/// Delete an app-made branch only when another ref still reaches its tip, so
/// no commit is ever lost. Returns whether the branch is gone.
fn delete_merged_branch(repo: &Path, branch: &str) -> bool {
    if !branch.starts_with(BRANCH_PREFIX) {
        return false;
    }
    let own = format!("refs/heads/{branch}");
    let Ok(tip) = run_git_read(repo, &["rev-parse", "--verify", "--end-of-options", &own]) else {
        return true;
    };
    let Ok(holders) = run_git_read(repo, &["for-each-ref", "--contains", tip.trim(), "--format=%(refname)"]) else {
        return false;
    };
    if !holders.lines().any(|name| !name.trim().is_empty() && name.trim() != own) {
        return false;
    }
    run_git(repo, &["branch", "-D", "--", branch]).is_ok()
}

/// Remove the worktree at `dir`. Without `force`, a worktree holding modified
/// or untracked files is left alone and reported as an error. `repo` is the
/// owning repository when it is still granted; without it only the directory
/// can be removed and git prunes its own record later.
pub fn remove(repo: Option<&Path>, dir: &Path, force: bool) -> Result<Removed, String> {
    let branch = repo.and_then(|repo| registered_branch(repo, dir));
    if let Some(repo) = repo {
        if dir.exists() {
            let target = dir.to_string_lossy().into_owned();
            let mut args = vec!["worktree", "remove"];
            if force {
                args.push("--force");
            }
            args.extend(["--", target.as_str()]);
            if let Err(err) = run_git(repo, &args) {
                if !force {
                    return Err(err);
                }
            }
        }
    }
    if dir.exists() {
        if !force {
            return Err("The worktree still has files.".into());
        }
        std::fs::remove_dir_all(dir).map_err(|err| format!("Could not remove the worktree folder: {err}"))?;
    }
    let mut branch_kept = branch.is_some();
    if let Some(repo) = repo {
        let _ = run_git(repo, &["worktree", "prune"]);
        if let Some(branch) = &branch {
            branch_kept = !delete_merged_branch(repo, branch);
        }
    }
    Ok(Removed {
        branch,
        branch_kept,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{run_git, run_git_read};

    /// Scratch root holding a `repo` and a `store` side by side. Cargo runs
    /// tests concurrently, so every fixture needs its own directories.
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("muse-worktree-{tag}-{}-{}", std::process::id(), uuid::Uuid::new_v4().simple()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("repo")).expect("repo dir");
        std::fs::create_dir_all(dir.join("store")).expect("store dir");
        dir
    }

    /// A committed repository plus the worktree store beside it, both canonicalized like production grants.
    fn fixture_repo(tag: &str) -> (PathBuf, PathBuf, PathBuf) {
        let root = scratch(tag);
        let repo = root.join("repo");
        let store = root.join("store");
        run_git(&repo, &["init", "-q"]).expect("init");
        run_git(&repo, &["config", "user.email", "test@example.com"]).expect("config");
        run_git(&repo, &["config", "user.name", "Test"]).expect("config");
        run_git(&repo, &["config", "commit.gpgsign", "false"]).expect("config");
        std::fs::write(repo.join("a.txt"), "base\n").unwrap();
        commit_all(&repo, "base");
        let repo = repo.canonicalize().expect("canon repo");
        let store = store.canonicalize().expect("canon store");
        (root, repo, store)
    }

    fn commit_all(dir: &Path, message: &str) {
        run_git(dir, &["add", "-A"]).expect("add");
        run_git(dir, &["commit", "-qm", message]).expect("commit");
    }

    fn current_branch(repo: &Path) -> String {
        run_git_read(repo, &["symbolic-ref", "--short", "-q", "HEAD"]).expect("branch").trim().to_string()
    }

    fn branch_exists(repo: &Path, branch: &str) -> bool {
        let name = format!("refs/heads/{branch}");
        run_git_read(repo, &["rev-parse", "--verify", "--end-of-options", &name]).is_ok()
    }

    #[test]
    fn repo_key_is_a_stable_opaque_digest() {
        let key = repo_key(Path::new("/Users/test/my secret project"));
        assert_eq!(key.len(), 16, "eight digest bytes as hex");
        assert!(key.chars().all(|ch| ch.is_ascii_hexdigit()), "hex only, safe for a directory name");
        assert_eq!(key, repo_key(Path::new("/Users/test/my secret project")), "the same root must map back to its worktrees");
        assert_ne!(key, repo_key(Path::new("/Users/test/other")), "distinct roots must not share a folder");
        assert!(!key.contains("secret"), "the store layout must not spell out the workspace path");
    }

    #[test]
    fn repo_store_lives_directly_under_the_store() {
        let root = PathBuf::from("/repo");
        let store = PathBuf::from("/store");
        let home = repo_store(&store, &root);
        assert_eq!(home.parent(), Some(store.as_path()));
        assert!(home.starts_with(&store));
    }

    #[test]
    fn create_rejects_a_folder_that_is_not_a_repository() {
        let root = scratch("not-a-repo");
        let err = create(&root.join("repo"), &root.join("store"), None).unwrap_err();
        assert!(err.contains("Git repository"), "unexpected: {err}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn create_rejects_a_subfolder_of_a_repository() {
        let (root, repo, store) = fixture_repo("subfolder");
        // A worktree checks out the whole repository: a grant on a subfolder
        // must not turn into access to its siblings.
        let sub = repo.join("sub");
        std::fs::create_dir(&sub).unwrap();
        let err = create(&sub, &store, None).unwrap_err();
        assert!(err.contains("repository root"), "unexpected: {err}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn create_requires_at_least_one_commit() {
        let root = scratch("unborn");
        let repo = root.join("repo");
        run_git(&repo, &["init", "-q"]).expect("init");
        let err = create(&repo, &root.join("store"), None).unwrap_err();
        assert!(err.contains("Commit at least once"), "unexpected: {err}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn create_rejects_malicious_and_unknown_bases() {
        let (root, repo, store) = fixture_repo("bad-base");
        let too_long = "x".repeat(257);
        for base in ["-b", "--upload-pack=evil", "main\nrm -rf", "a\0b", too_long.as_str()] {
            let err = create(&repo, &store, Some(base)).unwrap_err();
            assert!(err.contains("valid base branch"), "base {base:?} gave: {err}");
        }
        let err = create(&repo, &store, Some("no-such-base")).unwrap_err();
        assert!(err.contains("not found"), "unexpected: {err}");
        // A blank base is not a base at all: it starts from HEAD like None.
        let created = create(&repo, &store, Some("   ")).expect("blank base starts from HEAD");
        assert_eq!(created.base, current_branch(&repo));
        remove(Some(&repo), &created.path, true).expect("cleanup");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn create_checks_out_a_linked_worktree_on_a_muse_branch() {
        let (root, repo, store) = fixture_repo("create");
        let head = run_git_read(&repo, &["rev-parse", "--verify", "HEAD^{commit}"]).expect("head").trim().to_string();

        let created = create(&repo, &store, None).expect("create");

        assert!(created.branch.starts_with("muse/"), "unexpected branch: {}", created.branch);
        assert!(created.path.starts_with(repo_store(&store, &repo)), "worktree escaped its repo folder: {}", created.path.display());
        assert!(created.path.join("a.txt").exists(), "the worktree must check out the repository");
        assert_eq!(created.base, current_branch(&repo));
        assert_eq!(registered_branch(&repo, &created.path).as_deref(), Some(created.branch.as_str()), "git must know the worktree");
        let worktree_head = run_git_read(&created.path, &["rev-parse", "--verify", "HEAD^{commit}"]).expect("worktree head").trim().to_string();
        assert_eq!(worktree_head, head);
        remove(Some(&repo), &created.path, true).expect("cleanup");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn create_from_a_named_base_starts_there() {
        let (root, repo, store) = fixture_repo("named-base");
        run_git(&repo, &["checkout", "-qb", "feature"]).expect("branch");
        std::fs::write(repo.join("b.txt"), "feature\n").unwrap();
        commit_all(&repo, "feature work");
        let feature = run_git_read(&repo, &["rev-parse", "--verify", "HEAD^{commit}"]).expect("head").trim().to_string();

        let created = create(&repo, &store, Some("feature")).expect("create from base");

        assert_eq!(created.base, "feature");
        let worktree_head = run_git_read(&created.path, &["rev-parse", "--verify", "HEAD^{commit}"]).expect("worktree head").trim().to_string();
        assert_eq!(worktree_head, feature);
        assert!(created.path.join("b.txt").exists());
        remove(Some(&repo), &created.path, true).expect("cleanup");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn changes_is_none_when_the_worktree_is_clean() {
        let (root, repo, store) = fixture_repo("clean-handoff");
        let created = create(&repo, &store, None).expect("create");
        assert_eq!(changes(&repo, &created.path).expect("changes"), None);
        remove(Some(&repo), &created.path, true).expect("cleanup");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn changes_collects_commits_and_uncommitted_files_without_touching_the_worktree() {
        let (root, repo, store) = fixture_repo("dirty-handoff");
        let created = create(&repo, &store, None).expect("create");
        std::fs::write(created.path.join("committed.txt"), "handoff-committed-marker\n").unwrap();
        commit_all(&created.path, "worktree commit");
        std::fs::write(created.path.join("a.txt"), "handoff-unstaged-marker\n").unwrap();
        std::fs::write(created.path.join("untracked.txt"), "handoff-untracked-marker\n").unwrap();
        let status_before = run_git(&created.path, &["status", "--porcelain"]).expect("status");

        let patch = changes(&repo, &created.path).expect("changes").expect("a patch");
        let text = String::from_utf8_lossy(&patch);

        for marker in ["handoff-committed-marker", "handoff-unstaged-marker", "handoff-untracked-marker"] {
            assert!(text.contains(marker), "patch is missing {marker}:\n{text}");
        }
        assert_eq!(run_git(&created.path, &["status", "--porcelain"]).expect("status"), status_before, "the handoff must go through a throwaway index");
        assert!(created.path.join("untracked.txt").exists(), "worktree files must be left alone");
        remove(Some(&repo), &created.path, true).expect("cleanup");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn remove_refuses_a_dirty_worktree_without_force() {
        let (root, repo, store) = fixture_repo("dirty-refusal");
        let created = create(&repo, &store, None).expect("create");
        std::fs::write(created.path.join("untracked.txt"), "keep me\n").unwrap();

        let err = remove(Some(&repo), &created.path, false).unwrap_err();

        assert!(!err.is_empty());
        assert!(created.path.exists(), "a refused removal must leave the directory alone");
        assert_eq!(registered_branch(&repo, &created.path).as_deref(), Some(created.branch.as_str()), "a refused removal must stay registered");
        remove(Some(&repo), &created.path, true).expect("cleanup");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn remove_force_deletes_the_directory_and_prunes_the_record() {
        let (root, repo, store) = fixture_repo("force-remove");
        let created = create(&repo, &store, None).expect("create");
        std::fs::write(created.path.join("untracked.txt"), "discard me\n").unwrap();

        let removed = remove(Some(&repo), &created.path, true).expect("force remove");

        assert_eq!(removed.branch.as_deref(), Some(created.branch.as_str()));
        assert!(!created.path.exists(), "the directory must be gone");
        assert_eq!(registered_branch(&repo, &created.path), None, "git must forget the worktree");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn remove_keeps_a_branch_holding_commits_nothing_else_has() {
        let (root, repo, store) = fixture_repo("keep-unique");
        let created = create(&repo, &store, None).expect("create");
        std::fs::write(created.path.join("unique.txt"), "only here\n").unwrap();
        commit_all(&created.path, "unique work");

        let removed = remove(Some(&repo), &created.path, true).expect("remove");

        assert_eq!(removed.branch.as_deref(), Some(created.branch.as_str()));
        assert!(removed.branch_kept, "a branch holding unique commits must survive");
        assert!(branch_exists(&repo, &created.branch), "the unique commit must still be reachable");
        run_git(&repo, &["branch", "-D", "--", &created.branch]).expect("drop test branch");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn remove_deletes_a_branch_everything_else_still_reaches() {
        let (root, repo, store) = fixture_repo("drop-merged");
        let created = create(&repo, &store, None).expect("create");
        std::fs::write(created.path.join("merged.txt"), "merged work\n").unwrap();
        commit_all(&created.path, "merged work");
        run_git(&repo, &["merge", "--no-ff", "--no-edit", "-q", &created.branch]).expect("merge");

        let removed = remove(Some(&repo), &created.path, true).expect("remove");

        assert!(!removed.branch_kept, "a fully merged branch must be cleaned up");
        assert!(!branch_exists(&repo, &created.branch));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn delete_merged_branch_never_touches_foreign_or_live_branches() {
        let (root, repo, _store) = fixture_repo("foreign-branch");
        let main = current_branch(&repo);
        assert!(!delete_merged_branch(&repo, &main), "the workspace branch must never be deleted");
        assert!(!delete_merged_branch(&repo, "feature/not-ours"), "a missing foreign branch reports not-deleted, not gone");
        assert!(delete_merged_branch(&repo, "muse/already-gone"), "a missing app branch is already gone");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn remove_without_a_repo_only_removes_the_directory() {
        let root = scratch("no-repo");
        let dir = root.join("orphan");
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("file.txt"), "orphan\n").unwrap();

        let removed = remove(None, &dir, true).expect("orphan remove");

        assert_eq!(removed.branch, None);
        assert!(!removed.branch_kept);
        assert!(!dir.exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
