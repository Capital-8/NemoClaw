// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Runs each case in `hcl/integration/cases` under `tofu test`. A case holds a
//! NemoClaw document, `nemoclaw.yaml`, and the HCL that configures fixtures and
//! asserts results. This runner, shared by every case:
//!
//! - starts the OpenShell gRPC fixture, a fake Docker engine, an inference
//!   upstream, and the control endpoint of the `fixture` provider
//!   (`nemoclaw-fixture-control`);
//! - compiles the document with the SDK, its gateway, any engine, and
//!   inference endpoints redirected to the fixtures, beside the case's own
//!   files; an external gateway's credential and TLS are dropped, and image
//!   metadata variables name the fixture image's metadata bundle;
//! - runs the bundle's OpenTofu and providers with isolated state and only
//!   fixture credentials;
//! - checks what OpenTofu's automatic teardown leaves, which no run block can
//!   observe; and keeps redacted evidence when a case fails.
//!
//! The engine endpoint is a fixed socket per case, so the Docker provider
//! alias and image addresses that cases name do not change between runs.

use crate::docker_engine::{self, DATA_ROOT};
use nemoclaw_e2e::{http_fixture, openshell};
use nemoclaw_sdk::{compile, config::Document};
use nemoclaw_test_fixtures::Bundle;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/hcl/integration");
const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
/// Generation kinds a document may need; the values are fixed per run.
const GENERATIONS: [&str; 7] = [
    "workspace",
    "provider",
    "sandbox",
    "managed_gateway",
    "inference_service",
    "ollama",
    "ollama_service",
];

/// Fixture state that the engine, upstream, and control endpoints share.
#[derive(Default)]
struct Shared {
    gateway: Arc<Mutex<openshell::State>>,
    gateway_endpoint: String,
    engine: Mutex<docker_engine::Engine>,
    engine_endpoint: String,
    engine_requests: Mutex<Vec<String>>,
    /// Images and containers a case declares through `fixture_engine`.
    images: Mutex<Vec<Value>>,
    containers: Mutex<Vec<Value>>,
    upstream_endpoint: Mutex<String>,
    upstream_requests: Mutex<Vec<String>>,
    /// Replies a case declares through `fixture_http`, by `METHOD /path`.
    routes: Mutex<serde_json::Map<String, Value>>,
    /// Fixture credential values by environment variable.
    credentials: BTreeMap<String, String>,
}

impl Shared {
    fn redact(&self, mut text: String) -> String {
        for value in self.credentials.values() {
            text = text.replace(value, "[REDACTED]");
        }
        text
    }

