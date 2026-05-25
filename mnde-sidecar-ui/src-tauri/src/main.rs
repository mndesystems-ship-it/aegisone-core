#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{canonicalize, create_dir_all, read_to_string, remove_file, write};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use keyring::Entry;
use sha2::{Digest, Sha256};
use url::Url;

static LIFECYCLE_LOCK: Mutex<()> = Mutex::new(());
static AUTH_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize)]
struct SidecarLaunchResult {
    started: bool,
    message: String,
    script_path: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct OwnedSidecarPid {
    pid: u32,
    executable_path: String,
    launcher_path: String,
}

#[derive(Serialize)]
struct LifecycleResult {
    status: String,
    pid: Option<u32>,
    owned: bool,
    message: String,
    executable_path: Option<String>,
}

#[derive(Serialize)]
struct SidecarHttpResponse {
    status: u16,
    body: String,
}

#[derive(Serialize)]
struct ExportReceiptResult {
    path: String,
}

#[derive(Serialize)]
struct OpenFolderResult {
    opened: bool,
    path: String,
    message: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct AuthSession {
    user_id: String,
    display_name: String,
    email: String,
    tenant_id: String,
    provider: String,
    role: String,
    login_time: String,
    session_expiry: String,
    session_expiry_ms: Option<u64>,
}

#[derive(Serialize)]
struct AuthAuditResult {
    recorded: bool,
    path: String,
}

#[derive(Serialize)]
struct ProviderConfigReadiness {
    configured: bool,
    errors: Vec<String>,
}

#[derive(Serialize)]
struct AuthConfigStatus {
    microsoft_entra: ProviderConfigReadiness,
    okta: ProviderConfigReadiness,
    secure_token_storage: String,
    secure_token_storage_available: bool,
}

#[derive(Serialize, Deserialize, Clone)]
struct RbacAssignment {
    user_id: Option<String>,
    email: Option<String>,
    display_name: String,
    role: String,
    assigned_by: String,
    assigned_at: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct RbacPolicy {
    schema_version: String,
    tenant_id: String,
    assignments: Vec<RbacAssignment>,
}

#[derive(Serialize)]
struct RbacStatus {
    bootstrapped: bool,
    can_bootstrap: bool,
    assignments: Vec<RbacAssignment>,
}

#[derive(Deserialize)]
struct RbacAssignmentInput {
    user_id: Option<String>,
    email: Option<String>,
    display_name: String,
    role: String,
}

#[derive(Serialize)]
struct OidcCallbackResult {
    code: String,
    state: String,
}

#[derive(Clone)]
struct OidcConfig {
    provider: String,
    issuer: String,
    client_id: String,
    redirect_uri: String,
    scopes: Vec<String>,
    audience: String,
    tenant_id: Option<String>,
    group_role_map: HashMap<String, String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AuthConfigFile {
    provider: String,
    entra: Option<AuthProviderFileConfig>,
    okta: Option<AuthProviderFileConfig>,
    issuer: Option<String>,
    client_id: Option<String>,
    redirect_uri: Option<String>,
    scopes: Option<Vec<String>>,
    audience: Option<String>,
    tenant_id: Option<String>,
    group_role_map: Option<HashMap<String, String>>,
}

#[derive(Deserialize, Clone)]
#[serde(deny_unknown_fields)]
struct AuthProviderFileConfig {
    issuer: Option<String>,
    client_id: Option<String>,
    redirect_uri: Option<String>,
    scopes: Option<Vec<String>>,
    audience: Option<String>,
    tenant_id: Option<String>,
    group_role_map: Option<HashMap<String, String>>,
}

#[derive(Deserialize)]
struct DiscoveryDocument {
    authorization_endpoint: String,
    token_endpoint: String,
    jwks_uri: String,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct TokenResponse {
    id_token: String,
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
}

#[derive(Deserialize)]
struct Claims {
    iss: String,
    aud: Value,
    exp: u64,
    iat: Option<u64>,
    nonce: Option<String>,
    sub: Option<String>,
    oid: Option<String>,
    name: Option<String>,
    email: Option<String>,
    preferred_username: Option<String>,
    upn: Option<String>,
    tid: Option<String>,
    groups: Option<Vec<String>>,
    mnde_role: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "UPPERCASE")]
enum SidecarHttpMethod {
    Get,
    Post,
}

#[tauri::command]
fn start_mnde_sidecar() -> Result<SidecarLaunchResult, String> {
    require_capability("manage_runtime")?;
    let _guard = LIFECYCLE_LOCK
        .try_lock()
        .map_err(|_| "sidecar lifecycle operation already in progress".to_string())?;
    start_mnde_sidecar_inner()
}

fn start_mnde_sidecar_inner() -> Result<SidecarLaunchResult, String> {
    if sidecar_port_is_open() {
        let status = sidecar_status_inner();
        let message = if status.owned {
            "MNDe sidecar is already running and owned by this app."
        } else {
            "External sidecar detected on 127.0.0.1:8787."
        };
        return Ok(SidecarLaunchResult {
            started: true,
            message: message.to_string(),
            script_path: None,
        });
    }

    let launcher = find_sidecar_launcher()
        .ok_or_else(|| "MNDe sidecar launcher was not found in the local workspace.".to_string())?;

    let mut command = Command::new(&launcher.program);
    command.args(&launcher.args).current_dir(&launcher.working_dir);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let child = command
        .spawn()
        .map_err(|error| format!("Failed to start MNDe sidecar: {error}"))?;
    let pid = child.id();
    let executable_path = process_executable_path(pid).unwrap_or_else(|| launcher.program.clone());
    write_owned_pid(&OwnedSidecarPid {
        pid,
        executable_path,
        launcher_path: launcher.display_path.display().to_string(),
    })?;

    Ok(SidecarLaunchResult {
        started: true,
        message: "MNDe sidecar start requested. Waiting for health check.".to_string(),
        script_path: Some(launcher.display_path.display().to_string()),
    })
}

#[tauri::command]
fn sidecar_status() -> LifecycleResult {
    sidecar_status_inner()
}

#[tauri::command]
fn stop_mnde_sidecar() -> Result<LifecycleResult, String> {
    require_capability("manage_runtime")?;
    let _guard = LIFECYCLE_LOCK
        .try_lock()
        .map_err(|_| "sidecar lifecycle operation already in progress".to_string())?;
    stop_mnde_sidecar_inner()
}

#[tauri::command]
fn restart_mnde_sidecar() -> Result<LifecycleResult, String> {
    require_capability("manage_runtime")?;
    let _guard = LIFECYCLE_LOCK
        .try_lock()
        .map_err(|_| "sidecar lifecycle operation already in progress".to_string())?;
    let stopped = stop_mnde_sidecar_inner()?;
    if stopped.status == "error" {
        return Ok(stopped);
    }
    let started = start_mnde_sidecar_inner()?;
    let status = sidecar_status_inner();
    Ok(LifecycleResult {
        status: if status.status == "running" { "running".to_string() } else { status.status },
        pid: status.pid,
        owned: status.owned,
        message: started.message,
        executable_path: status.executable_path,
    })
}

#[tauri::command]
fn sidecar_request(
    endpoint: String,
    path: String,
    method: SidecarHttpMethod,
    body: String,
) -> Result<SidecarHttpResponse, String> {
    let (host, port) = parse_local_http_endpoint(&endpoint)?;
    if host != "127.0.0.1" && host != "localhost" {
        return Err("Only local MNDe sidecar endpoints are supported by the desktop bridge.".to_string());
    }
    if !path.starts_with('/') || path.contains('\r') || path.contains('\n') {
        return Err("Invalid MNDe sidecar request path.".to_string());
    }

    let mut stream = TcpStream::connect_timeout(
        &format!("{host}:{port}")
            .parse::<SocketAddr>()
            .map_err(|error| format!("Invalid MNDe sidecar address: {error}"))?,
        Duration::from_millis(1200),
    )
    .map_err(|error| format!("MNDe sidecar unavailable: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_millis(1200)))
        .map_err(|error| format!("Failed to configure sidecar read timeout: {error}"))?;

    let method_text = match method {
        SidecarHttpMethod::Get => "GET",
        SidecarHttpMethod::Post => "POST",
    };
    let authority_header = authority_context_header().unwrap_or_default();
    let request = format!(
        "{method_text} {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\nContent-Type: application/json\r\n{authority_header}Content-Length: {}\r\n\r\n{}",
        body.as_bytes().len(),
        body
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("Failed to write sidecar request: {error}"))?;

    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .map_err(|error| format!("Failed to read sidecar response: {error}"))?;
    parse_http_response(&response)
}

#[tauri::command]
fn export_receipt_json(receipt_id: String, body: String) -> Result<ExportReceiptResult, String> {
    require_capability("inspect_receipts")?;
    let safe_id: String = receipt_id
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' { ch } else { '-' })
        .collect();
    let filename = if safe_id.is_empty() { "receipt".to_string() } else { safe_id };
    let dir = std::env::current_dir()
        .map_err(|error| format!("Failed to resolve export directory: {error}"))?
        .join("receipt-exports");
    create_dir_all(&dir).map_err(|error| format!("Failed to create export directory: {error}"))?;
    let path = dir.join(format!("{filename}.json"));
    write(&path, body).map_err(|error| format!("Failed to export receipt: {error}"))?;
    Ok(ExportReceiptResult {
        path: path.display().to_string(),
    })
}

#[tauri::command]
fn open_audit_bundle_folder(path: String) -> Result<OpenFolderResult, String> {
    require_capability("export_audit")?;
    let canonical = validate_audit_bundle_path(&path)?;
    #[cfg(windows)]
    let status = Command::new("explorer")
        .arg(&canonical)
        .status()
        .map_err(|error| format!("Failed to open audit bundle folder: {error}"))?;
    #[cfg(target_os = "macos")]
    let status = Command::new("open")
        .arg(&canonical)
        .status()
        .map_err(|error| format!("Failed to open audit bundle folder: {error}"))?;
    #[cfg(all(not(windows), not(target_os = "macos")))]
    let status = Command::new("xdg-open")
        .arg(&canonical)
        .status()
        .map_err(|error| format!("Failed to open audit bundle folder: {error}"))?;

    if !status.success() {
        return Err("Failed to open audit bundle folder.".to_string());
    }
    Ok(OpenFolderResult {
        opened: true,
        path: canonical.display().to_string(),
        message: "audit bundle folder opened".to_string(),
    })
}

#[tauri::command]
fn auth_bootstrap() -> Result<Option<AuthSession>, String> {
    let Some(session) = read_auth_session() else {
        return Ok(None);
    };
    if session_expires_soon(&session, 5 * 60 * 1000) {
        if let Some(refreshed) = refresh_session_if_possible(&session)? {
            return Ok(Some(reconcile_stored_session_role(refreshed)?));
        }
    }
    match validate_session(&session) {
        Ok(()) => Ok(Some(reconcile_stored_session_role(session)?)),
        Err(_) => {
            if let Some(refreshed) = refresh_session_if_possible(&session)? {
                return Ok(Some(reconcile_stored_session_role(refreshed)?));
            }
            clear_auth_session();
            Err("auth session expired and refresh failed".to_string())
        }
    }
}

#[tauri::command]
fn auth_config_status() -> AuthConfigStatus {
    AuthConfigStatus {
        microsoft_entra: validate_provider_config("microsoft_entra"),
        okta: validate_provider_config("okta"),
        secure_token_storage: secure_token_storage_label(),
        secure_token_storage_available: secure_token_storage_available(),
    }
}

#[tauri::command]
fn rbac_status() -> Result<RbacStatus, String> {
    let session = read_auth_session();
    let policy = load_rbac_policy().ok();
    Ok(RbacStatus {
        bootstrapped: policy.as_ref().map(|item| !item.can_bootstrap()).unwrap_or(false),
        can_bootstrap: session.is_some() && policy.as_ref().map(RbacPolicy::can_bootstrap).unwrap_or(true),
        assignments: policy.map(|item| item.assignments).unwrap_or_default(),
    })
}

#[tauri::command]
fn rbac_bootstrap_admin() -> Result<AuthSession, String> {
    let mut session = read_auth_session().ok_or_else(|| "enterprise authentication required".to_string())?;
    validate_session(&session)?;
    let policy = load_rbac_policy().unwrap_or_else(|_| RbacPolicy::new(session.tenant_id.clone()));
    if !policy.can_bootstrap() {
        return Err("MNDe admin bootstrap is already complete".to_string());
    }
    let assignment = RbacAssignment {
        user_id: Some(session.user_id.clone()),
        email: Some(session.email.clone()),
        display_name: session.display_name.clone(),
        role: "ADMIN".to_string(),
        assigned_by: "bootstrap".to_string(),
        assigned_at: now_millis().to_string(),
    };
    let policy = RbacPolicy {
        schema_version: "mnde.rbac_policy.v1".to_string(),
        tenant_id: session.tenant_id.clone(),
        assignments: vec![assignment],
    };
    save_rbac_policy(&policy)?;
    session.role = "ADMIN".to_string();
    write_auth_session(&session)?;
    append_auth_audit(&session, "rbac.bootstrap_admin", &session.email, "ALLOW", None)?;
    Ok(session)
}

#[tauri::command]
fn rbac_upsert_assignment(input: RbacAssignmentInput) -> Result<RbacStatus, String> {
    let session = require_capability("manage_users")?;
    let mut policy = load_rbac_policy()?;
    if policy.tenant_id != session.tenant_id {
        return Err("RBAC policy tenant does not match authenticated tenant".to_string());
    }
    let role = input.role.trim().to_uppercase();
    if !matches!(role.as_str(), "ADMIN" | "OPERATOR" | "AUDITOR" | "VIEWER") {
        return Err("ERR_RBAC_ROLE_INVALID".to_string());
    }
    let user_id = input.user_id.filter(|value| !value.trim().is_empty());
    let email = input.email.map(|value| value.trim().to_lowercase()).filter(|value| !value.is_empty());
    if user_id.is_none() && email.is_none() {
        return Err("ERR_RBAC_SUBJECT_REQUIRED".to_string());
    }
    let assignment = RbacAssignment {
        user_id,
        email,
        display_name: input.display_name.trim().to_string(),
        role,
        assigned_by: session.user_id.clone(),
        assigned_at: now_millis().to_string(),
    };
    policy.upsert(assignment)?;
    save_rbac_policy(&policy)?;
    append_auth_audit(&session, "rbac.upsert_assignment", "rbac-policy.local.json", "ALLOW", None)?;
    rbac_status()
}

#[tauri::command]
fn begin_oidc_login(provider: String) -> Result<AuthSession, String> {
    let _guard = AUTH_LOCK
        .try_lock()
        .map_err(|_| "OIDC login already in progress".to_string())?;
    if provider != "microsoft_entra" && provider != "okta" {
        return Err("Unsupported enterprise auth provider.".to_string());
    }
    let config = load_oidc_config(&provider)?;
    if !secure_token_storage_available() {
        return Err(format!("{provider} OIDC refused: OS secure token storage is unavailable."));
    }
    oidc_login_flow(&config)
}

#[tauri::command]
fn auth_logout() -> Result<(), String> {
    if let Some(session) = read_auth_session() {
        let _ = delete_refresh_token(&session.provider, &session.user_id);
    }
    clear_auth_session();
    Ok(())
}

#[tauri::command]
fn record_auth_audit(action: String, target: String, result: String, decision_hash: Option<String>) -> Result<AuthAuditResult, String> {
    let session = current_valid_session()?;
    append_auth_audit(&session, &action, &target, &result, decision_hash.as_deref())?;
    Ok(AuthAuditResult {
        recorded: true,
        path: auth_audit_file_path()?.display().to_string(),
    })
}

struct SidecarLauncher {
    program: String,
    args: Vec<String>,
    working_dir: PathBuf,
    display_path: PathBuf,
}

fn auth_session_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|error| format!("Failed to resolve current executable: {error}"))?;
    Ok(exe
        .parent()
        .ok_or_else(|| "Failed to resolve executable directory.".to_string())?
        .join("mnde-auth-session.protected.json"))
}

fn secure_token_storage_label() -> String {
    #[cfg(windows)]
    {
        "windows-dpapi-required".to_string()
    }
    #[cfg(target_os = "macos")]
    {
        "macos-keychain-required".to_string()
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        "secret-service-required".to_string()
    }
}

fn secure_token_storage_available() -> bool {
    Entry::new("MNDe Execution Control", "storage-probe")
        .and_then(|entry| {
            entry.set_password("probe")?;
            entry.delete_credential()
        })
        .is_ok()
}

fn load_oidc_config(provider: &str) -> Result<OidcConfig, String> {
    let readiness = validate_provider_config(provider);
    if !readiness.configured {
        return Err(format!("{provider} OIDC is not configured: {}", readiness.errors.join("; ")));
    }
    let file = provider_file_config(provider)?;
    let issuer = required_config_value(file.issuer.clone(), "issuer")?;
    let client_id = required_config_value(file.client_id.clone(), "client_id")?;
    let redirect_uri = required_config_value(file.redirect_uri.clone(), "redirect_uri")?;
    let scopes = file.scopes.clone().ok_or_else(|| "ERR_AUTH_CONFIG_INVALID:scopes".to_string())?;
    let audience = required_config_value(file.audience.clone(), "audience")?;
    let tenant_id = if provider == "microsoft_entra" {
        Some(required_config_value(file.tenant_id.clone(), "tenant_id")?)
    } else {
        file.tenant_id.clone().filter(|value| !value.trim().is_empty())
    };
    Ok(OidcConfig {
        provider: provider.to_string(),
        issuer,
        client_id,
        redirect_uri,
        scopes,
        audience,
        tenant_id,
        group_role_map: file.group_role_map.unwrap_or_default(),
    })
}

fn oidc_login_flow(config: &OidcConfig) -> Result<AuthSession, String> {
    let discovery = fetch_discovery(config)?;
    let verifier = random_urlsafe(32)?;
    let challenge = pkce_challenge(&verifier);
    let state = random_urlsafe(24)?;
    let nonce = random_urlsafe(24)?;
    let auth_url = build_auth_url(config, &discovery, &challenge, &state, &nonce)?;
    let listener = bind_callback_listener(&config.redirect_uri)?;
    open_system_browser(&auth_url)?;
    let callback = wait_for_callback(listener, &state)?;
    let token = exchange_code(config, &discovery, &callback.code, &verifier)?;
    let jwks = fetch_jwks(&config.issuer, &discovery.jwks_uri)?;
    let session = validate_id_token_rust(config, &token.id_token, &jwks, &nonce)?;
    let refresh = token.refresh_token.ok_or_else(|| "OIDC provider did not return refresh_token".to_string())?;
    store_refresh_token(&config.provider, &session.user_id, &refresh)?;
    write_auth_session(&session)?;
    append_auth_audit(&session, "login.success", &config.provider, "ALLOW", None)?;
    Ok(session)
}

fn fetch_discovery(config: &OidcConfig) -> Result<DiscoveryDocument, String> {
    let url = format!("{}/.well-known/openid-configuration", config.issuer.trim_end_matches('/'));
    reqwest::blocking::get(url)
        .map_err(|error| format!("OIDC discovery fetch failed: {error}"))?
        .error_for_status()
        .map_err(|error| format!("OIDC discovery returned error: {error}"))?
        .json::<DiscoveryDocument>()
        .map_err(|error| format!("OIDC discovery parse failed: {error}"))
}

fn build_auth_url(config: &OidcConfig, discovery: &DiscoveryDocument, challenge: &str, state: &str, nonce: &str) -> Result<String, String> {
    let mut url = Url::parse(&discovery.authorization_endpoint).map_err(|error| format!("Invalid authorization endpoint: {error}"))?;
    url.query_pairs_mut()
        .append_pair("client_id", &config.client_id)
        .append_pair("redirect_uri", &config.redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", &config.scopes.join(" "))
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state)
        .append_pair("nonce", nonce);
    Ok(url.to_string())
}

fn bind_callback_listener(redirect_uri: &str) -> Result<TcpListener, String> {
    let url = Url::parse(redirect_uri).map_err(|error| format!("Invalid redirect_uri: {error}"))?;
    if url.host_str() != Some("localhost") {
        return Err("redirect_uri must use localhost".to_string());
    }
    let port = url.port().ok_or_else(|| "redirect_uri must include a port".to_string())?;
    let listener = TcpListener::bind(("127.0.0.1", port)).map_err(|error| format!("Failed to bind OIDC callback listener: {error}"))?;
    listener.set_nonblocking(false).map_err(|error| format!("Failed to configure OIDC listener: {error}"))?;
    Ok(listener)
}

fn wait_for_callback(listener: TcpListener, expected_state: &str) -> Result<OidcCallbackResult, String> {
    listener.set_ttl(64).ok();
    let (mut stream, _) = listener.accept().map_err(|error| format!("OIDC callback accept failed: {error}"))?;
    let mut buffer = [0_u8; 8192];
    let count = stream.read(&mut buffer).map_err(|error| format!("OIDC callback read failed: {error}"))?;
    let request = String::from_utf8_lossy(&buffer[..count]);
    let request_line = request.lines().next().ok_or_else(|| "OIDC callback request missing request line".to_string())?;
    let path = request_line.split_whitespace().nth(1).ok_or_else(|| "OIDC callback path missing".to_string())?;
    let callback = parse_oidc_callback_url(&format!("http://127.0.0.1{path}"), expected_state);
    let body = if callback.is_ok() { "MNDe login complete. You may close this window." } else { "MNDe login failed. Return to the app." };
    let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
    let _ = stream.write_all(response.as_bytes());
    callback
}

fn exchange_code(config: &OidcConfig, discovery: &DiscoveryDocument, code: &str, verifier: &str) -> Result<TokenResponse, String> {
    let body = form_encode(&[
        ("grant_type", "authorization_code"),
        ("client_id", &config.client_id),
        ("code", code),
        ("redirect_uri", &config.redirect_uri),
        ("code_verifier", verifier),
    ]);
    reqwest::blocking::Client::new()
        .post(&discovery.token_endpoint)
        .header("content-type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .map_err(|error| format!("OIDC code exchange failed: {error}"))?
        .error_for_status()
        .map_err(|error| format!("OIDC code exchange returned error: {error}"))?
        .json::<TokenResponse>()
        .map_err(|error| format!("OIDC token response parse failed: {error}"))
}

fn fetch_jwks(issuer: &str, jwks_uri: &str) -> Result<Value, String> {
    let path = jwks_cache_path(issuer)?;
    if let Ok(raw) = read_to_string(&path) {
        if let Ok(value) = serde_json::from_str::<Value>(&raw) {
            return Ok(value);
        }
    }
    let value = reqwest::blocking::get(jwks_uri)
        .map_err(|error| format!("JWKS fetch failed: {error}"))?
        .error_for_status()
        .map_err(|error| format!("JWKS fetch returned error: {error}"))?
        .json::<Value>()
        .map_err(|error| format!("JWKS parse failed: {error}"))?;
    if let Some(parent) = path.parent() {
        create_dir_all(parent).map_err(|error| format!("Failed to create JWKS cache directory: {error}"))?;
    }
    write(&path, serde_json::to_string(&value).unwrap_or_default()).map_err(|error| format!("Failed to write JWKS cache: {error}"))?;
    Ok(value)
}

fn validate_id_token_rust(config: &OidcConfig, id_token: &str, jwks: &Value, expected_nonce: &str) -> Result<AuthSession, String> {
    if id_token.len() > 16 * 1024 {
        return Err("ERR_TOKEN_TOO_LARGE".to_string());
    }
    let header = decode_header(id_token).map_err(|_| "ERR_TOKEN_MALFORMED".to_string())?;
    if header.alg != Algorithm::RS256 {
        return Err("ERR_TOKEN_UNSIGNED_OR_UNSUPPORTED".to_string());
    }
    let kid = header.kid.ok_or_else(|| "ERR_TOKEN_KID_MISSING".to_string())?;
    let key_value = jwks.get("keys")
        .and_then(Value::as_array)
        .and_then(|keys| keys.iter().find(|key| key.get("kid").and_then(Value::as_str) == Some(&kid)))
        .ok_or_else(|| "ERR_JWKS_KEY_NOT_FOUND".to_string())?;
    let jwk = serde_json::from_value(key_value.clone()).map_err(|error| format!("JWKS key parse failed: {error}"))?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_issuer(&[config.issuer.clone()]);
    validation.set_audience(&[config.audience.clone()]);
    let decoded = decode::<Claims>(id_token, &DecodingKey::from_jwk(&jwk).map_err(|error| format!("JWKS decode key failed: {error}"))?, &validation)
        .map_err(|error| format!("ID token validation failed: {error}"))?;
    claims_to_session(config, decoded.claims, expected_nonce)
}

fn claims_to_session(config: &OidcConfig, claims: Claims, expected_nonce: &str) -> Result<AuthSession, String> {
    if claims.iss != config.issuer {
        return Err("wrong issuer".to_string());
    }
    if !audience_matches(&claims.aud, &config.audience) {
        return Err("wrong audience".to_string());
    }
    if claims.exp <= now_millis() / 1000 {
        return Err("expired token".to_string());
    }
    if claims.nonce.as_deref() != Some(expected_nonce) {
        return Err("bad nonce".to_string());
    }
    if let Some(expected_tenant) = &config.tenant_id {
        if claims.tid.as_deref() != Some(expected_tenant) {
            return Err("wrong tenant".to_string());
        }
    }
    let email = claims.email.or(claims.preferred_username).or(claims.upn).ok_or_else(|| "missing email claim".to_string())?;
    let user_id = claims.sub.or(claims.oid).ok_or_else(|| "missing user claim".to_string())?;
    let tenant_id = claims.tid.or_else(|| config.tenant_id.clone()).ok_or_else(|| "missing tenant claim".to_string())?;
    let role = resolve_session_role(config, &tenant_id, &user_id, &email, claims.mnde_role.as_deref(), claims.groups.as_deref());
    Ok(AuthSession {
        user_id,
        display_name: claims.name.unwrap_or_else(|| email.clone()),
        email,
        tenant_id,
        provider: config.provider.clone(),
        role,
        login_time: (claims.iat.unwrap_or_else(|| now_millis() / 1000) * 1000).to_string(),
        session_expiry: (claims.exp * 1000).to_string(),
        session_expiry_ms: Some(claims.exp * 1000),
    })
}

fn refresh_session_if_possible(session: &AuthSession) -> Result<Option<AuthSession>, String> {
    let Ok(refresh) = read_refresh_token(&session.provider, &session.user_id) else {
        return Ok(None);
    };
    let config = load_oidc_config(&session.provider)?;
    let discovery = fetch_discovery(&config)?;
    let body = form_encode(&[
        ("grant_type", "refresh_token"),
        ("client_id", config.client_id.as_str()),
        ("refresh_token", refresh.as_str()),
    ]);
    let token = reqwest::blocking::Client::new()
        .post(&discovery.token_endpoint)
        .header("content-type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .map_err(|error| format!("OIDC refresh failed: {error}"))?
        .error_for_status()
        .map_err(|error| format!("OIDC refresh returned error: {error}"))?
        .json::<TokenResponse>()
        .map_err(|error| format!("OIDC refresh response parse failed: {error}"))?;
    let jwks = fetch_jwks(&config.issuer, &discovery.jwks_uri)?;
    let refreshed = validate_id_token_rust(&config, &token.id_token, &jwks, "").or_else(|_| validate_refreshed_id_token(&config, &token.id_token, &jwks))?;
    if let Some(new_refresh) = token.refresh_token {
        store_refresh_token(&config.provider, &refreshed.user_id, &new_refresh)?;
    }
    write_auth_session(&refreshed)?;
    Ok(Some(refreshed))
}

fn validate_refreshed_id_token(config: &OidcConfig, id_token: &str, jwks: &Value) -> Result<AuthSession, String> {
    if id_token.len() > 16 * 1024 {
        return Err("ERR_TOKEN_TOO_LARGE".to_string());
    }
    let header = decode_header(id_token).map_err(|_| "ERR_TOKEN_MALFORMED".to_string())?;
    if header.alg != Algorithm::RS256 {
        return Err("ERR_TOKEN_UNSIGNED_OR_UNSUPPORTED".to_string());
    }
    let kid = header.kid.ok_or_else(|| "ERR_TOKEN_KID_MISSING".to_string())?;
    let key_value = jwks.get("keys")
        .and_then(Value::as_array)
        .and_then(|keys| keys.iter().find(|key| key.get("kid").and_then(Value::as_str) == Some(&kid)))
        .ok_or_else(|| "JWKS key not found".to_string())?;
    let jwk = serde_json::from_value(key_value.clone()).map_err(|error| format!("JWKS key parse failed: {error}"))?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_issuer(&[config.issuer.clone()]);
    validation.set_audience(&[config.audience.clone()]);
    let decoded = decode::<Claims>(id_token, &DecodingKey::from_jwk(&jwk).map_err(|error| format!("JWKS decode key failed: {error}"))?, &validation)
        .map_err(|error| format!("ID token validation failed: {error}"))?;
    claims_to_session_without_nonce(config, decoded.claims)
}

fn claims_to_session_without_nonce(config: &OidcConfig, mut claims: Claims) -> Result<AuthSession, String> {
    claims.nonce = Some("refresh".to_string());
    claims_to_session(config, claims, "refresh")
}

fn open_system_browser(url: &str) -> Result<(), String> {
    #[cfg(windows)]
    let status = {
        let (program, args) = windows_browser_launcher_command(url);
        Command::new(program).args(args).status()
    };
    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg(url).status();
    #[cfg(all(not(windows), not(target_os = "macos")))]
    let status = Command::new("xdg-open").arg(url).status();
    status.map_err(|error| format!("Failed to open system browser: {error}")).and_then(|status| {
        if status.success() { Ok(()) } else { Err("System browser launch failed".to_string()) }
    })
}

#[cfg(windows)]
fn windows_browser_launcher_command(url: &str) -> (&'static str, [&str; 2]) {
    ("rundll32.exe", ["url.dll,FileProtocolHandler", url])
}

fn store_refresh_token(provider: &str, user_id: &str, token: &str) -> Result<(), String> {
    Entry::new("MNDe Execution Control", &format!("{provider}:{user_id}:refresh"))
        .map_err(|error| format!("Secure storage unavailable: {error}"))?
        .set_password(token)
        .map_err(|error| format!("Failed to store refresh token securely: {error}"))
}

fn read_refresh_token(provider: &str, user_id: &str) -> Result<String, String> {
    Entry::new("MNDe Execution Control", &format!("{provider}:{user_id}:refresh"))
        .map_err(|error| format!("Secure storage unavailable: {error}"))?
        .get_password()
        .map_err(|error| format!("Refresh token unavailable: {error}"))
}

fn delete_refresh_token(provider: &str, user_id: &str) -> Result<(), String> {
    Entry::new("MNDe Execution Control", &format!("{provider}:{user_id}:refresh"))
        .map_err(|error| format!("Secure storage unavailable: {error}"))?
        .delete_credential()
        .map_err(|error| format!("Failed to delete refresh token: {error}"))
}

fn jwks_cache_path(issuer: &str) -> Result<PathBuf, String> {
    let safe = issuer.chars().map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' }).collect::<String>();
    let exe = std::env::current_exe().map_err(|error| format!("Failed to resolve current executable: {error}"))?;
    Ok(exe.parent().ok_or_else(|| "Failed to resolve executable directory.".to_string())?.join("jwks-cache").join(format!("{safe}.json")))
}

fn random_urlsafe(length: usize) -> Result<String, String> {
    let mut bytes = vec![0_u8; length];
    getrandom::getrandom(&mut bytes).map_err(|error| format!("secure random read failed: {error}"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn audience_matches(aud: &Value, expected: &str) -> bool {
    aud.as_str().map(|value| value == expected).unwrap_or(false)
        || aud.as_array().map(|items| items.iter().any(|item| item.as_str() == Some(expected))).unwrap_or(false)
}

fn resolve_session_role(config: &OidcConfig, tenant_id: &str, user_id: &str, email: &str, direct: Option<&str>, groups: Option<&[String]>) -> String {
    if let Ok(policy) = load_rbac_policy() {
        if let Some(role) = policy.resolve_role(tenant_id, user_id, email) {
            return role;
        }
    }
    map_oidc_role(config, direct, groups)
}

fn map_oidc_role(config: &OidcConfig, direct: Option<&str>, groups: Option<&[String]>) -> String {
    if let Some(role) = direct.map(str::to_uppercase) {
        if matches!(role.as_str(), "ADMIN" | "OPERATOR" | "AUDITOR" | "VIEWER") {
            return role;
        }
    }
    let groups = groups.unwrap_or(&[]);
    for group in groups {
        if let Some(role) = config.group_role_map.get(group) {
            return role.clone();
        }
    }
    "VIEWER".to_string()
}

fn reconcile_session_role_with_policy(session: &mut AuthSession, policy: Option<&RbacPolicy>) -> bool {
    let previous = session.role.clone();
    if let Some(role) = policy.and_then(|item| item.resolve_role(&session.tenant_id, &session.user_id, &session.email)) {
        session.role = role;
    } else if session.role != "VIEWER" {
        session.role = "VIEWER".to_string();
    }
    session.role != previous
}

fn reconcile_stored_session_role(mut session: AuthSession) -> Result<AuthSession, String> {
    let policy = load_rbac_policy().ok();
    let changed = reconcile_session_role_with_policy(&mut session, policy.as_ref());
    validate_session(&session)?;
    if changed {
        write_auth_session(&session)?;
    }
    Ok(session)
}

#[allow(dead_code)]
fn parse_oidc_callback_url(callback_url: &str, expected_state: &str) -> Result<OidcCallbackResult, String> {
    let query = callback_url
        .split_once('?')
        .map(|(_, query)| query)
        .ok_or_else(|| "ERR_OIDC_CALLBACK_QUERY_MISSING".to_string())?;
    let mut code = None;
    let mut state = None;
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if key == "code" {
            code = Some(percent_decode(value));
        }
        if key == "state" {
            state = Some(percent_decode(value));
        }
    }
    let state = state.ok_or_else(|| "ERR_OIDC_STATE_MISSING".to_string())?;
    if state != expected_state {
        return Err("ERR_OIDC_STATE_MISMATCH".to_string());
    }
    let code = code.ok_or_else(|| "ERR_OIDC_CODE_MISSING".to_string())?;
    Ok(OidcCallbackResult { code, state })
}

#[allow(dead_code)]
fn percent_decode(value: &str) -> String {
    let mut out = String::new();
    let mut chars = value.as_bytes().iter().copied();
    while let Some(byte) = chars.next() {
        if byte == b'%' {
            let hi = chars.next();
            let lo = chars.next();
            if let (Some(hi), Some(lo)) = (hi, lo) {
                if let Ok(text) = std::str::from_utf8(&[hi, lo]) {
                    if let Ok(decoded) = u8::from_str_radix(text, 16) {
                        out.push(decoded as char);
                        continue;
                    }
                }
            }
            out.push('%');
        } else if byte == b'+' {
            out.push(' ');
        } else {
            out.push(byte as char);
        }
    }
    out
}

fn form_encode(params: &[(&str, &str)]) -> String {
    params
        .iter()
        .map(|(key, value)| format!("{}={}", percent_encode(key), percent_encode(value)))
        .collect::<Vec<_>>()
        .join("&")
}

fn percent_encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(*byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn validate_provider_config(provider: &str) -> ProviderConfigReadiness {
    let mut errors = Vec::new();
    if provider != "microsoft_entra" && provider != "okta" {
        errors.push("ERR_AUTH_PROVIDER_UNSUPPORTED".to_string());
        return ProviderConfigReadiness { configured: false, errors };
    }
    let config_file = match load_auth_config_file() {
        Ok(file) => file,
        Err(error) => {
            errors.push(error);
            return ProviderConfigReadiness { configured: false, errors };
        }
    };
    if normalize_provider(&config_file.provider).as_deref() != Some(provider) {
        errors.push("ERR_AUTH_PROVIDER_UNSUPPORTED".to_string());
    }
    let file = match provider {
        "microsoft_entra" => config_file.entra.clone().or_else(|| flat_provider_file_config(&config_file)),
        "okta" => config_file.okta.clone().or_else(|| flat_provider_file_config(&config_file)),
        _ => None,
    };
    let Some(file) = file else {
        errors.push("ERR_AUTH_CONFIG_MISSING".to_string());
        return ProviderConfigReadiness { configured: false, errors };
    };
    let issuer = file.issuer.clone().unwrap_or_default();
    let client_id = file.client_id.clone().unwrap_or_default();
    let redirect_uri = file.redirect_uri.clone().unwrap_or_default();
    let scopes = file.scopes.clone().unwrap_or_default();
    let audience = file.audience.clone().unwrap_or_default();
    let tenant_id = file.tenant_id.clone().unwrap_or_default();
    if !valid_https_url(&issuer) {
        errors.push("ERR_AUTH_ISSUER_INVALID".to_string());
    }
    if client_id.trim().is_empty() {
        errors.push("ERR_AUTH_CONFIG_INVALID:client_id".to_string());
    }
    if audience.trim().is_empty() {
        errors.push("ERR_AUTH_AUDIENCE_INVALID".to_string());
    }
    if !valid_loopback_redirect(&redirect_uri) {
        errors.push("ERR_AUTH_REDIRECT_INVALID".to_string());
    }
    if scopes.is_empty() || !scopes.iter().all(|scope| !scope.trim().is_empty()) || !scopes.iter().any(|scope| scope == "openid") {
        errors.push("ERR_AUTH_CONFIG_INVALID:scopes".to_string());
    }
    if provider == "microsoft_entra" && tenant_id.trim().is_empty() {
        errors.push("ERR_AUTH_CONFIG_INVALID:tenant_id".to_string());
    }
    if provider == "microsoft_entra" && !tenant_id.trim().is_empty() && !valid_guid(&tenant_id) {
        errors.push("ERR_AUTH_CONFIG_INVALID:tenant_id_format".to_string());
    }
    if provider == "microsoft_entra" && !tenant_id.trim().is_empty() && !issuer.trim_end_matches('/').ends_with(&format!("/{tenant_id}/v2.0")) {
        errors.push("ERR_AUTH_ISSUER_INVALID:tenant_mismatch".to_string());
    }
    if let Some(map) = file.group_role_map {
        if !map.values().all(|role| matches!(role.as_str(), "ADMIN" | "OPERATOR" | "AUDITOR" | "VIEWER")) {
            errors.push("ERR_AUTH_CONFIG_INVALID:group_role_map".to_string());
        }
    }
    ProviderConfigReadiness {
        configured: errors.is_empty(),
        errors,
    }
}

fn provider_file_config(provider: &str) -> Result<AuthProviderFileConfig, String> {
    let parsed = load_auth_config_file()?;
    let active = normalize_provider(&parsed.provider).ok_or_else(|| "ERR_AUTH_PROVIDER_UNSUPPORTED".to_string())?;
    if active != provider {
        return Err("ERR_AUTH_PROVIDER_UNSUPPORTED".to_string());
    }
    let file = if provider == "microsoft_entra" {
        parsed.entra.clone().or_else(|| flat_provider_file_config(&parsed))
    } else {
        parsed.okta.clone().or_else(|| flat_provider_file_config(&parsed))
    };
    file.ok_or_else(|| "ERR_AUTH_CONFIG_MISSING".to_string())
}

fn flat_provider_file_config(parsed: &AuthConfigFile) -> Option<AuthProviderFileConfig> {
    if parsed.issuer.is_none()
        && parsed.client_id.is_none()
        && parsed.redirect_uri.is_none()
        && parsed.scopes.is_none()
        && parsed.audience.is_none()
        && parsed.tenant_id.is_none()
        && parsed.group_role_map.is_none()
    {
        return None;
    }
    Some(AuthProviderFileConfig {
        issuer: parsed.issuer.clone(),
        client_id: parsed.client_id.clone(),
        redirect_uri: parsed.redirect_uri.clone(),
        scopes: parsed.scopes.clone(),
        audience: parsed.audience.clone(),
        tenant_id: parsed.tenant_id.clone(),
        group_role_map: parsed.group_role_map.clone(),
    })
}

fn load_auth_config_file() -> Result<AuthConfigFile, String> {
    let path = auth_config_local_path()?;
    let raw = read_to_string(path).map_err(|_| "ERR_AUTH_CONFIG_MISSING".to_string())?;
    serde_json::from_str::<AuthConfigFile>(&raw).map_err(|_| "ERR_AUTH_CONFIG_INVALID".to_string())
}

impl RbacPolicy {
    fn new(tenant_id: String) -> Self {
        Self {
            schema_version: "mnde.rbac_policy.v1".to_string(),
            tenant_id,
            assignments: Vec::new(),
        }
    }

    fn can_bootstrap(&self) -> bool {
        self.assignments.iter().all(|assignment| assignment.role != "ADMIN")
    }

    fn validate(&self) -> Result<(), String> {
        if self.schema_version != "mnde.rbac_policy.v1" || self.tenant_id.trim().is_empty() {
            return Err("ERR_RBAC_POLICY_INVALID".to_string());
        }
        for assignment in &self.assignments {
            if !matches!(assignment.role.as_str(), "ADMIN" | "OPERATOR" | "AUDITOR" | "VIEWER") {
                return Err("ERR_RBAC_ROLE_INVALID".to_string());
            }
            if assignment.user_id.as_deref().unwrap_or("").trim().is_empty() && assignment.email.as_deref().unwrap_or("").trim().is_empty() {
                return Err("ERR_RBAC_SUBJECT_REQUIRED".to_string());
            }
        }
        Ok(())
    }

    fn resolve_role(&self, tenant_id: &str, user_id: &str, email: &str) -> Option<String> {
        if self.validate().is_err() || self.tenant_id != tenant_id {
            return None;
        }
        let normalized_email = email.trim().to_lowercase();
        self.assignments
            .iter()
            .find(|assignment| {
                assignment.user_id.as_deref() == Some(user_id)
                    || assignment.email.as_deref().map(str::to_lowercase).as_deref() == Some(normalized_email.as_str())
            })
            .map(|assignment| assignment.role.clone())
    }

    fn upsert(&mut self, assignment: RbacAssignment) -> Result<(), String> {
        let matches_subject = |existing: &RbacAssignment| {
            assignment.user_id.is_some() && existing.user_id == assignment.user_id
                || assignment.email.is_some() && existing.email.as_ref().map(|value| value.to_lowercase()) == assignment.email.as_ref().map(|value| value.to_lowercase())
        };
        if let Some(existing) = self.assignments.iter_mut().find(|existing| matches_subject(existing)) {
            *existing = assignment;
        } else {
            self.assignments.push(assignment);
        }
        self.validate()
    }
}

fn load_rbac_policy() -> Result<RbacPolicy, String> {
    let path = rbac_policy_path()?;
    let raw = read_to_string(path).map_err(|_| "ERR_RBAC_POLICY_MISSING".to_string())?;
    let policy = serde_json::from_str::<RbacPolicy>(&raw).map_err(|_| "ERR_RBAC_POLICY_INVALID".to_string())?;
    policy.validate()?;
    Ok(policy)
}

fn save_rbac_policy(policy: &RbacPolicy) -> Result<(), String> {
    policy.validate()?;
    let path = rbac_policy_path()?;
    let raw = serde_json::to_string_pretty(policy).map_err(|error| format!("Failed to serialize RBAC policy: {error}"))?;
    write(path, raw).map_err(|error| format!("Failed to persist RBAC policy: {error}"))
}

fn rbac_policy_path() -> Result<PathBuf, String> {
    let cwd = std::env::current_dir().map_err(|error| format!("Failed to resolve current directory: {error}"))?;
    if cwd.join("auth-config.local.json").exists() {
        return Ok(cwd.join("rbac-policy.local.json"));
    }
    if let Some(parent) = cwd.parent() {
        if parent.join("auth-config.local.json").exists() {
            return Ok(parent.join("rbac-policy.local.json"));
        }
    }
    let exe = std::env::current_exe().map_err(|error| format!("Failed to resolve current executable: {error}"))?;
    Ok(exe.parent().ok_or_else(|| "Failed to resolve executable directory.".to_string())?.join("rbac-policy.local.json"))
}

fn required_config_value(file_value: Option<String>, field: &str) -> Result<String, String> {
    file_value
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("ERR_AUTH_CONFIG_INVALID:{field}"))
}

fn normalize_provider(value: &str) -> Option<String> {
    match value {
        "entra" | "microsoft_entra" => Some("microsoft_entra".to_string()),
        "okta" => Some("okta".to_string()),
        _ => None,
    }
}

fn valid_https_url(value: &str) -> bool {
    Url::parse(value).map(|url| url.scheme() == "https").unwrap_or(false)
}

fn valid_loopback_redirect(value: &str) -> bool {
    Url::parse(value)
        .map(|url| url.scheme() == "http" && url.host_str() == Some("localhost") && url.port() == Some(8788) && url.path() == "/callback")
        .unwrap_or(false)
}

fn valid_guid(value: &str) -> bool {
    let parts: Vec<&str> = value.split('-').collect();
    parts.len() == 5
        && [8, 4, 4, 4, 12].iter().zip(parts.iter()).all(|(len, part)| part.len() == *len && part.chars().all(|ch| ch.is_ascii_hexdigit()))
}

fn auth_config_local_path() -> Result<PathBuf, String> {
    let cwd = std::env::current_dir().map_err(|error| format!("Failed to resolve current directory: {error}"))?;
    let local = cwd.join("auth-config.local.json");
    if local.exists() {
        return Ok(local);
    }
    let parent = cwd
        .parent()
        .map(|path| path.join("auth-config.local.json"))
        .filter(|path| path.exists());
    parent.ok_or_else(|| "ERR_AUTH_CONFIG_MISSING".to_string())
}

fn auth_audit_file_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|error| format!("Failed to resolve current executable: {error}"))?;
    Ok(exe
        .parent()
        .ok_or_else(|| "Failed to resolve executable directory.".to_string())?
        .join("auth-audit")
        .join("auth-events.jsonl"))
}

fn read_auth_session() -> Option<AuthSession> {
    let raw = read_to_string(auth_session_path().ok()?).ok()?;
    serde_json::from_str::<AuthSession>(&raw).ok()
}

fn write_auth_session(session: &AuthSession) -> Result<(), String> {
    let path = auth_session_path()?;
    let raw = serde_json::to_string_pretty(session).map_err(|error| format!("Failed to serialize auth session: {error}"))?;
    write(path, raw).map_err(|error| format!("Failed to persist auth session: {error}"))
}

fn clear_auth_session() {
    if let Ok(path) = auth_session_path() {
        let _ = remove_file(path);
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_millis(0))
        .as_millis() as u64
}

fn validate_session(session: &AuthSession) -> Result<(), String> {
    if session.user_id.trim().is_empty()
        || session.display_name.trim().is_empty()
        || session.email.trim().is_empty()
        || session.tenant_id.trim().is_empty()
        || session.provider.trim().is_empty()
        || session.role.trim().is_empty()
    {
        return Err("auth session is missing required claims".to_string());
    }
    if !matches!(session.role.as_str(), "ADMIN" | "OPERATOR" | "AUDITOR" | "VIEWER") {
        return Err("auth session role is invalid".to_string());
    }
    if let Some(expiry) = session.session_expiry_ms {
        if expiry <= now_millis() {
            clear_auth_session();
            return Err("auth session expired".to_string());
        }
    }
    Ok(())
}

fn session_expires_soon(session: &AuthSession, window_ms: u64) -> bool {
    session
        .session_expiry_ms
        .map(|expiry| expiry <= now_millis().saturating_add(window_ms))
        .unwrap_or(true)
}

fn current_valid_session() -> Result<AuthSession, String> {
    let session = read_auth_session().ok_or_else(|| "enterprise authentication required".to_string())?;
    validate_session(&session)?;
    reconcile_stored_session_role(session)
}

fn require_enterprise_session() -> Result<AuthSession, String> {
    let session = current_valid_session()?;
    if session.provider != "microsoft_entra" && session.provider != "okta" {
        return Err("enterprise OIDC identity required for Live Mode authority".to_string());
    }
    Ok(session)
}

fn role_has_capability(role: &str, capability: &str) -> bool {
    match role {
        "ADMIN" => matches!(capability, "activate_policy" | "manage_runtime" | "export_audit" | "manage_integrations" | "manage_users" | "view_runtime" | "replay_decisions" | "inspect_receipts" | "verify_receipts" | "view_dashboard"),
        "OPERATOR" => matches!(capability, "view_runtime" | "replay_decisions" | "inspect_receipts" | "verify_receipts" | "view_dashboard"),
        "AUDITOR" => matches!(capability, "inspect_receipts" | "verify_receipts" | "replay_decisions" | "export_audit" | "view_dashboard"),
        "VIEWER" => capability == "view_dashboard",
        _ => false,
    }
}

fn require_capability(capability: &str) -> Result<AuthSession, String> {
    let session = require_enterprise_session()?;
    if !role_has_capability(&session.role, capability) {
        append_auth_audit(&session, capability, "desktop-ipc", "REFUSE", None)?;
        return Err(format!("authorization refused: {capability} requires a higher role"));
    }
    Ok(session)
}

fn authority_context_header() -> Result<String, String> {
    let Ok(session) = current_valid_session() else {
        return Ok(String::new());
    };
    let raw = serde_json::to_string(&session).map_err(|error| format!("Failed to serialize authority context: {error}"))?;
    Ok(format!("X-MNDE-Authority-Context: {raw}\r\n"))
}

fn append_auth_audit(session: &AuthSession, action: &str, target: &str, result: &str, decision_hash: Option<&str>) -> Result<(), String> {
    let path = auth_audit_file_path()?;
    if let Some(parent) = path.parent() {
        create_dir_all(parent).map_err(|error| format!("Failed to create auth audit directory: {error}"))?;
    }
    let record = serde_json::json!({
        "timestamp": now_millis().to_string(),
        "user_id": &session.user_id,
        "display_name": &session.display_name,
        "role": &session.role,
        "tenant_id": &session.tenant_id,
        "provider": &session.provider,
        "action": action,
        "target": target,
        "result": result,
        "decision_hash": decision_hash
    });
    let mut raw = serde_json::to_string(&record).map_err(|error| format!("Failed to serialize auth audit event: {error}"))?;
    raw.push('\n');
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut file| file.write_all(raw.as_bytes()))
        .map_err(|error| format!("Failed to append auth audit event: {error}"))
}

fn parse_local_http_endpoint(endpoint: &str) -> Result<(String, u16), String> {
    let rest = endpoint
        .strip_prefix("http://")
        .ok_or_else(|| "MNDe sidecar endpoint must use http://.".to_string())?;
    let authority = rest.split('/').next().unwrap_or(rest);
    let (host, port_text) = authority
        .rsplit_once(':')
        .ok_or_else(|| "MNDe sidecar endpoint must include a port.".to_string())?;
    let port = port_text
        .parse::<u16>()
        .map_err(|error| format!("Invalid MNDe sidecar port: {error}"))?;
    Ok((host.to_string(), port))
}

fn parse_http_response(response: &[u8]) -> Result<SidecarHttpResponse, String> {
    let text = String::from_utf8_lossy(response);
    let (head, body) = text
        .split_once("\r\n\r\n")
        .ok_or_else(|| "Invalid MNDe sidecar HTTP response.".to_string())?;
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or_else(|| "MNDe sidecar response missing status.".to_string())?
        .parse::<u16>()
        .map_err(|error| format!("Invalid MNDe sidecar response status: {error}"))?;
    Ok(SidecarHttpResponse {
        status,
        body: body.to_string(),
    })
}

fn find_sidecar_launcher() -> Option<SidecarLauncher> {
    candidate_sidecar_launchers()
        .into_iter()
        .find(|candidate| candidate.display_path.is_file())
}

fn candidate_sidecar_launchers() -> Vec<SidecarLauncher> {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf);

    let Some(workspace) = workspace else {
        return Vec::new();
    };

    let local_sidecar_root = workspace.clone();
    let local_sidecar = local_sidecar_root.join("mnde-local-sidecar.mjs");
    let release_script = workspace.join("mnde-gpu-demo").join("release-extract-temp").join("mnde-release-package").join("bin").join("mnde-sidecar-background.cmd");
    let bundled_script = workspace.join("mnde-gpu-demo").join("mnde").join("bin").join("bin").join("mnde-sidecar-background.cmd");

    vec![
        SidecarLauncher {
            program: "node".to_string(),
            args: vec![
                "--experimental-strip-types".to_string(),
                local_sidecar.display().to_string(),
            ],
            working_dir: local_sidecar_root,
            display_path: local_sidecar,
        },
        command_script_launcher(release_script),
        command_script_launcher(bundled_script),
    ]
}

fn command_script_launcher(script: PathBuf) -> SidecarLauncher {
    let working_dir = script
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));

