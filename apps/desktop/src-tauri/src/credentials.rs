use std::sync::Mutex;

// Serialize access: some platform credential stores do not support concurrent writes.
static CREDENTIAL_LOCK: Mutex<()> = Mutex::new(());

/// The keychain service every entry lives under: the bundle identifier.
pub const SERVICE: &str = "com.glitter.desktop";

#[cfg(target_os = "macos")]
fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, "muse-api-key").map_err(|_| "Could not access the system credential store".into())
}

/// Workspace grants live in the OS keyring — NOT in a file under AppData,
/// where the store plugin (renderer-reachable, unscopable) could rewrite them.
/// The renderer has no command that writes this entry; it only ever holds ids.
#[cfg(target_os = "macos")]
fn grants_entry() -> Result<keyring::Entry, String> {
    // Test seam (debug builds only): the e2e suite reroutes grants to a
    // throwaway account so the user's real entry is never touched.
    #[cfg(debug_assertions)]
    let account = std::env::var("GLITTER_TEST_GRANTS_ACCOUNT").unwrap_or_else(|_| "workspace-grants".into());
    #[cfg(not(debug_assertions))]
    let account = "workspace-grants";
    keyring::Entry::new(SERVICE, &account).map_err(|_| "Could not access the system credential store".into())
}

/// ACP agent identity pins (path + digest per agent). The renderer can read
/// them for display and confirm a drifted binary, but only the native side
/// resolves and records paths — a confirm accepts the actual binary on disk,
/// never a renderer-nominated string.
#[cfg(target_os = "macos")]
fn agent_pins_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, "agent-pins").map_err(|_| "Could not access the system credential store".into())
}

pub fn agent_pins_value() -> Result<Option<String>, String> {
    let _guard = CREDENTIAL_LOCK.lock().map_err(|_| "Credential store lock failed")?;
    #[cfg(target_os = "macos")]
    match agent_pins_entry()?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Could not read agent pins from the system credential store.".into()),
    }
    #[cfg(not(target_os = "macos"))]
    Err("Secure credential storage is unavailable on this platform".into())
}

#[cfg(target_os = "macos")]
fn acp_consent_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, "acp-isolation-consent").map_err(|_| "Could not access the system credential store".into())
}

/// Last consent value read from or written to the credential store. Only this
/// process writes the entry, and every write goes through `acp_consent_store`
/// (which updates the cache), so the cache cannot drift. The gate runs on every
/// bridge request that names a third-party agent; without the cache each one
/// paid a keyring round trip on the UI thread.
static ACP_CONSENT: Mutex<Option<bool>> = Mutex::new(None);

pub fn acp_consent_value() -> Result<bool, String> {
    if let Some(known) = ACP_CONSENT.lock().ok().and_then(|cached| *cached) {
        return Ok(known);
    }
    let _guard = CREDENTIAL_LOCK.lock().map_err(|_| "Credential store lock failed")?;
    #[cfg(target_os = "macos")]
    let read = match acp_consent_entry()?.get_password() {
        Ok(value) => Ok(value == "1" || value.eq_ignore_ascii_case("true")),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(_) => Err("Could not read ACP isolation consent from the system credential store.".to_string()),
    };
    #[cfg(not(target_os = "macos"))]
    let read: Result<bool, String> = Ok(false);
    if let Ok(value) = &read {
        if let Ok(mut cached) = ACP_CONSENT.lock() {
            *cached = Some(*value);
        }
    }
    read
}

pub fn acp_consent_store(consented: bool) -> Result<(), String> {
    let _guard = CREDENTIAL_LOCK.lock().map_err(|_| "Credential store lock failed")?;
    #[cfg(target_os = "macos")]
    let written: Result<(), String> = {
        let entry = acp_consent_entry()?;
        if consented {
            entry.set_password("1").map_err(|_| "Could not save ACP isolation consent.".into())
        } else {
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(_) => Err("Could not clear ACP isolation consent.".into()),
            }
        }
    };
    #[cfg(not(target_os = "macos"))]
    let written: Result<(), String> = {
        let _ = consented;
        Err("Secure credential storage is unavailable on this platform".into())
    };
    if written.is_ok() {
        if let Ok(mut cached) = ACP_CONSENT.lock() {
            *cached = Some(consented);
        }
    }
    written
}