    /// Engine replies for declared images and containers and the engine's
    /// identity; everything else goes to the stateful fake engine.
    fn engine_reply(&self, request: &http_fixture::Request) -> (u16, Vec<u8>) {
        self.engine_requests
            .lock()
            .unwrap()
            .push(format!("{} {}", request.method, request.path));
        let path = request.path.split('?').next().unwrap_or_default();
        let path = path
            .replace("%40", "@")
            .replace("%3A", ":")
            .replace("%2F", "/");
        let reply = |value: Value| (200, serde_json::to_vec(&value).unwrap());
        if request.method == "GET" || request.method == "HEAD" {
            match path.as_str() {
                "/_ping" => return (200, b"OK".to_vec()),
                "/info" => {
                    return reply(json!({"ID":"engine", "DockerRootDir":DATA_ROOT,
                        "Architecture":"arm64", "OSType":"linux", "ServerVersion":"28.0"}));
                }
                "/version" => {
                    return reply(json!({"ApiVersion":"1.47", "MinAPIVersion":"1.24",
                        "Version":"28.0", "Os":"linux", "Arch":"arm64"}));
                }
                _ => {}
            }
            if let Some(name) = path
                .strip_prefix("/images/")
                .and_then(|rest| rest.strip_suffix("/json"))
            {
                let images = self.images.lock().unwrap();
                return match images
                    .iter()
                    .find(|image| image["reference"] == name || image["id"] == name)
                {
                    Some(image) => reply(image_inspect(image)),
                    None => (404, br#"{"message":"No such image"}"#.to_vec()),
                };
            }
            // Declared containers answer inspection and file reads by ID.
            if let Some((id, operation)) = path
                .strip_prefix("/containers/")
                .and_then(|rest| rest.split_once('/'))
                && let Some(container) = self
                    .containers
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|container| declared(container, id))
            {
                match operation {
                    "json" => return reply(container_inspect(container)),
                    "archive" => {
                        let url =
                            url::Url::parse(&format!("http://engine{}", request.path)).unwrap();
                        let file = url
                            .query_pairs()
                            .find(|(key, _)| key == "path")
                            .map(|(_, value)| value.into_owned())
                            .unwrap_or_default();
                        return match container["files"][&file].as_str() {
                            Some(content) => (
                                200,
                                docker_engine::tar_entry(
                                    file.rsplit('/').next().unwrap_or_default(),
                                    content.as_bytes(),
                                ),
                            ),
                            None => (404, br#"{"message":"No such file"}"#.to_vec()),
                        };
                    }
                    _ => {}
                }
            }
        }
        let mut engine = self.engine.lock().unwrap();
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            docker_engine::handle(&mut engine, &request.method, &request.path, &request.body)
        }))
        .unwrap_or_else(|_| {
            engine
                .mutations
                .push(format!("UNEXPECTED {} {}", request.method, request.path));
            (500, br#"{"message":"unexpected fixture request"}"#.to_vec())
        })
    }

    /// Docker's file metadata for a declared container's file, which a
    /// `HEAD` on its archive returns in a header. Declared files have mode 0600.
    fn engine_stat(&self, request: &http_fixture::Request) -> Option<http_fixture::Reply> {
        if request.method != "HEAD" {
            return None;
        }
        let url = url::Url::parse(&format!("http://engine{}", request.path)).ok()?;
        let id = url
            .path()
            .strip_prefix("/containers/")?
            .strip_suffix("/archive")?;
        let file = url
            .query_pairs()
            .find(|(key, _)| key == "path")
            .map(|(_, value)| value.into_owned())?;
        let containers = self.containers.lock().unwrap();
        let container = containers
            .iter()
            .find(|container| declared(container, id))?;
        self.engine_requests
            .lock()
            .unwrap()
            .push(format!("{} {}", request.method, request.path));
        let Some(content) = container["files"][&file].as_str() else {
            return Some((404, Vec::new(), Vec::new()));
        };
        use base64::Engine as _;
        let stat = json!({"name": file.rsplit('/').next(), "size": content.len(),
            "mode": 0o600, "mtime": "2026-01-01T00:00:00Z", "linkTarget": ""});
        Some((
            200,
            vec![(
                "X-Docker-Container-Path-Stat".into(),
                base64::engine::general_purpose::STANDARD.encode(stat.to_string()),
            )],
            Vec::new(),
        ))
    }

    fn upstream_reply(&self, request: &http_fixture::Request) -> (u16, Vec<u8>) {
        let key = format!("{} {}", request.method, request.path);
        self.upstream_requests.lock().unwrap().push(key.clone());
        match self.routes.lock().unwrap().get(&key) {
            Some(route) => (
                route["status"].as_u64().unwrap_or(200) as u16,
                route
                    .get("body")
                    .map(|body| serde_json::to_vec(body).unwrap())
                    .unwrap_or_default(),
            ),
            None => (404, Vec::new()),
        }
    }

    fn control_reply(&self, request: &http_fixture::Request) -> (u16, Vec<u8>) {
        let body = || serde_json::from_slice::<Value>(&request.body);
        let reply = |value: Value| (200, self.redact(value.to_string()).into_bytes());
        let list = |value: &Value| value.as_array().cloned().unwrap_or_default();
        match (request.method.as_str(), request.path.as_str()) {
            ("PUT", "/engine") => {
                let Ok(declared) = body() else {
                    return (400, b"invalid JSON".to_vec());
                };
                *self.images.lock().unwrap() = list(&declared["images"]);
                *self.containers.lock().unwrap() = list(&declared["containers"]);
                reply(json!({"endpoint": self.engine_endpoint}))
            }
            ("PUT", "/gateway") => {
                let Ok(declared) = body() else {
                    return (400, b"invalid JSON".to_vec());
                };
                // The compute driver the gateway reports; Docker by default.
                self.gateway.lock().unwrap().driver =
                    declared["compute_driver"].as_str().map(str::to_owned);
                reply(json!({"endpoint": self.gateway_endpoint}))
            }
            ("PUT", "/http") => {
                let Ok(declared) = body() else {
                    return (400, b"invalid JSON".to_vec());
                };
                *self.routes.lock().unwrap() =
                    declared["routes"].as_object().cloned().unwrap_or_default();
                reply(json!({"endpoint": *self.upstream_endpoint.lock().unwrap()}))
            }
            ("GET", "/observations") => reply(self.observations()),
            _ => (404, b"unknown control request".to_vec()),
        }
    }

    /// Facts recorded by the fixtures. Credential values are replaced by their
    /// source: the environment variable or declared container file.
    fn observations(&self) -> Value {
        let state = self.gateway.lock().unwrap();
        let containers = self.containers.lock().unwrap().clone();
        let provenance = |value: &String| {
            let from_environment = self
                .credentials
                .iter()
                .find(|(_, supplied)| *supplied == value)
                .map(|(name, _)| format!("env:{name}"));
            // A declared container file, such as a service's generated key.
            let from_file = || {
                containers.iter().find_map(|container| {
                    container["files"]
                        .as_object()?
                        .iter()
                        .find_map(|(path, content)| {
                            (content == value).then(|| {
                                format!(
                                    "file:{}:{path}",
                                    container["name"].as_str().unwrap_or_default()
                                )
                            })
                        })
                })
            };
            from_environment
                .or_else(from_file)
                .unwrap_or_else(|| "unrecognized".to_owned())
        };
        let keys = |map: Vec<&String>| {
            let mut keys: Vec<&String> = map;
            keys.sort();
            json!(keys)
        };
        let providers: Vec<Value> = state
            .created_providers
            .iter()
            .map(|provider| {
                let meta = provider.metadata.clone().unwrap_or_default();
                json!({
                    "name": meta.name, "workspace": meta.workspace, "labels": meta.labels,
                    "type": provider.r#type, "config": provider.config,
                    "credentials": provider.credentials.iter()
                        .map(|(name, value)| (name.clone(), provenance(value)))
                        .collect::<BTreeMap<_, _>>(),
                })
            })
            .collect();
        let sandboxes: Vec<Value> = state
            .created_sandboxes
            .iter()
            .map(|sandbox| {
                let meta = sandbox.metadata.clone().unwrap_or_default();
                let spec = sandbox.spec.clone().unwrap_or_default();
                let endpoints: Vec<String> = spec
                    .policy
                    .iter()
                    .flat_map(|policy| policy.network_policies.values())
                    .flat_map(|rule| &rule.endpoints)
                    .map(|endpoint| format!("{}:{}{}", endpoint.host, endpoint.port, endpoint.path))
                    .collect();
                json!({
                    "id": meta.id, "name": meta.name, "workspace": meta.workspace,
                    "labels": meta.labels, "providers": spec.providers,
                    "command": spec.command, "policy_endpoints": endpoints,
                })
            })
            .collect();
        let execs: Vec<Value> = state
            .exec_calls
            .iter()
            .zip(&state.exec_sandboxes)
            .zip(&state.exec_stdin)
            .map(|((command, sandbox), stdin)| {
                json!({"sandbox": sandbox, "command": command,
                    "stdin": String::from_utf8_lossy(stdin)})
            })
            .collect();
        let openshell = json!({
            "endpoint": self.gateway_endpoint,
            "rpcs": state.rpcs.iter()
                .map(|rpc| rpc.trim_start_matches("/openshell.v1.OpenShell/"))
                .collect::<Vec<_>>(),
            "created_providers": providers,
            "created_sandboxes": sandboxes,
            "execs": execs,
            "objects": {
                "workspaces": keys(state.workspaces.keys().collect()),
                "profiles": keys(state.profiles.keys().collect()),
                "providers": keys(state.providers.keys().collect()),
                "sandboxes": keys(state.sandboxes.keys().collect()),
            },
            "fabric": {
                "starts": state.fabric_starts,
                "runtimes": keys(state.fabric_runtimes.keys().collect()),
            },
        });
        drop(state);
        let engine = self.engine.lock().unwrap();
        json!({
            "openshell": openshell,
            "engine": {
                "endpoint": self.engine_endpoint,
                "requests": *self.engine_requests.lock().unwrap(),
                "mutations": engine.mutations,
                "volumes": engine.volumes.keys().collect::<Vec<_>>(),
                "networks": engine.networks.keys().collect::<Vec<_>>(),
                "containers": engine.containers.iter()
                    .map(|container| container["Name"].clone()).collect::<Vec<_>>(),
            },
            "http": {
                "endpoint": *self.upstream_endpoint.lock().unwrap(),
                "requests": *self.upstream_requests.lock().unwrap(),
            },
        })
    }
}