    SidecarLauncher {
        program: "cmd.exe".to_string(),
        args: vec!["/C".to_string(), script.display().to_string()],
        working_dir,
        display_path: script,
    }
}

fn sidecar_port_is_open() -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], 8787));
    TcpStream::connect_timeout(&address, Duration::from_millis(250)).is_ok()
}

fn pid_file_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|error| format!("Failed to resolve current executable: {error}"))?;
    Ok(exe
        .parent()
        .ok_or_else(|| "Failed to resolve executable directory.".to_string())?
        .join("mnde-sidecar-owned-pid.json"))
}

fn read_owned_pid() -> Option<OwnedSidecarPid> {
    let path = pid_file_path().ok()?;
    let raw = read_to_string(path).ok()?;
    serde_json::from_str::<OwnedSidecarPid>(&raw).ok()
}

fn write_owned_pid(record: &OwnedSidecarPid) -> Result<(), String> {
    let path = pid_file_path()?;
    let raw = serde_json::to_string_pretty(record).map_err(|error| format!("Failed to serialize sidecar PID file: {error}"))?;
    write(path, raw).map_err(|error| format!("Failed to write sidecar PID file: {error}"))
}

fn clear_owned_pid() {
    if let Ok(path) = pid_file_path() {
        let _ = remove_file(path);
    }
}

