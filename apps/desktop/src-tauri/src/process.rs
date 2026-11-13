//! Process-tree supervision and a minimal child environment (SEC-03/04/05).

use std::collections::HashSet;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::{Duration, Instant};

const BASE_ENV: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LANGUAGE",
    "TERM",
    "COLORTERM",
    "TZ",
    "SHELL",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_RUNTIME_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "SSH_AUTH_SOCK",
    "SSH_AGENT_PID",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
    "EDITOR",
    "VISUAL",
    "HOMEBREW_PREFIX",
    "HOMEBREW_CELLAR",
    "NODE_NO_WARNINGS",
];

/// The Harness takes provider keys from the keychain with each request, so no
/// credential is inherited from the environment.
fn keep_env_key(key: &str) -> bool {
    key != "NODE_OPTIONS" && BASE_ENV.contains(&key)
}

/// Clear inherited secrets, then keep PATH/HOME and the other base keys.
pub fn apply_minimal_env(cmd: &mut Command) {
    cmd.env_clear();
    let mut kept = HashSet::new();
    for (key, value) in std::env::vars() {
        if keep_env_key(&key) && kept.insert(key.clone()) {
            cmd.env(key, value);
        }
    }
    cmd.env("NODE_NO_WARNINGS", "1");
}

pub fn isolate_command(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    apply_minimal_env(cmd);
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.process_group(0);
}

/// End a whole process tree by pid. The child must be a process-group leader
/// (spawned with `process_group(0)`), as the bridge and `run_cli` children are.
pub fn kill_tree(pid: u32) {
    signal_group(pid, "-TERM");
}

/// Stop immediately, including descendants that ignored the earlier TERM.
pub fn kill_tree_now(pid: u32) {
    signal_group(pid, "-KILL");
}

/// Give the group a bounded chance to exit, then escalate even if its leader is gone.
pub fn kill_tree_with_grace(pid: u32, grace: Duration) {
    kill_tree(pid);
    std::thread::sleep(grace);
    kill_tree_now(pid);
}

fn signal_group(pid: u32, signal: &str) {
    let _ = Command::new("kill").args([signal, &format!("-{pid}")]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
}

/// Close stdin (EOF), wait, then end the process tree.
pub fn shutdown_tree(mut child: Child, stdin: ChildStdin, grace: Duration) {
    drop(stdin);
    let pid = child.id();
    let started = Instant::now();
    while started.elapsed() < grace {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => break,
        }
    }
    kill_tree(pid);
    let escalate = Instant::now();
    while escalate.elapsed() < Duration::from_millis(800) {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => break,
        }
    }
    signal_group(pid, "-KILL");
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_filter_drops_secrets() {
        for key in ["AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "NODE_OPTIONS", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY", "META_API_KEY"] {
            assert!(!keep_env_key(key), "kept {key}");
        }
        assert!(keep_env_key("PATH"));
        assert!(keep_env_key("HOME"));
    }
}