/// Docker's inspection of a declared image. A digest reference is reported
/// in `RepoDigests`, a tag in `RepoTags`.
fn image_inspect(image: &Value) -> Value {
    let reference = image["reference"].as_str().unwrap_or_default();
    let mut labels = image["labels"].as_object().cloned().unwrap_or_default();
    if image["fabric_catalog"] == true {
        labels.insert(
            nemoclaw_sdk::fabric_catalog::IMAGE_CATALOG_LABEL.into(),
            json!(serde_json::to_string(&nemoclaw_e2e::image_runtime::catalog()).unwrap()),
        );
    }
    let digest = reference.contains('@');
    json!({
        "Id": image["id"],
        "Architecture": image.get("architecture").cloned().unwrap_or(json!("arm64")),
        "Os": "linux",
        "RepoDigests": if digest { json!([reference]) } else { json!([]) },
        "RepoTags": if digest { json!([]) } else { json!([reference]) },
        "Config": {"Labels": labels},
    })
}

/// Whether `reference` names a declared container: by ID, as a mocked Docker
/// resource reports it, or by name when the declaration sets `by_name`.
/// A container that providers must not find before Docker would create it,
/// such as the managed gateway, leaves `by_name` unset.
fn declared(container: &Value, reference: &str) -> bool {
    container["id"] == reference || (container["by_name"] == true && container["name"] == reference)
}