fn process_executable_path(pid: u32) -> Option<String> {
    #[cfg(windows)]
    {
        let output = Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!("(Get-Process -Id {pid} -ErrorAction SilentlyContinue).Path"),
            ])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if text.is_empty() { None } else { Some(text) }
    }
    #[cfg(not(windows))]
    {
        std::fs::read_link(format!("/proc/{pid}/exe"))
            .ok()
            .map(|path| path.display().to_string())
    }
}

fn pid_is_running(pid: u32) -> bool {
    process_executable_path(pid).is_some()
}

fn sidecar_status_inner() -> LifecycleResult {
    let Some(record) = read_owned_pid() else {
        return LifecycleResult {
            status: if sidecar_port_is_open() { "running".to_string() } else { "stopped".to_string() },
            pid: None,
            owned: false,
            message: if sidecar_port_is_open() { "external sidecar detected".to_string() } else { "sidecar is stopped".to_string() },
            executable_path: None,
        };
    };

    let Some(actual_path) = process_executable_path(record.pid) else {
        clear_owned_pid();
        return LifecycleResult {
            status: "stale_pid".to_string(),
            pid: Some(record.pid),
            owned: false,
            message: "owned PID file was stale and has been removed".to_string(),
            executable_path: None,
        };
    };

    if !paths_match(&actual_path, &record.executable_path) {
        return LifecycleResult {
            status: "error".to_string(),
            pid: Some(record.pid),
            owned: false,
            message: "PID ownership unclear: executable identity mismatch".to_string(),
            executable_path: Some(actual_path),
        };
    }

    LifecycleResult {
        status: "running".to_string(),
        pid: Some(record.pid),
        owned: true,
        message: "owned sidecar is running".to_string(),
        executable_path: Some(actual_path),
    }
}