#[tauri::command]
pub async fn acp_isolation_consent_get() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(acp_consent_value).await.map_err(|_| "Credential store task failed".to_string())?
}

#[tauri::command]
pub async fn acp_isolation_consent_set(consented: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || acp_consent_store(consented)).await.map_err(|_| "Credential store task failed".to_string())?
}

pub fn agent_pins_store(raw: &str) -> Result<(), String> {
    let _guard = CREDENTIAL_LOCK.lock().map_err(|_| "Credential store lock failed")?;
    #[cfg(target_os = "macos")]
    {
        agent_pins_entry()?.set_password(raw).map_err(|_| "Could not save agent pins in the system credential store.".into())
    }
    #[cfg(not(target_os = "macos"))]
    Err("Secure credential storage is unavailable on this platform".into())
}

pub fn grants_value() -> Result<Option<String>, String> {
    let _guard = CREDENTIAL_LOCK.lock().map_err(|_| "Credential store lock failed")?;
    #[cfg(target_os = "macos")]
    match grants_entry()?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Could not read workspace grants from the system credential store.".into()),
    }
    #[cfg(not(target_os = "macos"))]
    Err("Secure credential storage is unavailable on this platform".into())
}

pub fn grants_store(raw: &str) -> Result<(), String> {
    let _guard = CREDENTIAL_LOCK.lock().map_err(|_| "Credential store lock failed")?;
    #[cfg(target_os = "macos")]
    {
        grants_entry()?.set_password(raw).map_err(|_| "Could not save workspace grants in the system credential store.".into())
    }
    #[cfg(not(target_os = "macos"))]
    Err("Secure credential storage is unavailable on this platform".into())
}

pub fn credential_value() -> Result<Option<String>, String> {
    let _guard = CREDENTIAL_LOCK.lock().map_err(|_| "Credential store lock failed")?;
    #[cfg(target_os = "macos")]
    match entry()?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Could not read the API key from the system credential store. Unlock it and try again.".into()),
    }
    #[cfg(not(target_os = "macos"))]
    Err("Secure credential storage is unavailable on this platform".into())
}

#[tauri::command]
pub async fn credential_get() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        // The renderer only learns that a key exists. The native bridge injects
        // the actual value into trusted Muse lifecycle requests.
        credential_value().map(|value| value.map(|_| "••••••••".to_string()))
    })
    .await
    .map_err(|_| "Credential store task failed".to_string())?
}

/// Real API keys are far smaller than this. A renderer-supplied blob of
/// several MiB would sit in a keyring write while every key-dependent verb
/// (`detect`/`status`/`startHost`/`suggest`) waits on `CREDENTIAL_LOCK`.
const CREDENTIAL_VALUE_LIMIT: usize = 8 * 1024;

fn check_credential_value(value: &str) -> Result<(), String> {
    if value.len() > CREDENTIAL_VALUE_LIMIT {
        return Err("That credential is too long to save (over 8 KiB).".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn credential_set(value: String) -> Result<(), String> {
    check_credential_value(&value)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = CREDENTIAL_LOCK.lock().map_err(|_| "Credential store lock failed")?;
        #[cfg(target_os = "macos")]
        {
            let entry = entry()?;
            if value.is_empty() {
                match entry.delete_credential() {
                    Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                    Err(_) => Err("Could not remove the API key from the system credential store".into()),
                }
            } else {
                entry.set_password(&value).map_err(|_| "Could not save the API key in the system credential store. Unlock it and try again.".into())
            }
        }
        #[cfg(not(target_os = "macos"))]
        Err("Secure credential storage is unavailable on this platform".into())
    })
    .await
    .map_err(|_| "Credential store task failed".to_string())?
}

/// Model providers the built-in harness may hold a key for. The bridge's
/// `harness/providers.ts` is the catalog; this list only bounds what the
/// renderer may store, so a forged id can never mint a new entry.
pub const PROVIDER_IDS: &[&str] = &["anthropic", "openai", "google", "openrouter", "cline", "kilo", "xai", "deepseek", "groq", "mistral", "nvidia", "ollama", "lmstudio", "custom"];
/// Providers whose address the user sets: a custom endpoint, and local servers
/// that may listen on another port.
const PROVIDER_URL_IDS: &[&str] = &["custom", "ollama", "lmstudio"];
const PROVIDER_KEY_LIMIT: usize = 4_096;
const PROVIDER_URL_LIMIT: usize = 2_048;

/// One provider's saved credential. The URL is stored with the key, so a key
/// is only ever sent to the address it was saved for.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCredential {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

/// What the renderer may see of a provider: whether it is set up, the last
/// four characters of its key, and its (non-secret) address.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub id: String,
    pub configured: bool,
    pub key_hint: Option<String>,
    pub base_url: Option<String>,
}