/// Docker's inspection of a declared container, which a mocked Docker
/// resource reports by ID. Declared mounts are volumes, by destination.
fn container_inspect(container: &Value) -> Value {
    let running = container["running"] != false;
    let mounts: Vec<Value> = container["mounts"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(destination, volume)| {
            json!({"Type": "volume", "Name": volume, "Source": volume,
                "Destination": destination, "RW": true})
        })
        .collect();
    json!({
        "Id": container["id"],
        "Name": format!("/{}", container["name"].as_str().unwrap_or_default()),
        "Image": container["image"],
        "Config": {"Image": container["image"], "Labels": container["labels"]},
        "Mounts": mounts,
        "State": {"Status": if running { "running" } else { "exited" },
            "Running": running, "ExitCode": 0,
            "StartedAt": container.get("started_at").cloned()
                .unwrap_or(json!("2026-01-01T00:00:00Z"))},
    })
}

/// The fixtures for one case; each stops when this drops, also on panic.
struct Fixtures {
    shared: Arc<Shared>,
    _gateway: openshell::Fixture,
    _engine: http_fixture::Fixture,
    _upstream: http_fixture::Fixture,
    control: http_fixture::Fixture,
    socket: PathBuf,
}

impl Drop for Fixtures {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.socket);
    }
}