fn stop_mnde_sidecar_inner() -> Result<LifecycleResult, String> {
    let Some(record) = read_owned_pid() else {
        return Ok(LifecycleResult {
            status: "stopped".to_string(),
            pid: None,
            owned: false,
            message: "no owned sidecar process to stop".to_string(),
            executable_path: None,
        });
    };

    let Some(actual_path) = process_executable_path(record.pid) else {
        clear_owned_pid();
        return Ok(LifecycleResult {
            status: "stale_pid".to_string(),
            pid: Some(record.pid),
            owned: false,
            message: "owned sidecar was already stopped; stale PID file removed".to_string(),
            executable_path: None,
        });
    };
    if !paths_match(&actual_path, &record.executable_path) {
        return Ok(LifecycleResult {
            status: "error".to_string(),
            pid: Some(record.pid),
            owned: false,
            message: "refusing to stop process: executable identity mismatch".to_string(),
            executable_path: Some(actual_path),
        });
    }

    #[cfg(windows)]
    let stop_status = Command::new("powershell")
        .args(["-NoProfile", "-Command", &format!("Stop-Process -Id {} -ErrorAction Stop", record.pid)])
        .status()
        .map_err(|error| format!("Failed to stop sidecar: {error}"))?;
    #[cfg(not(windows))]
    let stop_status = Command::new("kill")
        .arg(record.pid.to_string())
        .status()
        .map_err(|error| format!("Failed to stop sidecar: {error}"))?;

    if !stop_status.success() {
        return Ok(LifecycleResult {
            status: "error".to_string(),
            pid: Some(record.pid),
            owned: true,
            message: "stop command failed".to_string(),
            executable_path: Some(actual_path),
        });
    }

    for _ in 0..50 {
        if !pid_is_running(record.pid) {
            clear_owned_pid();
            return Ok(LifecycleResult {
                status: "stopped".to_string(),
                pid: Some(record.pid),
                owned: true,
                message: "owned sidecar stopped".to_string(),
                executable_path: Some(actual_path),
            });
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    Ok(LifecycleResult {
        status: "error".to_string(),
        pid: Some(record.pid),
        owned: true,
        message: "timed out waiting for owned sidecar to stop".to_string(),
        executable_path: Some(actual_path),
    })
}

fn paths_match(left: &str, right: &str) -> bool {
    left.eq_ignore_ascii_case(right)
}

fn validate_audit_bundle_path(input: &str) -> Result<PathBuf, String> {
    if input.contains("..") {
        return Err("Audit bundle path traversal is not allowed.".to_string());
    }
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| "Failed to resolve workspace root.".to_string())?;
    let audit_root = canonicalize(workspace.join("audit-bundles"))
        .map_err(|_| "Audit bundle root does not exist.".to_string())?;
    let target = canonicalize(input).map_err(|_| "Audit bundle folder does not exist.".to_string())?;
    if !target.starts_with(&audit_root) {
        return Err("Path is outside the generated audit bundle directory.".to_string());
    }
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Audit bundle folder name is invalid.".to_string())?;
    if !name.starts_with("audit-bundle-") {
        return Err("Only generated audit bundle directories can be opened.".to_string());
    }
    Ok(target)
}

fn main() {
    if let Err(error) = validate_startup_auth_config() {
        eprintln!("MNDe auth config is not ready; protected actions remain fail-closed: {error}");
    }
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            start_mnde_sidecar,
            stop_mnde_sidecar,
            restart_mnde_sidecar,
            sidecar_status,
            sidecar_request,
            export_receipt_json,
            open_audit_bundle_folder,
            auth_bootstrap,
            auth_config_status,
            rbac_status,
            rbac_bootstrap_admin,
            rbac_upsert_assignment,
            begin_oidc_login,
            auth_logout,
            record_auth_audit
        ])
        .run(tauri::generate_context!())
        .expect("failed to run MNDe sidecar UI");
}

