//! Native workspace trust and configuration-bound MCP startup permission.
//! Neither the repository nor the renderer settings store can widen these grants.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{grant_root, AppState};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Permission {
    #[serde(default)]
    trusted: bool,
    configuration: Option<String>,
}

#[derive(Default)]
pub struct WorkspaceSecurity {
    records: Mutex<HashMap<String, Permission>>,
    path: Mutex<PathBuf>,
}

impl WorkspaceSecurity {
    pub fn load(path: &Path) -> Self {
        let records = fs::read_to_string(path).ok()
            .and_then(|raw| serde_json::from_str::<HashMap<String, Permission>>(&raw).ok())
            .unwrap_or_default().into_iter().filter_map(|(root, permission)| {
                let root = PathBuf::from(root).canonicalize().ok()?;
                let valid = permission.configuration.as_ref().is_none_or(|digest| digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit()));
                valid.then_some((root.to_string_lossy().into_owned(), permission))
            }).collect();
        Self { records: Mutex::new(records), path: Mutex::new(path.to_path_buf()) }
    }

    pub fn load_from(&self, path: &Path) {
        let loaded = Self::load(path);
        if let Ok(mut records) = self.records.lock() {
            *records = loaded.records.into_inner().unwrap_or_default();
        }
        if let Ok(mut saved) = self.path.lock() {
            *saved = path.to_path_buf();
        }
    }

    fn save(records: &HashMap<String, Permission>, path: &Path) -> Result<(), String> {
        let parent = path.parent().ok_or("Could not locate the app data folder.")?;
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        let temporary = path.with_extension("json.tmp");
        let bytes = serde_json::to_vec(records).map_err(|err| err.to_string())?;
        fs::write(&temporary, bytes).map_err(|err| err.to_string())?;
        fs::rename(&temporary, path).map_err(|err| err.to_string())
    }

    fn set(&self, root: &Path, permission: Permission) -> Result<(), String> {
        let root = root.canonicalize().map_err(|err| err.to_string())?.to_string_lossy().into_owned();
        let mut records = self.records.lock().map_err(|err| err.to_string())?;
        let mut next = records.clone();
        if permission.trusted || permission.configuration.is_some() {
            next.insert(root, permission);
        } else {
            next.remove(&root);
        }
        let path = self.path.lock().map_err(|err| err.to_string())?.clone();
        if path.as_os_str().is_empty() {
            return Err("MCP permission storage is not ready. Reopen the app and try again.".into());
        }
        Self::save(&next, &path)?;
        *records = next;
        Ok(())
    }
}

fn digest(parts: &[&[u8]]) -> String {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update((*part).len().to_be_bytes());
        hash.update(part);
    }
    hex::encode(hash.finalize())
}

fn read_config(root: &Path) -> Result<Vec<u8>, String> {
    let folder = root.join(".glitter");
    let path = folder.join("mcp.json");
    for candidate in [&folder, &path] {
        match fs::symlink_metadata(candidate) {
            Ok(metadata) if metadata.file_type().is_symlink() => return Err(format!("{} must not be a symbolic link.", candidate.display())),
            Ok(_) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(err) => return Err(format!("Could not review {}: {err}", candidate.display())),
        }
    }
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(err) => return Err(format!("Could not review {}: {err}", path.display())),
    };
    if bytes.len() > 64 * 1024 {
        return Err(format!("{} is too large.", path.display()));
    }
    Ok(bytes)
}

fn config(root: &Path) -> Result<(PathBuf, Vec<u8>), String> {
    let canonical = root.canonicalize().map_err(|err| err.to_string())?;
    Ok((canonical.clone(), read_config(&canonical)?))
}

fn fingerprint(root: &Path, workspace: &[u8], home: &[u8]) -> String {
    digest(&[root.to_string_lossy().as_bytes(), workspace, home])
}

fn home_digest(home: &[u8]) -> Option<String> {
    (!home.is_empty()).then(|| digest(&[home]))
}

fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
}