impl Fixtures {
    async fn start(case: &str, credentials: BTreeMap<String, String>) -> Self {
        // A fixed socket keeps the generated Docker provider alias stable.
        let socket = PathBuf::from(format!("/tmp/nemoclaw-integration/{case}.sock"));
        fs::create_dir_all(socket.parent().unwrap()).unwrap();
        if socket.exists() {
            assert!(
                std::os::unix::net::UnixStream::connect(&socket).is_err(),
                "another run of {case} serves {}",
                socket.display()
            );
            fs::remove_file(&socket).unwrap();
        }
        let gateway = openshell::Fixture::start().await;
        let shared = Arc::new(Shared {
            gateway: gateway.state.clone(),
            gateway_endpoint: gateway.endpoint.clone(),
            engine_endpoint: format!("unix://{}", socket.display()),
            credentials,
            ..Default::default()
        });
        let serving = shared.clone();
        let engine = http_fixture::Fixture::start_at_with_headers(&socket, move |request| {
            Some(serving.engine_stat(&request).unwrap_or_else(|| {
                let (status, body) = serving.engine_reply(&request);
                (status, Vec::new(), body)
            }))
        })
        .await;
        let serving = shared.clone();
        let upstream =
            http_fixture::Fixture::start_tcp(move |request| Some(serving.upstream_reply(&request)))
                .await;
        *shared.upstream_endpoint.lock().unwrap() = upstream.endpoint.clone();
        let serving = shared.clone();
        let control =
            http_fixture::Fixture::start_tcp(move |request| Some(serving.control_reply(&request)))
                .await;
        Self {
            shared,
            _gateway: gateway,
            _engine: engine,
            _upstream: upstream,
            control,
            socket,
        }
    }

    /// Point the document's gateway, any engine it names, and inference
    /// providers at the fixtures. Inference paths are kept.
    fn redirect(&self, document: &mut Document) {
        *document.spec.gateway.endpoint_mut() = self.shared.gateway_endpoint.clone();
        let engine = match &mut document.spec.gateway {
            nemoclaw_sdk::config::Gateway::External(gateway) => Some(&mut gateway.engine),
            gateway => gateway.as_managed_mut().map(|managed| &mut managed.engine),
        };
        // A Kubernetes or OpenShift gateway names no engine.
        if let Some(engine) = engine.filter(|engine| !engine.is_empty()) {
            engine.clone_from(&self.shared.engine_endpoint);
        }
        let upstream = self.shared.upstream_endpoint.lock().unwrap().clone();
        for provider in document.spec.inference_providers.values_mut() {
            // Providers of managed services take their endpoint from the service.
            if provider.endpoint.is_empty() {
                continue;
            }
            let path = url::Url::parse(&provider.endpoint)
                .unwrap()
                .path()
                .to_owned();
            provider.endpoint = format!("{upstream}{}", path.trim_end_matches('/'));
        }
    }
}

/// The run directory, kept with redacted evidence when the case fails.
struct Evidence {
    directory: Option<tempfile::TempDir>,
    shared: Arc<Shared>,
    outputs: Mutex<Vec<(String, String)>>,
}

impl Evidence {
    fn path(&self) -> &Path {
        self.directory.as_ref().unwrap().path()
    }
    fn record(&self, name: &str, text: &str) {
        self.outputs
            .lock()
            .unwrap()
            .push((name.into(), text.into()));
    }
}

impl Drop for Evidence {
    fn drop(&mut self) {
        if !std::thread::panicking() {
            return;
        }
        let directory = self.directory.take().unwrap().keep();
        let evidence = directory.join("evidence");
        let _ = fs::create_dir_all(&evidence);
        let mut files = std::mem::take(&mut *self.outputs.lock().unwrap());
        if let Ok(observations) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            serde_json::to_string_pretty(&self.shared.observations()).unwrap()
        })) {
            files.push(("observations.json".into(), observations));
        }
        for path in walk(&directory.join("work")) {
            if path
                .extension()
                .is_some_and(|extension| extension == "tfstate")
            {
                files.push((
                    path.file_name().unwrap().to_string_lossy().into_owned(),
                    fs::read_to_string(&path).unwrap_or_default(),
                ));
            }
        }
        for (name, text) in files {
            let _ = fs::write(evidence.join(name), self.shared.redact(text));
        }
        eprintln!("integration evidence retained in {}", evidence.display());
    }
}

fn walk(directory: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for entry in fs::read_dir(directory).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() {
            if path.file_name().is_none_or(|name| name != ".terraform") {
                files.extend(walk(&path));
            }
        } else {
            files.push(path);
        }
    }
    files
}

fn copy_tree(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}