#[cfg(target_os = "macos")]
fn provider_keys_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, "provider-keys").map_err(|_| "Could not access the system credential store".into())
}

/// The keychain entry is read once and cached: every harness request injects
/// the keys, and a keyring round trip each time would cost the UI.
static PROVIDER_KEYS: Mutex<Option<std::collections::BTreeMap<String, ProviderCredential>>> = Mutex::new(None);

pub fn provider_keys_value() -> Result<std::collections::BTreeMap<String, ProviderCredential>, String> {
    if let Some(known) = PROVIDER_KEYS.lock().ok().and_then(|cached| cached.clone()) {
        return Ok(known);
    }
    let _guard = CREDENTIAL_LOCK.lock().map_err(|_| "Credential store lock failed")?;
    #[cfg(target_os = "macos")]
    let read = match provider_keys_entry()?.get_password() {
        Ok(raw) => Ok(serde_json::from_str::<std::collections::BTreeMap<String, ProviderCredential>>(&raw).unwrap_or_default()),
        Err(keyring::Error::NoEntry) => Ok(Default::default()),
        Err(_) => Err("Could not read provider keys from the system credential store. Unlock it and try again.".to_string()),
    };
    #[cfg(not(target_os = "macos"))]
    let read: Result<std::collections::BTreeMap<String, ProviderCredential>, String> = Err("Secure credential storage is unavailable on this platform".into());
    let mut keys = read?;
    keys.retain(|id, _| PROVIDER_IDS.contains(&id.as_str()));
    if let Ok(mut cached) = PROVIDER_KEYS.lock() {
        *cached = Some(keys.clone());
    }
    Ok(keys)
}

fn provider_keys_store(keys: &std::collections::BTreeMap<String, ProviderCredential>) -> Result<(), String> {
    let _guard = CREDENTIAL_LOCK.lock().map_err(|_| "Credential store lock failed")?;
    #[cfg(target_os = "macos")]
    {
        let entry = provider_keys_entry()?;
        if keys.is_empty() {
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => {}
                Err(_) => return Err("Could not clear provider keys.".into()),
            }
        } else {
            let raw = serde_json::to_string(keys).map_err(|err| err.to_string())?;
            entry.set_password(&raw).map_err(|_| "Could not save the key in the system credential store.".to_string())?;
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = keys;
        return Err("Secure credential storage is unavailable on this platform".into());
    }
    if let Ok(mut cached) = PROVIDER_KEYS.lock() {
        *cached = Some(keys.clone());
    }
    Ok(())
}

/// An address a key may be sent to: https anywhere, or plain http only to this
/// machine (local model servers).
fn check_provider_url(raw: &str) -> Result<String, String> {
    let url = raw.trim().trim_end_matches('/').to_string();
    if url.len() > PROVIDER_URL_LIMIT || url.chars().any(char::is_control) {
        return Err("That address is not valid.".into());
    }
    let rest = if let Some(rest) = url.strip_prefix("https://") {
        rest
    } else if let Some(rest) = url.strip_prefix("http://") {
        let host = rest.split(['/', ':']).next().unwrap_or("");
        let bracketed = rest.starts_with("[::1]");
        if !(host == "localhost" || host == "127.0.0.1" || bracketed) {
            return Err("Use https, or http only for a server on this Mac (localhost).".into());
        }
        rest
    } else {
        return Err("The address must start with https:// (or http://localhost).".into());
    };
    let host = rest.split('/').next().unwrap_or("");
    if host.is_empty() || host.contains('@') {
        return Err("That address is not valid.".into());
    }
    Ok(url)
}