/// Resolve the granted workspace and the user's home without touching the repository.
fn config_roots(state: &AppState, grant_id: &str) -> Result<(PathBuf, PathBuf), String> {
    Ok((grant_root(state, grant_id)?, home_dir()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpReview {
    /// An MCP startup approval is on record, current or not. Trusting the
    /// workspace alone does not set it, so "changed" never describes a
    /// configuration that was never approved.
    trusted: bool,
    current: bool,
    has_workspace_config: bool,
    configuration_digest: String,
}

/// Read permission state only. MCP config summaries come through the Harness's
/// existing redacted DTO, so env/header values and arbitrary paths never cross
/// into the renderer through this command.
#[tauri::command]
pub fn review_mcp(state: tauri::State<'_, AppState>, grant_id: String) -> Result<McpReview, String> {
    let (root, home) = config_roots(&state, &grant_id)?;
    let (root, workspace) = config(&root)?;
    let home = read_config(&home)?;
    let fingerprint = fingerprint(&root, &workspace, &home);
    let permission = state.workspace_security.records.lock().map_err(|err| err.to_string())?.get(&root.to_string_lossy().into_owned()).cloned().unwrap_or_default();
    Ok(McpReview { trusted: permission.trusted && permission.configuration.is_some(), current: permission.configuration.as_deref() == Some(fingerprint.as_str()), has_workspace_config: !workspace.is_empty(), configuration_digest: fingerprint })
}

#[tauri::command]
pub fn consent_mcp(state: tauri::State<'_, AppState>, grant_id: String, approve: bool, expected_digest: Option<String>) -> Result<(), String> {
    let (root, home) = config_roots(&state, &grant_id)?;
    let (root, workspace) = config(&root)?;
    let home = read_config(&home)?;
    let fingerprint = fingerprint(&root, &workspace, &home);
    if approve && expected_digest.as_deref() != Some(fingerprint.as_str()) {
        return Err("The MCP configuration changed. Review it again before approving.".into());
    }
    // Approving servers to start trusts the workspace. Withdrawing that approval
    // does not untrust it: the user's rules and skills are a separate decision.
    let was_trusted = state.workspace_security.records.lock().map_err(|err| err.to_string())?.get(&root.to_string_lossy().into_owned()).is_some_and(|permission| permission.trusted);
    let permission = Permission { trusted: approve || was_trusted, configuration: approve.then_some(fingerprint) };
    state.workspace_security.set(&root, permission)
}

#[tauri::command]
pub fn workspace_trust(state: tauri::State<'_, AppState>, grant_id: String) -> Result<bool, String> {
    let root = grant_root(&state, &grant_id)?;
    let trusted = state.workspace_security.records.lock().map_err(|err| err.to_string())?.get(&root.to_string_lossy().into_owned()).is_some_and(|permission| permission.trusted);
    Ok(trusted)
}

#[tauri::command]
pub fn workspace_trust_set(state: tauri::State<'_, AppState>, grant_id: String, trusted: bool) -> Result<(), String> {
    let root = grant_root(&state, &grant_id)?;
    let mut permission = state.workspace_security.records.lock().map_err(|err| err.to_string())?.get(&root.to_string_lossy().into_owned()).cloned().unwrap_or_default();
    permission.trusted = trusted;
    state.workspace_security.set(&root, permission)
}

/// Recompute the complete authorization on every request. An explicit false
/// replaces any prior bridge-side consent when config changes or trust is revoked.
///
/// `origin` is the granted workspace a worktree grant was made from. A worktree
/// is a checkout of that workspace, so it is trusted exactly while the workspace
/// is; it never trusts the workspace in return, and its MCP approval is its own.
pub fn inject(state: &AppState, grant_id: &str, origin: Option<&Path>, params: &mut Value) -> Result<(), String> {
    let (root, home) = config_roots(state, grant_id)?;
    let (root, workspace) = config(&root)?;
    let home = read_config(&home)?;
    let approved = state.workspace_security.records.lock().map_err(|err| err.to_string())?.get(&root.to_string_lossy().into_owned()).cloned().and_then(|permission| permission.configuration);
    let fingerprint = fingerprint(&root, &workspace, &home);
    let approved = approved.filter(|digest| digest == &fingerprint);
    let records = state.workspace_security.records.lock().map_err(|err| err.to_string())?;
    let trusted_at = |at: &Path| records.get(&at.to_string_lossy().into_owned()).is_some_and(|permission| permission.trusted);
    let trusted = trusted_at(&root) || origin.and_then(|origin| origin.canonicalize().ok()).is_some_and(|origin| trusted_at(&origin));
    drop(records);
    let object = params.as_object_mut().ok_or("Bridge parameters must be an object")?;
    object.insert("harnessMcpTrust".into(), serde_json::json!({
        "workspaceTrusted": trusted,
        "configurationDigest": approved,
        "homeConfigurationDigest": home_digest(&home),
    }));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tauri::Manager;
    use uuid::Uuid;

    fn fixture() -> (AppState, PathBuf, String, PathBuf) {
        let root = std::env::temp_dir().join(format!("glitter-mcp-consent-{}", Uuid::new_v4().simple()));
        fs::create_dir_all(root.join(".glitter")).expect("workspace");
        fs::write(root.join(".glitter/mcp.json"), b"{\"mcpServers\":{}}").expect("config");
        let state = AppState::new();
        let data = root.join("app-data/security.json");
        state.workspace_security.load_from(&data);
        let grant = "wg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string();
        state.grants.lock().unwrap().insert(grant.clone(), root.canonicalize().unwrap());
        (state, root, grant, data)
    }

    #[test]
    fn consent_is_persistent_current_and_never_reads_secrets_into_a_review() {
        let (state, root, grant, data) = fixture();
        let app = tauri::test::mock_app();
        app.manage(state);
        let secret = "renderer-must-not-see-this";
        fs::write(root.join(".glitter/mcp.json"), format!("{{\"mcpServers\":{{\"docs\":{{\"env\":{{\"TOKEN\":\"{secret}\"}}}}}}}}")).unwrap();
        let reviewed = review_mcp(app.state::<AppState>(), grant.clone()).unwrap();
        let digest = reviewed.configuration_digest.clone();
        let review = serde_json::to_value(reviewed).unwrap();
        assert_eq!(review["current"], false);
        assert_eq!(review["hasWorkspaceConfig"], true);
        assert_eq!(review["configurationDigest"].as_str().unwrap().len(), 64);
        assert!(!review.to_string().contains(secret));
        consent_mcp(app.state::<AppState>(), grant.clone(), true, Some(digest.clone())).unwrap();
        let persisted = fs::read_to_string(&data).unwrap();
        assert!(!persisted.contains(secret));
        assert!(review_mcp(app.state::<AppState>(), grant.clone()).unwrap().current);
        fs::write(root.join(".glitter/mcp.json"), b"{\"mcpServers\":{\"other\":{}}}").unwrap();
        let error = consent_mcp(app.state::<AppState>(), grant.clone(), true, Some(digest)).unwrap_err();
        assert!(error.contains("configuration changed"));
        assert!(!review_mcp(app.state::<AppState>(), grant.clone()).unwrap().current);
        consent_mcp(app.state::<AppState>(), grant.clone(), false, None).unwrap();
        let revoked = review_mcp(app.state::<AppState>(), grant.clone()).unwrap();
        assert!(!revoked.trusted && !revoked.current);
        // F0.7: the workspace stays trusted, so its rules and skills keep loading.
        let mut params = json!({});
        inject(app.state::<AppState>().inner(), &grant, None, &mut params).unwrap();
        assert_eq!(params["harnessMcpTrust"]["workspaceTrusted"], true, "withdrawing MCP startup does not untrust the workspace");
        assert_eq!(params["harnessMcpTrust"]["configurationDigest"], Value::Null);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn trusting_a_workspace_is_not_an_mcp_approval() {
        let (state, root, grant, _) = fixture();
        let app = tauri::test::mock_app();
        app.manage(state);
        workspace_trust_set(app.state::<AppState>(), grant.clone(), true).unwrap();
        assert!(workspace_trust(app.state::<AppState>(), grant.clone()).unwrap());
        let review = review_mcp(app.state::<AppState>(), grant.clone()).unwrap();
        assert!(!review.trusted && !review.current, "no servers are approved to start by trusting the folder");
        let mut params = json!({});
        inject(app.state::<AppState>().inner(), &grant, None, &mut params).unwrap();
        assert_eq!(params["harnessMcpTrust"]["workspaceTrusted"], true);
        assert_eq!(params["harnessMcpTrust"]["configurationDigest"], Value::Null, "MCP stays off until its configuration is approved");
        workspace_trust_set(app.state::<AppState>(), grant.clone(), false).unwrap();
        inject(app.state::<AppState>().inner(), &grant, None, &mut params).unwrap();
        assert_eq!(params["harnessMcpTrust"]["workspaceTrusted"], false);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn a_worktree_is_trusted_while_the_workspace_it_came_from_is() {
        let (state, root, workspace_grant, _) = fixture();
        let checkout = root.join("checkout");
        fs::create_dir_all(&checkout).unwrap();
        let worktree_grant = "wg-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_string();
        state.grants.lock().unwrap().insert(worktree_grant.clone(), checkout.canonicalize().unwrap());
        let app = tauri::test::mock_app();
        app.manage(state);
        let origin = root.canonicalize().unwrap();
        let mut params = json!({});
        inject(app.state::<AppState>().inner(), &worktree_grant, Some(&origin), &mut params).unwrap();
        assert_eq!(params["harnessMcpTrust"]["workspaceTrusted"], false, "an untrusted workspace's worktree is untrusted");
        workspace_trust_set(app.state::<AppState>(), workspace_grant.clone(), true).unwrap();
        inject(app.state::<AppState>().inner(), &worktree_grant, Some(&origin), &mut params).unwrap();
        assert_eq!(params["harnessMcpTrust"]["workspaceTrusted"], true, "the worktree follows its workspace");
        inject(app.state::<AppState>().inner(), &worktree_grant, None, &mut params).unwrap();
        assert_eq!(params["harnessMcpTrust"]["workspaceTrusted"], false, "a grant with no known origin gets no inherited trust");
        workspace_trust_set(app.state::<AppState>(), worktree_grant.clone(), true).unwrap();
        workspace_trust_set(app.state::<AppState>(), workspace_grant.clone(), false).unwrap();
        inject(app.state::<AppState>().inner(), &worktree_grant, Some(&origin), &mut params).unwrap();
        assert_eq!(params["harnessMcpTrust"]["workspaceTrusted"], true, "a worktree trusted on its own stays trusted");
        assert!(!workspace_trust(app.state::<AppState>(), workspace_grant).unwrap(), "trust never flows back up to the workspace");
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn injection_replaces_spoofed_and_stale_consent() {
        let (state, root, grant, _) = fixture();
        let app = tauri::test::mock_app();
        app.manage(state);
        let mut params = json!({"harnessMcpTrust": {"workspaceTrusted": true, "configurationDigest": "f".repeat(64)}});
        inject(app.state::<AppState>().inner(), &grant, None, &mut params).unwrap();
        crate::dto::strip_native_fields("sendTurn", &mut params);
        assert_eq!(params["harnessMcpTrust"]["workspaceTrusted"], false);
        assert_eq!(params["harnessMcpTrust"]["configurationDigest"], Value::Null);
        let reviewed = review_mcp(app.state::<AppState>(), grant.clone()).unwrap();
        consent_mcp(app.state::<AppState>(), grant.clone(), true, Some(reviewed.configuration_digest)).unwrap();
        inject(app.state::<AppState>().inner(), &grant, None, &mut params).unwrap();
        crate::dto::strip_native_fields("sendTurn", &mut params);
        assert_eq!(params["harnessMcpTrust"]["workspaceTrusted"], true);
        assert_eq!(params["harnessMcpTrust"]["configurationDigest"].as_str().unwrap().len(), 64);
        fs::write(root.join(".glitter/mcp.json"), b"{}").unwrap();
        inject(app.state::<AppState>().inner(), &grant, None, &mut params).unwrap();
        crate::dto::strip_native_fields("sendTurn", &mut params);
        assert_eq!(params["harnessMcpTrust"]["configurationDigest"], Value::Null);
        assert_eq!(params["harnessMcpTrust"]["workspaceTrusted"], true, "trust remains; only MCP authorization is withdrawn");
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn consent_review_does_not_mutate_a_git_repository() {
        let (state, root, grant, _) = fixture();
        crate::run_git(&root, &["init", "--quiet"]).unwrap();
        let before = crate::run_git(&root, &["status", "--porcelain"]).unwrap();
        let mut params = json!({});
        inject(&state, &grant, None, &mut params).unwrap();
        let after = crate::run_git(&root, &["status", "--porcelain"]).unwrap();
        assert_eq!(after, before);
        assert!(!root.join(".glitter-mcp-review").exists());
        fs::remove_dir_all(root).ok();
    }
}