/// Run pinned OpenTofu in the case's directory with only the environment the
/// case needs, killing it at the deadline.
async fn tofu(
    bundle: &Bundle,
    evidence: &Evidence,
    directory: &Path,
    args: &[&str],
    environment: &BTreeMap<String, String>,
) -> (bool, String) {
    let mut command = tokio::process::Command::new(bundle.tofu());
    command
        .args(args)
        .current_dir(directory)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .envs(environment)
        .kill_on_drop(true);
    let output = tokio::time::timeout(COMMAND_TIMEOUT, command.output())
        .await
        .unwrap_or_else(|_| panic!("tofu {} exceeded {COMMAND_TIMEOUT:?}", args[0]))
        .unwrap();
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    evidence.record(&format!("tofu-{}.txt", args[0]), &text);
    (output.status.success(), text)
}

/// Every resource address in a compiled graph.
fn addresses(graph: &Value) -> BTreeSet<String> {
    graph["resource"]
        .as_object()
        .into_iter()
        .flatten()
        .flat_map(|(kind, resources)| {
            resources
                .as_object()
                .into_iter()
                .flatten()
                .map(move |(name, _)| format!("{kind}.{name}"))
        })
        .collect()
}

/// `retained` and every resource they depend on, through `depends_on`,
/// references, and the data sources between them. OpenTofu's teardown stops
/// when it reaches retained storage, so any of them may remain.
fn with_dependencies(graph: &Value, retained: &BTreeSet<String>) -> BTreeSet<String> {
    let blocks: BTreeMap<String, String> = ["resource", "data"]
        .into_iter()
        .flat_map(|mode| {
            graph[mode]
                .as_object()
                .into_iter()
                .flatten()
                .flat_map(move |(kind, blocks)| {
                    blocks
                        .as_object()
                        .into_iter()
                        .flatten()
                        .map(move |(name, block)| {
                            let address = if mode == "data" {
                                format!("data.{kind}.{name}")
                            } else {
                                format!("{kind}.{name}")
                            };
                            (address, block.to_string())
                        })
                })
        })
        .collect();
    let refers = |text: &str, address: &str| {
        text.match_indices(address).any(|(start, _)| {
            let before = text[..start].chars().next_back();
            let after = text[start + address.len()..].chars().next();
            !before.is_some_and(|c| c.is_ascii_alphanumeric() || "_-.".contains(c))
                && !after.is_some_and(|c| c.is_ascii_alphanumeric() || "_-".contains(c))
        })
    };
    let mut kept = retained.clone();
    let mut pending: Vec<String> = retained.iter().cloned().collect();
    while let Some(address) = pending.pop() {
        let Some(text) = blocks.get(&address) else {
            continue;
        };
        for dependency in blocks.keys() {
            if dependency != &address && refers(text, dependency) && kept.insert(dependency.clone())
            {
                pending.push(dependency.clone());
            }
        }
    }
    kept
}