fn provider_status(keys: &std::collections::BTreeMap<String, ProviderCredential>) -> Vec<ProviderStatus> {
    PROVIDER_IDS
        .iter()
        .map(|id| {
            let saved = keys.get(*id);
            ProviderStatus {
                id: (*id).to_string(),
                configured: saved.is_some(),
                key_hint: saved.and_then(|credential| credential.key.as_ref()).map(|key| {
                    let tail: String = key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
                    format!("••••{tail}")
                }),
                base_url: saved.and_then(|credential| credential.base_url.clone()),
            }
        })
        .collect()
}

/// Apply one change to the saved credentials. A changed address without a new
/// key drops the old key, so a key is never re-pointed at a server it was not
/// entered for.
fn apply_provider_change(keys: &mut std::collections::BTreeMap<String, ProviderCredential>, provider: &str, key: Option<String>, base_url: Option<String>, clear: bool) -> Result<(), String> {
    if !PROVIDER_IDS.contains(&provider) {
        return Err("Unknown provider.".into());
    }
    if clear {
        keys.remove(provider);
        return Ok(());
    }
    let key = key.map(|key| key.trim().to_string()).filter(|key| !key.is_empty());
    if let Some(key) = &key {
        if key.len() > PROVIDER_KEY_LIMIT || key.chars().any(|ch| ch.is_control() || ch.is_whitespace()) {
            return Err("That key is not valid.".into());
        }
    }
    let base_url = match base_url.map(|url| url.trim().to_string()).filter(|url| !url.is_empty()) {
        Some(url) if PROVIDER_URL_IDS.contains(&provider) => Some(check_provider_url(&url)?),
        Some(_) => return Err("This provider's address is fixed.".into()),
        None => None,
    };
    let previous = keys.get(provider).cloned().unwrap_or_default();
    let url_changed = base_url.is_some() && base_url != previous.base_url;
    let next = ProviderCredential {
        key: key.or(if url_changed { None } else { previous.key }),
        base_url: base_url.or(previous.base_url),
    };
    let local = provider == "ollama" || provider == "lmstudio";
    if next.key.is_none() && !local {
        return Err("Enter the API key.".into());
    }
    if provider == "custom" && next.base_url.is_none() {
        return Err("Enter the endpoint address.".into());
    }
    keys.insert(provider.to_string(), next);
    Ok(())
}

#[tauri::command]
pub async fn provider_keys_get() -> Result<Vec<ProviderStatus>, String> {
    tauri::async_runtime::spawn_blocking(|| provider_keys_value().map(|keys| provider_status(&keys))).await.map_err(|_| "Credential store task failed".to_string())?
}

/// Save, update or remove one provider's credential. The renderer can write a
/// key but never read one back: the answer is the masked status list.
#[tauri::command]
pub async fn provider_key_set(provider: String, key: Option<String>, base_url: Option<String>, clear: Option<bool>) -> Result<Vec<ProviderStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut keys = provider_keys_value()?;
        apply_provider_change(&mut keys, &provider, key, base_url, clear == Some(true))?;
        provider_keys_store(&keys)?;
        Ok(provider_status(&keys))
    })
    .await
    .map_err(|_| "Credential store task failed".to_string())?
}

/// Every account this app keeps under its keychain service.
#[cfg(any(target_os = "macos", test))]
const ACCOUNTS: &[&str] = &["muse-api-key", "workspace-grants", "agent-pins", "acp-isolation-consent", "provider-keys"];

/// The reads and writes `carry_over` needs: the keychain in the app, a map in tests.
#[cfg(any(target_os = "macos", test))]
trait Vault {
    fn get(&self, service: &str, account: &str) -> Result<Option<String>, String>;
    fn set(&self, service: &str, account: &str, value: &str) -> Result<(), String>;
    fn delete(&self, service: &str, account: &str) -> Result<(), String>;
}

