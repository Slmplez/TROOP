//! Native OAuth transport. Tokens never form part of a public status or model response.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use reqwest::{redirect::Policy, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    time::timeout,
};
use uuid::Uuid;
use zeroize::Zeroize;

#[derive(Clone, Serialize, Deserialize)]
pub struct Metadata {
    #[serde(default)]
    pub issuer_parameter_supported: bool,
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub revocation_endpoint: Option<String>,
    pub registration_endpoint: Option<String>,
    pub auth_methods: Vec<String>,
}
#[derive(Serialize, Deserialize)]
pub struct Grant {
    #[serde(default)]
    pub binding_id: String,
    pub resource: String,
    pub metadata: Metadata,
    pub client_id: String,
    pub client_secret: Option<String>,
    pub auth_method: String,
    pub scopes: Vec<String>,
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: Option<u64>,
}
impl Drop for Grant {
    fn drop(&mut self) {
        self.access_token.zeroize();
        if let Some(s) = &mut self.refresh_token {
            s.zeroize();
        }
        if let Some(s) = &mut self.client_secret {
            s.zeroize();
        }
    }
}
pub struct Options {
    pub resource: String,
    pub issuer: Option<String>,
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub scopes: Vec<String>,
    pub register: bool,
}
impl Drop for Options {
    fn drop(&mut self) {
        if let Some(s) = &mut self.client_secret {
            s.zeroize();
        }
    }
}
pub struct Flow {
    listener: TcpListener,
    redirect: String,
    state: String,
    verifier: String,
    grant: Grant,
}
impl Drop for Flow {
    fn drop(&mut self) {
        self.verifier.zeroize();
        self.state.zeroize();
    }
}
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "Cannot initialize OAuth HTTP client".into())
}
fn endpoint(input: &str, secure: bool) -> Result<Url, String> {
    let u = super::url(input)?;
    if u.query().is_some() || secure && u.scheme() != "https" {
        return Err("Unsafe OAuth endpoint".into());
    }
    Ok(u)
}
async fn document(mut r: reqwest::Response) -> Result<Value, String> {
    let mut b = vec![];
    while let Some(c) = r.chunk().await.map_err(|_| "OAuth response disconnected")? {
        if b.len() + c.len() > 65_536 {
            return Err("OAuth response exceeds limit".into());
        }
        b.extend_from_slice(&c);
    }
    let result = serde_json::from_slice(&b).map_err(|_| "Invalid OAuth JSON response".into());
    b.zeroize();
    result
}
fn wipe(v: &mut Value) {
    match v {
        Value::String(s) => s.zeroize(),
        Value::Array(a) => a.iter_mut().for_each(wipe),
        Value::Object(o) => o.values_mut().for_each(wipe),
        _ => {}
    }
}
async fn get(c: &reqwest::Client, u: Url) -> Result<reqwest::Response, String> {
    c.get(u)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|_| "OAuth discovery failed".into())
}
fn text(v: &Value, key: &str, max: usize) -> Result<String, String> {
    v[key]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= max && !s.chars().any(char::is_control))
        .map(str::to_owned)
        .ok_or("Invalid OAuth metadata field".into())
}
fn strings(v: &Value, key: &str) -> Result<Vec<String>, String> {
    match v.get(key) {
        None => Ok(vec![]),
        Some(Value::Array(a)) if a.len() <= 64 => a
            .iter()
            .map(|v| {
                v.as_str()
                    .filter(|s| s.len() <= 512 && !s.chars().any(char::is_control))
                    .map(str::to_owned)
                    .ok_or("Invalid OAuth metadata list".into())
            })
            .collect(),
        _ => Err("Invalid OAuth metadata list".into()),
    }
}
fn same_resource(a: &str, b: &str) -> bool {
    matches!((Url::parse(a),Url::parse(b)),(Ok(a),Ok(b)) if a==b)
}
fn challenge(headers: &reqwest::header::HeaderMap) -> Result<String, String> {
    let mut found = vec![];
    for h in headers.get_all("www-authenticate") {
        let h = h.to_str().map_err(|_| "Invalid OAuth challenge")?;
        let mut segments = vec![];
        let mut quoted = false;
        let mut escaped = false;
        let mut start = 0;
        for (index, b) in h.bytes().enumerate() {
            if escaped {
                escaped = false;
                continue;
            }
            if quoted && b == b'\\' {
                escaped = true;
                continue;
            }
            if b == b'"' {
                quoted = !quoted;
            }
            if b == b',' && !quoted {
                segments.push(&h[start..index]);
                start = index + 1;
            }
        }
        if quoted || escaped {
            return Err("Malformed OAuth challenge".into());
        }
        segments.push(&h[start..]);
        let mut bearer = false;
        for part in segments {
            let mut p = part.trim();
            if let Some((scheme, rest)) = p.split_once(char::is_whitespace) {
                if !scheme.contains('=') {
                    bearer = scheme.eq_ignore_ascii_case("bearer");
                    p = rest.trim();
                }
            }
            if !bearer {
                continue;
            }
            if let Some((key, value)) = p.split_once('=') {
                if key.trim().eq_ignore_ascii_case("resource_metadata") {
                    let value = value.trim();
                    if value.starts_with('"')
                        && value.ends_with('"')
                        && !value[1..value.len() - 1].contains(['"', '\\'])
                    {
                        found.push(value[1..value.len() - 1].to_owned());
                    }
                }
            }
        }
    }
    if found.len() == 1 {
        Ok(found.remove(0))
    } else {
        Err("Missing or ambiguous protected resource challenge".into())
    }
}
async fn discover(c: &reqwest::Client, o: &Options) -> Result<Metadata, String> {
    let resource = endpoint(&o.resource, false)?;
    let secure = resource.scheme() == "https";
    let mut u = resource.clone();
    u.set_path(&format!(
        "/.well-known/oauth-protected-resource{}",
        resource.path().trim_end_matches('/')
    ));
    let mut r = get(c, u).await?;
    if !r.status().is_success() {
        let challenge_response = get(c, resource.clone()).await?;
        if challenge_response.status() != 401 {
            return Err("MCP resource does not advertise OAuth metadata".into());
        }
        let metadata = endpoint(&challenge(challenge_response.headers())?, secure)?;
        if metadata.origin() != resource.origin() {
            return Err("Cross-origin protected resource metadata rejected".into());
        }
        r = get(c, metadata).await?;
    }
    if !r.status().is_success() {
        return Err("Protected resource metadata unavailable".into());
    }
    let protected = document(r).await?;
    if !same_resource(&text(&protected, "resource", 2048)?, &o.resource) {
        return Err("OAuth resource identity mismatch".into());
    }
    let servers = strings(&protected, "authorization_servers")?;
    let issuer = match &o.issuer {
        Some(i) if servers.iter().any(|s| same_resource(s, i)) => i.clone(),
        None if servers.len() == 1 => servers[0].clone(),
        _ => return Err("Select an advertised authorization server explicitly".into()),
    };
    let issuer_url = endpoint(&issuer, secure)?;
    let endpoint_secure = secure || issuer_url.scheme() == "https";
    let mut url = issuer_url.clone();
    url.set_path(&format!(
        "/.well-known/oauth-authorization-server{}",
        issuer_url.path().trim_end_matches('/')
    ));
    let mut response = get(c, url).await?;
    if matches!(response.status().as_u16(), 404 | 405) {
        let mut u = issuer_url.clone();
        u.set_path(&format!(
            "{}/.well-known/openid-configuration",
            issuer_url.path().trim_end_matches('/')
        ));
        response = get(c, u).await?;
    }
    if !response.status().is_success() {
        return Err("Authorization server metadata unavailable".into());
    }
    let v = document(response).await?;
    if !same_resource(&text(&v, "issuer", 2048)?, &issuer) {
        return Err("OAuth issuer identity mismatch".into());
    }
    if !strings(&v, "code_challenge_methods_supported")?
        .iter()
        .any(|s| s == "S256")
        || !strings(&v, "response_types_supported")?
            .iter()
            .any(|s| s == "code")
    {
        return Err("Authorization server must support code and PKCE S256".into());
    }
    let auth = text(&v, "authorization_endpoint", 2048)?;
    let token = text(&v, "token_endpoint", 2048)?;
    endpoint(&auth, endpoint_secure)?;
    endpoint(&token, endpoint_secure)?;
    let optional = |key: &str| -> Result<Option<String>, String> {
        if v.get(key).is_none() {
            return Ok(None);
        }
        let s = text(&v, key, 2048)?;
        endpoint(&s, endpoint_secure)?;
        Ok(Some(s))
    };
    let methods = if v.get("token_endpoint_auth_methods_supported").is_none() {
        vec!["client_secret_basic".into()]
    } else {
        strings(&v, "token_endpoint_auth_methods_supported")?
    };
    Ok(Metadata {
        issuer_parameter_supported: v["authorization_response_iss_parameter_supported"] == true,
        issuer,
        authorization_endpoint: auth,
        token_endpoint: token,
        revocation_endpoint: optional("revocation_endpoint")?,
        registration_endpoint: optional("registration_endpoint")?,
        auth_methods: methods,
    })
}
pub async fn begin(mut o: Options) -> Result<(Flow, String), String> {
    if o.scopes.len() > 32
        || o.scopes.iter().any(|s| {
            s.is_empty()
                || s.len() > 128
                || !s
                    .bytes()
                    .all(|b| b == 0x21 || (0x23..=0x5b).contains(&b) || (0x5d..=0x7e).contains(&b))
        })
    {
        return Err("Invalid OAuth scopes".into());
    }
    let c = client()?;
    let metadata = discover(&c, &o).await?;
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|_| "Cannot open OAuth loopback listener")?;
    let redirect = format!(
        "http://127.0.0.1:{}/oauth/callback",
        listener
            .local_addr()
            .map_err(|_| "OAuth listener unavailable")?
            .port()
    );
    let mut client_id = o.client_id.take().unwrap_or_default();
    let secret = o.client_secret.take();
    let auth_method = if o.register {
        if !client_id.is_empty() || secret.is_some() {
            return Err(
                "Registration and existing client credentials are mutually exclusive".into(),
            );
        }
        let url = metadata
            .registration_endpoint
            .as_ref()
            .ok_or("Authorization server does not support registration; supply your client ID")?;
        let r=c.post(url).json(&json!({"client_name":"TROOP","redirect_uris":[redirect],"grant_types":["authorization_code","refresh_token"],"response_types":["code"],"token_endpoint_auth_method":"none"})).send().await.map_err(|_|"OAuth registration outcome unknown; no automatic retry")?;
        if !r.status().is_success() {
            return Err("OAuth client registration rejected".into());
        }
        let mut v = document(r).await?;
        let parsed = (|| {
            let id = text(&v, "client_id", 512)?;
            if v.get("client_secret").is_some()
                || v.get("token_endpoint_auth_method")
                    .is_some_and(|m| m != "none")
            {
                return Err("Registration requires a public PKCE client".into());
            }
            if v.get("redirect_uris").is_some()
                && !strings(&v, "redirect_uris")?.contains(&redirect)
            {
                return Err("Registered redirect identity mismatch".into());
            }
            Ok::<_, String>(id)
        })();
        wipe(&mut v);
        client_id = parsed?;
        "none".into()
    } else if secret.is_some() {
        if metadata
            .auth_methods
            .contains(&"client_secret_basic".into())
        {
            "client_secret_basic".into()
        } else if metadata.auth_methods.contains(&"client_secret_post".into()) {
            "client_secret_post".into()
        } else {
            return Err("Unsupported OAuth client authentication method".into());
        }
    } else {
        "none".into()
    };
    if client_id.is_empty()
        || client_id.len() > 512
        || client_id.chars().any(char::is_control)
        || !metadata.auth_methods.contains(&auth_method)
    {
        return Err("Invalid OAuth client ID or authentication method".into());
    }
    if secret
        .as_ref()
        .is_some_and(|s| s.len() > 2500 || s.contains('\0'))
    {
        return Err("Invalid OAuth client secret".into());
    }
    let verifier = format!(
        "{}{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    );
    let state = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let mut authorization = Url::parse(&metadata.authorization_endpoint)
        .map_err(|_| "Invalid authorization endpoint")?;
    authorization.query_pairs_mut().extend_pairs([
        ("response_type", "code"),
        ("client_id", &client_id),
        ("redirect_uri", &redirect),
        ("state", &state),
        (
            "code_challenge",
            &URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())),
        ),
        ("code_challenge_method", "S256"),
        ("resource", &o.resource),
        ("scope", &o.scopes.join(" ")),
    ]);
    let flow = Flow {
        listener,
        redirect,
        state,
        verifier,
        grant: Grant {
            binding_id: Uuid::new_v4().to_string(),
            resource: o.resource.clone(),
            metadata,
            client_id,
            client_secret: secret,
            auth_method,
            scopes: o.scopes.clone(),
            access_token: String::new(),
            refresh_token: None,
            expires_at: None,
        },
    };
    Ok((flow, authorization.into()))
}
impl Flow {
    pub async fn finish(mut self) -> Result<Grant, String> {
        let code=timeout(Duration::from_secs(300),async{
            for _ in 0..64 {
                let(mut socket,peer)=self.listener.accept().await.map_err(|_|"OAuth callback listener failed")?;
                if !peer.ip().is_loopback(){continue;}
                let request=timeout(Duration::from_secs(2),async{let mut bytes=vec![];loop{let mut b=[0u8;512];let n=socket.read(&mut b).await.map_err(|_|"OAuth callback disconnected")?;if n==0||bytes.len()+n>8192{return Err("Invalid OAuth callback request");}bytes.extend_from_slice(&b[..n]);if bytes.windows(4).any(|w|w==b"\r\n\r\n"){break;}}String::from_utf8(bytes).map_err(|_|"Invalid OAuth callback encoding")}).await;
                let code=match request {
                    Ok(Ok(request))=>callback(&request,&self.redirect,&self.state,&self.grant.metadata.issuer,self.grant.metadata.issuer_parameter_supported),
                    _=>Err("Invalid OAuth callback request".into()),
                };
                let status=if code.is_ok(){"200 OK"}else{"400 Bad Request"};let body="Return to TROOP to check login status.";let response=format!("HTTP/1.1 {status}\r\nContent-Type: text/plain\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",body.len());
                let _=timeout(Duration::from_secs(1),socket.write_all(response.as_bytes())).await;
                match code{Ok(code)=>return Ok::<_,String>(code),Err(e)if e=="OAuth authorization denied or callback malformed"=>return Err(e),_=>{}}
            }
            Err("OAuth callback attempt budget exceeded".into())
        }).await.map_err(|_|"OAuth login timed out")??;
        let c = client()?;
        let form = vec![
            ("grant_type".into(), "authorization_code".into()),
            ("code".into(), code),
            ("redirect_uri".into(), self.redirect.clone()),
            ("code_verifier".into(), self.verifier.clone()),
        ];
        exchange(&c, &mut self.grant, form).await?;
        // Flow owns a Drop implementation: move the grant through replacement.
        let empty = Grant {
            binding_id: String::new(),
            resource: String::new(),
            metadata: self.grant.metadata.clone(),
            client_id: String::new(),
            client_secret: None,
            auth_method: String::new(),
            scopes: vec![],
            access_token: String::new(),
            refresh_token: None,
            expires_at: None,
        };
        Ok(std::mem::replace(&mut self.grant, empty))
    }
}
fn callback(
    request: &str,
    redirect: &str,
    state: &str,
    issuer: &str,
    required_issuer: bool,
) -> Result<String, String> {
    let mut lines = request.split("\r\n");
    let first = lines.next().ok_or("Missing OAuth request line")?;
    let parts = first.split_whitespace().collect::<Vec<_>>();
    if parts.len() != 3
        || parts[0] != "GET"
        || parts[2] != "HTTP/1.1"
        || !parts[1].starts_with("/oauth/callback?")
    {
        return Err("Invalid OAuth callback path/method".into());
    }
    let u = Url::parse(redirect).map_err(|_| "Invalid redirect")?;
    let expected = format!("127.0.0.1:{}", u.port().ok_or("Missing redirect port")?);
    let hosts = lines
        .filter_map(|s| s.split_once(':'))
        .filter(|(k, _)| k.eq_ignore_ascii_case("host"))
        .map(|(_, v)| v.trim())
        .collect::<Vec<_>>();
    if hosts != [expected.as_str()] {
        return Err("OAuth callback Host mismatch".into());
    }
    let url = u.join(parts[1]).map_err(|_| "Invalid OAuth callback URL")?;
    let pairs = url.query_pairs().collect::<Vec<_>>();
    let issuers = pairs.iter().filter(|(k, _)| k == "iss").collect::<Vec<_>>();
    if issuers.len() > 1
        || required_issuer && issuers.is_empty()
        || issuers
            .first()
            .is_some_and(|(_, s)| !same_resource(s, issuer))
    {
        return Err("OAuth callback issuer mismatch".into());
    }
    let states = pairs
        .iter()
        .filter(|(k, _)| k == "state")
        .collect::<Vec<_>>();
    if states.len() != 1 || states[0].1 != state {
        return Err("OAuth state mismatch".into());
    }
    let codes = pairs
        .iter()
        .filter(|(k, _)| k == "code")
        .collect::<Vec<_>>();
    if codes.len() != 1
        || pairs.iter().any(|(k, _)| k == "error")
        || codes[0].1.is_empty()
        || codes[0].1.len() > 4096
    {
        return Err("OAuth authorization denied or callback malformed".into());
    }
    Ok(codes[0].1.to_string())
}
fn authenticated(
    c: &reqwest::Client,
    g: &Grant,
    url: &str,
    mut form: Vec<(String, String)>,
) -> reqwest::RequestBuilder {
    let mut r = c.post(url);
    if g.auth_method == "client_secret_basic" {
        let encode = |s: &str| {
            form_urlencoded::Serializer::new(String::new())
                .append_pair("x", s)
                .finish()[2..]
                .to_owned()
        };
        r = r.basic_auth(encode(&g.client_id), g.client_secret.as_deref().map(encode));
    } else {
        form.push(("client_id".into(), g.client_id.clone()));
    }
    if g.auth_method == "client_secret_post" {
        if let Some(secret) = &g.client_secret {
            form.push(("client_secret".into(), secret.clone()));
        }
    }
    r.form(&form)
}
async fn exchange(
    c: &reqwest::Client,
    g: &mut Grant,
    mut form: Vec<(String, String)>,
) -> Result<(), String> {
    form.push(("resource".into(), g.resource.clone()));
    let r = authenticated(c, g, &g.metadata.token_endpoint, form)
        .send()
        .await
        .map_err(|_| "OAuth token exchange outcome unknown; not retried")?;
    if !r.status().is_success() {
        let status = r.status();
        let mut v = document(r).await.unwrap_or(Value::Null);
        let invalid = v["error"] == "invalid_grant";
        wipe(&mut v);
        return Err(if invalid {
            "OAuth grant invalid; reconnect required"
        } else if status.is_client_error() {
            "OAuth token request rejected"
        } else {
            "OAuth token exchange outcome unknown; not retried"
        }
        .into());
    }
    let mut v = document(r).await?;
    let parsed = (|| {
        if !v["token_type"]
            .as_str()
            .is_some_and(|s| s.eq_ignore_ascii_case("Bearer"))
        {
            return Err("Unsupported OAuth token type".into());
        }
        let access = text(&v, "access_token", 16_000)?;
        // Access tokens are opaque. Preserve provider punctuation without decoding
        // or normalizing, while excluding whitespace and non-ASCII header bytes.
        if !access.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
            return Err("Invalid OAuth bearer token encoding".into());
        }
        let refresh = if v.get("refresh_token").is_some() {
            Some(text(&v, "refresh_token", 16_000)?)
        } else {
            None
        };
        let expires = match v.get("expires_in") {
            None => None,
            Some(v) => Some(
                now()
                    + v.as_u64()
                        .filter(|v| *v <= 366 * 86400)
                        .ok_or("Invalid OAuth token expiration")?,
            ),
        };
        let scopes = if let Some(scope) = v.get("scope") {
            let s = scope
                .as_str()
                .ok_or("Invalid OAuth token scopes")?
                .split_whitespace()
                .map(str::to_owned)
                .collect::<Vec<_>>();
            if s.iter().any(|s| !g.scopes.contains(s)) {
                return Err("OAuth returned unrequested scopes".into());
            }
            s
        } else {
            g.scopes.clone()
        };
        Ok::<_, String>((access, refresh, expires, scopes))
    })();
    wipe(&mut v);
    let (access, refresh, expires, scopes) = parsed?;
    g.access_token.zeroize();
    g.access_token = access;
    if let Some(r) = refresh {
        if let Some(old) = &mut g.refresh_token {
            old.zeroize();
        }
        g.refresh_token = Some(r);
    }
    g.expires_at = expires;
    g.scopes = scopes;
    Ok(())
}
pub async fn refresh(mut grant: Grant) -> Result<Grant, String> {
    let token = grant
        .refresh_token
        .as_ref()
        .ok_or("OAuth grant has no refresh token; reconnect required")?
        .clone();
    let c = client()?;
    exchange(
        &c,
        &mut grant,
        vec![
            ("grant_type".into(), "refresh_token".into()),
            ("refresh_token".into(), token),
        ],
    )
    .await?;
    Ok(grant)
}
pub async fn revoke(grant: Grant) -> Result<bool, String> {
    let Some(url) = &grant.metadata.revocation_endpoint else {
        return Ok(false);
    };
    let c = client()?;
    // Attempt both, without retry: revoking refresh may or may not revoke access too.
    for (token, hint) in [
        (grant.refresh_token.as_ref(), "refresh_token"),
        (Some(&grant.access_token), "access_token"),
    ] {
        if let Some(token) = token {
            let r = authenticated(
                &c,
                &grant,
                url,
                vec![
                    ("token".into(), token.clone()),
                    ("token_type_hint".into(), hint.into()),
                ],
            )
            .send()
            .await
            .map_err(|_| "Remote OAuth revocation outcome unknown")?;
            if !r.status().is_success() {
                return Err("Remote OAuth revocation not confirmed".into());
            }
        }
    }
    Ok(true)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bearer_challenge_handles_case_multiple_schemes_and_quoted_commas() {
        let mut h = reqwest::header::HeaderMap::new();
        h.insert("www-authenticate",reqwest::header::HeaderValue::from_static("Basic realm=\"old\", bEaReR realm=\"a,b\", resource_metadata=\"https://example.com/meta,a\""));
        assert_eq!(challenge(&h).unwrap(), "https://example.com/meta,a");
        h.insert(
            "www-authenticate",
            reqwest::header::HeaderValue::from_static(
                "Basic resource_metadata=\"https://example.com/spoof\"",
            ),
        );
        assert!(challenge(&h).is_err());
    }
    #[test]
    fn callback_rejects_host_method_duplicates_and_issuer_mismatch() {
        let redirect = "http://127.0.0.1:1234/oauth/callback";
        let make = |path: &str, host: &str| format!("GET {path} HTTP/1.1\r\nHost: {host}\r\n\r\n");
        assert_eq!(
            callback(
                &make(
                    "/oauth/callback?state=s&code=c&iss=https%3A%2F%2Fissuer.example",
                    "127.0.0.1:1234"
                ),
                redirect,
                "s",
                "https://issuer.example",
                true
            )
            .unwrap(),
            "c"
        );
        for request in [
            make("/oauth/callback?state=s&state=s&code=c", "127.0.0.1:1234"),
            make("/oauth/callback?state=s&code=c", "evil.example"),
            make("/oauth/callback?state=s&code=c", "127.0.0.1:1234"),
        ] {
            assert!(callback(&request, redirect, "s", "https://issuer.example", true).is_err());
        }
    }
}