fn validate_startup_auth_config() -> Result<(), String> {
    let Ok(file) = load_auth_config_file() else {
        return Ok(());
    };
    let provider = normalize_provider(&file.provider).ok_or_else(|| "ERR_AUTH_PROVIDER_UNSUPPORTED".to_string())?;
    let _readiness = validate_provider_config(&provider);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_local_http_endpoints() {
        assert_eq!(parse_local_http_endpoint("http://127.0.0.1:8787").unwrap(), ("127.0.0.1".to_string(), 8787));
        assert!(parse_local_http_endpoint("https://127.0.0.1:8787").is_err());
        assert!(parse_local_http_endpoint("http://127.0.0.1").is_err());
    }

    #[test]
    fn path_identity_compare_is_case_insensitive_for_windows() {
        assert!(paths_match("C:\\Program Files\\nodejs\\node.exe", "c:\\program files\\nodejs\\NODE.exe"));
        assert!(!paths_match("C:\\Program Files\\nodejs\\node.exe", "C:\\Windows\\System32\\cmd.exe"));
    }

    #[test]
    fn audit_bundle_validation_rejects_traversal() {
        assert!(validate_audit_bundle_path("..\\secret").is_err());
        assert!(validate_audit_bundle_path("C:\\tmp\\..\\secret").is_err());
    }

    #[test]
    fn rbac_roles_enforce_authority_capabilities() {
        assert!(role_has_capability("ADMIN", "activate_policy"));
        assert!(!role_has_capability("OPERATOR", "activate_policy"));
        assert!(role_has_capability("AUDITOR", "export_audit"));
        assert!(!role_has_capability("VIEWER", "verify_receipts"));
    }

    #[test]
    fn invalid_session_claims_fail_closed() {
        let session = AuthSession {
            user_id: "".to_string(),
            display_name: "Missing User".to_string(),
            email: "missing@mnde.invalid".to_string(),
            tenant_id: "tenant".to_string(),
            provider: "microsoft_entra".to_string(),
            role: "ADMIN".to_string(),
            login_time: "0".to_string(),
            session_expiry: "9999999999999".to_string(),
            session_expiry_ms: Some(9_999_999_999_999),
        };
        assert!(validate_session(&session).is_err());
    }

    #[test]
    fn oidc_provider_config_fails_closed_for_unsupported_provider() {
        let readiness = validate_provider_config("github");
        assert!(!readiness.configured);
        assert!(!readiness.errors.is_empty());
    }

    #[test]
    fn missing_auth_config_is_nonfatal_at_desktop_startup() {
        let outcome = validate_startup_auth_config();
        assert!(outcome.is_ok());
    }

    #[test]
    fn oidc_callback_validates_state_and_code() {
        let parsed = parse_oidc_callback_url("http://localhost:8788/callback?code=abc123&state=expected", "expected").unwrap();
        assert_eq!(parsed.code, "abc123");
        assert_eq!(parsed.state, "expected");
        assert!(parse_oidc_callback_url("http://localhost:8788/callback?code=abc123&state=wrong", "expected").is_err());
        assert!(parse_oidc_callback_url("http://localhost:8788/callback?state=expected", "expected").is_err());
    }

    #[test]
    fn production_callback_assumptions_are_strict() {
        assert!(valid_loopback_redirect("http://localhost:8788/callback"));
        assert!(!valid_loopback_redirect("http://127.0.0.1:8788/callback"));
        assert!(!valid_loopback_redirect("http://localhost:49152/callback"));
        assert!(!valid_loopback_redirect("http://localhost:8788/oidc/callback"));
        assert!(!valid_loopback_redirect("http://localhost:8788/*"));
    }

    #[test]
    fn secure_storage_probe_returns_deterministic_boolean() {
        let first = secure_token_storage_available();
        let second = secure_token_storage_available();
        assert_eq!(first, second);
    }

    #[test]
    fn form_encoding_escapes_oauth_values() {
        assert_eq!(form_encode(&[("scope", "openid profile"), ("redirect_uri", "http://127.0.0.1:49152/cb")]), "scope=openid%20profile&redirect_uri=http%3A%2F%2F127.0.0.1%3A49152%2Fcb");
    }

    #[cfg(windows)]
    #[test]
    fn browser_launcher_uses_url_protocol_handler() {
        let (program, args) = windows_browser_launcher_command("https://login.microsoftonline.com/example");
        assert_eq!(program, "rundll32.exe");
        assert_eq!(args, ["url.dll,FileProtocolHandler", "https://login.microsoftonline.com/example"]);
    }

    #[test]
    fn session_expiry_window_triggers_refresh_before_expiry() {
        let session = AuthSession {
            user_id: "u".to_string(),
            display_name: "User".to_string(),
            email: "u@mnde.invalid".to_string(),
            tenant_id: "tenant".to_string(),
            provider: "microsoft_entra".to_string(),
            role: "VIEWER".to_string(),
            login_time: "0".to_string(),
            session_expiry: "soon".to_string(),
            session_expiry_ms: Some(now_millis() + 60_000),
        };
        assert!(session_expires_soon(&session, 5 * 60 * 1000));
    }

    #[test]
    fn rbac_policy_bootstrap_and_assignment_resolution() {
        let empty = RbacPolicy::new("tenant-1".to_string());
        assert!(empty.can_bootstrap());

        let admin = RbacAssignment {
            user_id: Some("admin-subject".to_string()),
            email: Some("admin@mnde.invalid".to_string()),
            display_name: "Admin User".to_string(),
            role: "ADMIN".to_string(),
            assigned_by: "bootstrap".to_string(),
            assigned_at: "1".to_string(),
        };
        let operator = RbacAssignment {
            user_id: None,
            email: Some("operator@mnde.invalid".to_string()),
            display_name: "Operator User".to_string(),
            role: "OPERATOR".to_string(),
            assigned_by: "admin-subject".to_string(),
            assigned_at: "2".to_string(),
        };
        let policy = RbacPolicy {
            schema_version: "mnde.rbac_policy.v1".to_string(),
            tenant_id: "tenant-1".to_string(),
            assignments: vec![admin, operator],
        };

        assert!(!policy.can_bootstrap());
        assert_eq!(policy.resolve_role("tenant-1", "admin-subject", "admin@mnde.invalid"), Some("ADMIN".to_string()));
        assert_eq!(policy.resolve_role("tenant-1", "unknown", "operator@mnde.invalid"), Some("OPERATOR".to_string()));
        assert_eq!(policy.resolve_role("other-tenant", "admin-subject", "admin@mnde.invalid"), None);
    }

    #[test]
    fn rbac_policy_rejects_invalid_roles() {
        let policy = RbacPolicy {
            schema_version: "mnde.rbac_policy.v1".to_string(),
            tenant_id: "tenant-1".to_string(),
            assignments: vec![RbacAssignment {
                user_id: Some("u".to_string()),
                email: Some("u@mnde.invalid".to_string()),
                display_name: "User".to_string(),
                role: "OWNER".to_string(),
                assigned_by: "bootstrap".to_string(),
                assigned_at: "1".to_string(),
            }],
        };
        assert!(policy.validate().is_err());
        assert_eq!(policy.resolve_role("tenant-1", "u", "u@mnde.invalid"), None);
    }

    #[test]
    fn stale_privileged_session_downgrades_without_explicit_policy_assignment() {
        let mut session = AuthSession {
            user_id: "new-subject".to_string(),
            display_name: "New User".to_string(),
            email: "new@mnde.invalid".to_string(),
            tenant_id: "tenant-1".to_string(),
            provider: "microsoft_entra".to_string(),
            role: "ADMIN".to_string(),
            login_time: "0".to_string(),
            session_expiry: "later".to_string(),
            session_expiry_ms: Some(now_millis() + 60_000),
        };
        reconcile_session_role_with_policy(&mut session, None);
        assert_eq!(session.role, "VIEWER");
    }

    #[test]
    fn explicit_policy_assignment_preserves_privileged_session_role() {
        let mut session = AuthSession {
            user_id: "admin-subject".to_string(),
            display_name: "Admin User".to_string(),
            email: "admin@mnde.invalid".to_string(),
            tenant_id: "tenant-1".to_string(),
            provider: "microsoft_entra".to_string(),
            role: "VIEWER".to_string(),
            login_time: "0".to_string(),
            session_expiry: "later".to_string(),
            session_expiry_ms: Some(now_millis() + 60_000),
        };
        let policy = RbacPolicy {
            schema_version: "mnde.rbac_policy.v1".to_string(),
            tenant_id: "tenant-1".to_string(),
            assignments: vec![RbacAssignment {
                user_id: Some("admin-subject".to_string()),
                email: Some("admin@mnde.invalid".to_string()),
                display_name: "Admin User".to_string(),
                role: "ADMIN".to_string(),
                assigned_by: "bootstrap".to_string(),
                assigned_at: "1".to_string(),
            }],
        };
        reconcile_session_role_with_policy(&mut session, Some(&policy));
        assert_eq!(session.role, "ADMIN");
    }
}