/// Move every account from service `from` to `to`. A value already saved under
/// `to` wins. The old entry is deleted only once the new one reads back
/// intact, so a failure leaves it for the next launch. Returns the accounts
/// that could not be moved.
#[cfg(any(target_os = "macos", test))]
fn carry_over(vault: &impl Vault, from: &str, to: &str) -> Vec<&'static str> {
    let mut failed = Vec::new();
    for &account in ACCOUNTS {
        let moved = (|| {
            let Some(value) = vault.get(from, account)? else {
                return Ok(());
            };
            if vault.get(to, account)?.is_none() {
                vault.set(to, account, &value)?;
                if vault.get(to, account)?.as_deref() != Some(value.as_str()) {
                    return Err("the new entry did not read back".to_string());
                }
            }
            vault.delete(from, account)
        })();
        if moved.is_err() {
            failed.push(account);
        }
    }
    failed
}

#[cfg(target_os = "macos")]
struct Keychain;

#[cfg(target_os = "macos")]
impl Vault for Keychain {
    fn get(&self, service: &str, account: &str) -> Result<Option<String>, String> {
        match keyring::Entry::new(service, account).and_then(|entry| entry.get_password()) {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(err.to_string()),
        }
    }

    fn set(&self, service: &str, account: &str, value: &str) -> Result<(), String> {
        keyring::Entry::new(service, account).and_then(|entry| entry.set_password(value)).map_err(|err| err.to_string())
    }

    fn delete(&self, service: &str, account: &str) -> Result<(), String> {
        match keyring::Entry::new(service, account).and_then(|entry| entry.delete_credential()) {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(err.to_string()),
        }
    }
}