async fn run_case(bundle: Bundle, case: PathBuf) {
    let name = case.file_name().unwrap().to_string_lossy().into_owned();
    let manifest: Value =
        serde_json::from_slice(&fs::read(bundle.root().join("manifest.json")).unwrap()).unwrap();
    let version = manifest["Version"].as_str().unwrap().to_owned();
    let mut document =
        Document::parse(fs::read(case.join("nemoclaw.yaml")).unwrap().as_slice()).unwrap();
    // The fixture gateway serves plaintext gRPC without a bearer.
    if let nemoclaw_sdk::config::Gateway::External(gateway) = &mut document.spec.gateway {
        gateway.credential = None;
        gateway.tls = None;
    }
    // Each image metadata reference names the fixture's metadata bundle, for
    // gateways where no engine inspects images.
    let image_metadata: BTreeSet<String> = document
        .spec
        .sandboxes
        .values()
        .filter_map(|sandbox| sandbox.image.metadata.as_ref())
        .map(|metadata| metadata.env.clone())
        .collect();
    let credentials: BTreeMap<String, String> = document
        .credential_names()
        .into_iter()
        .filter(|name| !image_metadata.contains(*name))
        .map(|credential| {
            let value = format!("fixture-credential-{}", credential.to_lowercase());
            (credential.to_owned(), value)
        })
        .collect();
    let fixtures = Fixtures::start(&name, credentials.clone()).await;
    let evidence = Evidence {
        directory: Some(tempfile::tempdir().unwrap()),
        shared: fixtures.shared.clone(),
        outputs: Mutex::default(),
    };
    fixtures.redirect(&mut document);
    let generations: compile::Generations =
        GENERATIONS.map(|kind| (kind.into(), "a".repeat(32))).into();
    let mut graph = compile::compile(&document, &generations, &version).unwrap();
    let retained = compile::compile_teardown(&document, &generations, &version, &addresses(&graph))
        .unwrap()
        .retained;
    let removable_after_teardown = with_dependencies(&graph, &retained);

    // `tofu test` removes what it applied; the apply graph's protection
    // against destroy is left to the SDK's own teardown graph.
    for resources in graph["resource"].as_object_mut().unwrap().values_mut() {
        for resource in resources.as_object_mut().unwrap().values_mut() {
            if let Some(lifecycle) = resource.get_mut("lifecycle").and_then(Value::as_object_mut) {
                lifecycle.remove("prevent_destroy");
            }
        }
    }
    // A module has one required_providers block; cases use the fixture
    // provider from it.
    graph["terraform"]["required_providers"]["fixture"] =
        json!({"source": "registry.opentofu.org/nvidia/fixture", "version": "= 1.0.0"});
    let work = evidence.path().join("work");
    let shared_hcl = Path::new(ROOT).join("shared");
    if shared_hcl.is_dir() {
        copy_tree(&shared_hcl, &work.join("shared"));
    }
    let directory = work.join("cases").join(&name);
    copy_tree(&case, &directory);
    assert!(
        fs::read_dir(&case)
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().ends_with(".tftest.hcl")),
        "{name} has no .tftest.hcl file"
    );
    fs::write(
        directory.join("nemoclaw.tf.json"),
        serde_json::to_vec_pretty(&graph).unwrap(),
    )
    .unwrap();
    // The fixture provider comes from its own mirror; the rest from the bundle.
    let platform = bundle
        .root()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let fixture_provider = evidence
        .path()
        .join("fixture-provider/registry.opentofu.org/nvidia/fixture/1.0.0")
        .join(platform);
    fs::create_dir_all(&fixture_provider).unwrap();
    std::os::unix::fs::symlink(
        nemoclaw_test_fixtures::fixture_executable("nemoclaw-fixture-control"),
        fixture_provider.join("terraform-provider-fixture"),
    )
    .unwrap();
    let quoted = |path: &Path| serde_json::to_string(path).unwrap();
    let fixture = "\"registry.opentofu.org/nvidia/fixture\"";
    fs::write(
        evidence.path().join("providers.tfrc"),
        format!(
            "provider_installation {{\n  filesystem_mirror {{\n    path    = {}\n    include = [{fixture}]\n  }}\n  filesystem_mirror {{\n    path    = {}\n    exclude = [{fixture}]\n  }}\n}}\n",
            quoted(&evidence.path().join("fixture-provider")),
            quoted(&bundle.root().join("providers")),
        ),
    )
    .unwrap();
    let mut environment = credentials.clone();
    if !image_metadata.is_empty() {
        let directory = evidence.path().join("image-metadata");
        fs::create_dir_all(&directory).unwrap();
        let (_, bundle) = nemoclaw_e2e::image_runtime::metadata_bundle(&directory);
        for variable in &image_metadata {
            environment.insert(variable.clone(), bundle.to_string_lossy().into_owned());
        }
    }
    for (variable, value) in [
        ("HOME", evidence.path().join("home")),
        ("TMPDIR", evidence.path().join("tmp")),
        ("TF_CLI_CONFIG_FILE", evidence.path().join("providers.tfrc")),
        (
            nemoclaw_backend::DIAGNOSTICS_ENV,
            evidence.path().join("diagnostics"),
        ),
    ] {
        fs::create_dir_all(if variable == "TF_CLI_CONFIG_FILE" {
            evidence.path().to_owned()
        } else {
            value.clone()
        })
        .unwrap();
        environment.insert(variable.into(), value.to_string_lossy().into_owned());
    }
    environment.insert("TF_IN_AUTOMATION".into(), "1".into());
    environment.insert("CHECKPOINT_DISABLE".into(), "1".into());
    environment.insert(
        "NEMOCLAW_FIXTURE_CONTROL".into(),
        fixtures.control.endpoint.clone(),
    );

    let (initialized, output) = tofu(
        &bundle,
        &evidence,
        &directory,
        &["init", "-input=false", "-no-color"],
        &environment,
    )
    .await;
    assert!(initialized, "{}", fixtures.shared.redact(output));
    let (tested, output) = tofu(
        &bundle,
        &evidence,
        &directory,
        &["test", "-no-color"],
        &environment,
    )
    .await;
    let shown = fixtures.shared.redact(output.clone());
    assert!(tested, "{shown}");
    // Every run passed, and there was at least one.
    let passed = output
        .split("Success! ")
        .nth(1)
        .and_then(|summary| summary.split(" passed, 0 failed.").next())
        .and_then(|count| count.parse::<usize>().ok());
    assert!(passed.is_some_and(|count| count > 0), "{shown}");
    for value in credentials.values() {
        assert!(
            !output.contains(value),
            "OpenTofu output repeats a credential"
        );
        for file in walk(&evidence.path().join("diagnostics")) {
            assert!(
                !fs::read_to_string(&file)
                    .unwrap_or_default()
                    .contains(value),
                "{} repeats a credential",
                file.display()
            );
        }
    }

    // OpenTofu's teardown runs after the last run block. It may leave only
    // storage that NemoClaw's teardown retains, whose provider refuses to
    // delete it, and what that storage depends on.
    let errored = directory.join("errored_test.tfstate");
    if errored.exists() {
        let left: Value = serde_json::from_slice(&fs::read(&errored).unwrap()).unwrap();
        let left: BTreeSet<String> = left["resources"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|resource| resource["mode"] == "managed")
            .map(|resource| {
                format!(
                    "{}.{}",
                    resource["type"].as_str().unwrap(),
                    resource["name"].as_str().unwrap()
                )
            })
            .collect();
        assert!(
            left.is_subset(&removable_after_teardown),
            "teardown left {left:?}; only retained storage may remain: {retained:?}\n{shown}"
        );
        for line in output.lines().filter(|line| line.starts_with("Error: ")) {
            assert_eq!(line, "Error: Destroy incomplete", "{shown}");
        }
        assert!(
            output.contains("persistent storage deletion is forbidden"),
            "{shown}"
        );
    }
    let state = fixtures.shared.gateway.lock().unwrap();
    assert!(
        state.sandboxes.is_empty()
            && state.providers.is_empty()
            && state.profiles.is_empty()
            && state.workspaces.is_empty(),
        "teardown left OpenShell objects: {:#?}",
        fixtures.shared.observations()["openshell"]["objects"]
    );
    assert!(
        state.fabric_runtimes.is_empty(),
        "teardown left Fabric runtimes"
    );
    drop(state);
    let engine = fixtures.shared.engine.lock().unwrap();
    assert!(
        !engine
            .mutations
            .iter()
            .any(|mutation| mutation.starts_with("UNEXPECTED")
                || mutation.starts_with("DELETE /volumes")),
        "the engine received unexpected or storage-deleting requests: {:#?}",
        engine.mutations
    );
    drop(engine);
    drop(evidence);
    drop(fixtures);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE"]
async fn every_case_passes_under_tofu_test() {
    let bundle = Bundle::from_env();
    let mut cases: Vec<PathBuf> = fs::read_dir(Path::new(ROOT).join("cases"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.is_dir())
        .collect();
    cases.sort();
    assert!(!cases.is_empty());
    let mut failed = Vec::new();
    for case in cases {
        let name = case.file_name().unwrap().to_string_lossy().into_owned();
        let started = Instant::now();
        let outcome = tokio::spawn(run_case(bundle.clone(), case)).await;
        println!(
            "case {name}: {} in {:.1?}",
            if outcome.is_ok() { "passed" } else { "failed" },
            started.elapsed()
        );
        if outcome.is_err() {
            failed.push(name);
        }
    }
    assert!(failed.is_empty(), "failed cases: {failed:?}");
}