/// Move a Muse Code install's keychain entries (service `legacy::IDENTIFIER`)
/// to this app's service. Runs once at startup, before anything reads them;
/// macOS may ask the user to allow each read, since another app saved them.
pub fn carry_over_legacy_entries() -> Result<(), String> {
    let _guard = CREDENTIAL_LOCK.lock().map_err(|_| "Credential store lock failed")?;
    #[cfg(target_os = "macos")]
    {
        let failed = carry_over(&Keychain, crate::legacy::IDENTIFIER, SERVICE);
        if failed.is_empty() {
            Ok(())
        } else {
            Err(format!("keychain entries not moved: {}", failed.join(", ")))
        }
    }
    #[cfg(not(target_os = "macos"))]
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_set_refuses_values_over_8_kib() {
        // The boundary is inclusive: exactly 8 KiB is a (generous) credential.
        assert!(check_credential_value(&"k".repeat(CREDENTIAL_VALUE_LIMIT)).is_ok());
        let over = check_credential_value(&"k".repeat(CREDENTIAL_VALUE_LIMIT + 1));
        assert!(over.is_err());
        assert!(over.unwrap_err().contains("8 KiB"));
        // Empty stays legal: it clears the stored credential.
        assert!(check_credential_value("").is_ok());
    }

    #[test]
    fn provider_keys_bind_to_their_address_and_never_leave_as_text() {
        let mut keys = std::collections::BTreeMap::new();
        assert!(apply_provider_change(&mut keys, "nope", Some("k".into()), None, false).is_err(), "unknown ids are refused");
        assert!(apply_provider_change(&mut keys, "anthropic", None, None, false).is_err(), "a hosted provider needs a key");
        apply_provider_change(&mut keys, "anthropic", Some("sk-ant-abcd1234".into()), None, false).expect("save");
        assert!(apply_provider_change(&mut keys, "anthropic", None, Some("https://evil.example".into()), false).is_err(), "a hosted provider's address is fixed");
        let status = provider_status(&keys);
        let anthropic = status.iter().find(|row| row.id == "anthropic").expect("row");
        assert_eq!(anthropic.key_hint.as_deref(), Some("••••1234"));
        assert!(!serde_json::to_string(&status).unwrap().contains("sk-ant"), "the status never carries the key");
        // A custom endpoint: changing its address without a new key drops the key.
        apply_provider_change(&mut keys, "custom", Some("custom-key".into()), Some("https://llm.example/v1".into()), false).expect("custom");
        assert!(apply_provider_change(&mut keys, "custom", None, Some("https://other.example/v1".into()), false).is_err(), "the old key is not re-pointed");
        assert_eq!(keys.get("custom").and_then(|row| row.key.clone()).as_deref(), Some("custom-key"), "a refused change leaves the saved one");
        // Local servers need no key and may use plain http on this machine only.
        apply_provider_change(&mut keys, "ollama", None, Some("http://localhost:11500/v1".into()), false).expect("local");
        assert!(apply_provider_change(&mut keys, "lmstudio", None, Some("http://192.168.1.5:1234/v1".into()), false).is_err());
        assert!(apply_provider_change(&mut keys, "custom", Some("k".into()), Some("https://user:pw@host/v1".into()), false).is_err());
        apply_provider_change(&mut keys, "anthropic", None, None, true).expect("clear");
        assert!(!keys.contains_key("anthropic"));
        // NVIDIA NIM is a hosted provider like the others: a key, and no address of its own.
        apply_provider_change(&mut keys, "nvidia", Some("nvapi-abcd5678".into()), None, false).expect("nvidia");
        assert!(apply_provider_change(&mut keys, "nvidia", None, Some("https://nim.example/v1".into()), false).is_err(), "NIM's address is fixed");
        assert_eq!(provider_status(&keys).iter().find(|row| row.id == "nvidia").and_then(|row| row.key_hint.clone()).as_deref(), Some("••••5678"));
    }

    /// An in-memory keychain. `broken` makes writes to one account fail.
    #[derive(Default)]
    struct MapVault {
        entries: std::cell::RefCell<std::collections::BTreeMap<(String, String), String>>,
        broken: Option<&'static str>,
    }

    impl MapVault {
        fn with(entries: &[(&str, &str, &str)]) -> Self {
            let vault = Self::default();
            for (service, account, value) in entries {
                vault.entries.borrow_mut().insert((service.to_string(), account.to_string()), value.to_string());
            }
            vault
        }

        fn value(&self, service: &str, account: &str) -> Option<String> {
            self.entries.borrow().get(&(service.to_string(), account.to_string())).cloned()
        }
    }

    impl Vault for MapVault {
        fn get(&self, service: &str, account: &str) -> Result<Option<String>, String> {
            Ok(self.value(service, account))
        }

        fn set(&self, service: &str, account: &str, value: &str) -> Result<(), String> {
            if self.broken == Some(account) {
                return Err("locked".into());
            }
            self.entries.borrow_mut().insert((service.to_string(), account.to_string()), value.to_string());
            Ok(())
        }

        fn delete(&self, service: &str, account: &str) -> Result<(), String> {
            self.entries.borrow_mut().remove(&(service.to_string(), account.to_string()));
            Ok(())
        }
    }

    #[test]
    fn carry_over_moves_every_entry_to_the_new_service() {
        let vault = MapVault::with(&[("old", "muse-api-key", "sk-1"), ("old", "workspace-grants", "{}"), ("old", "provider-keys", "{\"openai\":{}}"), ("old", "unrelated", "kept")]);
        assert!(carry_over(&vault, "old", "new").is_empty());
        assert_eq!(vault.value("new", "muse-api-key").as_deref(), Some("sk-1"));
        assert_eq!(vault.value("new", "workspace-grants").as_deref(), Some("{}"));
        assert_eq!(vault.value("new", "provider-keys").as_deref(), Some("{\"openai\":{}}"));
        assert_eq!(vault.value("old", "muse-api-key"), None, "a moved entry leaves the old service");
        assert_eq!(vault.value("new", "agent-pins"), None, "an absent entry is not invented");
        assert_eq!(vault.value("old", "unrelated").as_deref(), Some("kept"), "only this app's accounts move");
    }

    #[test]
    fn carry_over_keeps_a_newer_value_and_retries_a_failed_move() {
        let vault = MapVault { broken: Some("agent-pins"), ..MapVault::with(&[("old", "muse-api-key", "stale"), ("new", "muse-api-key", "current"), ("old", "agent-pins", "pins")]) };
        assert_eq!(carry_over(&vault, "old", "new"), ["agent-pins"]);
        assert_eq!(vault.value("new", "muse-api-key").as_deref(), Some("current"), "a value saved by this build wins");
        assert_eq!(vault.value("old", "muse-api-key"), None);
        assert_eq!(vault.value("old", "agent-pins").as_deref(), Some("pins"), "a failed copy keeps the original for the next launch");
    }
}
