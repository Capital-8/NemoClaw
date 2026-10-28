// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The `fixture` provider through which `tofu test` scenarios configure and
//! observe the fixtures that `nemoclaw-e2e`'s integration runner serves.
//! Its data sources call the runner's control endpoint, which
//! `NEMOCLAW_FIXTURE_CONTROL` names:
//!
//! - `fixture_engine` declares the images and containers the fake engine
//!   reports, such as those a mocked Docker provider would have created.
//! - `fixture_http` declares the inference upstream's replies by request.
//! - `fixture_observations` reports recorded requests and current fixture
//!   state as JSON. Scenarios decide pass or fail with HCL assertions.
//!
//! Declarations replace earlier ones; the runner owns fixture lifetime.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tf_provider::{
    DataSource, Diagnostics, DynamicDataSource, DynamicResource, Provider,
    schema::{Attribute, AttributeConstraint, AttributeType, Block, Description, Schema},
    value::{Value, ValueEmpty},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const CONTROL: &str = "NEMOCLAW_FIXTURE_CONTROL";

/// Send one request to the runner's control endpoint and return its JSON reply.
async fn control(method: &str, path: &str, body: &str) -> Result<serde_json::Value, String> {
    let endpoint = std::env::var(CONTROL).map_err(|_| format!("{CONTROL} is not set"))?;
    let address = endpoint
        .strip_prefix("http://")
        .ok_or("the control endpoint must be http://HOST:PORT")?;
    let mut stream = tokio::net::TcpStream::connect(address)
        .await
        .map_err(|error| format!("cannot reach the fixture control endpoint: {error}"))?;
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    let mut reply = Vec::new();
    stream
        .read_to_end(&mut reply)
        .await
        .map_err(|error| error.to_string())?;
    let reply = String::from_utf8(reply).map_err(|_| "the control reply is not UTF-8")?;
    let (head, body) = reply
        .split_once("\r\n\r\n")
        .ok_or("the control reply has no body")?;
    if !head.starts_with("HTTP/1.1 200 ") {
        return Err(format!(
            "{method} {path}: {}: {body}",
            head.lines().next().unwrap_or_default()
        ));
    }
    serde_json::from_str(body).map_err(|error| format!("invalid control reply: {error}"))
}

fn schema(attributes: &[(&str, AttributeConstraint, &str)]) -> Schema {
    Schema {
        version: 0,
        block: Block {
            attributes: attributes
                .iter()
                .map(|(name, constraint, description)| {
                    (
                        (*name).into(),
                        Attribute {
                            attr_type: AttributeType::String,
                            constraint: constraint.clone(),
                            description: Description::plain((*description).to_owned()),
                            ..Default::default()
                        },
                    )
                })
                .collect(),
            ..Default::default()
        },
    }
}

/// A JSON string attribute, or `null` while it is unknown or unset.
fn json(value: &Value<String>) -> Result<serde_json::Value, String> {
    match value {
        Value::Value(text) => {
            serde_json::from_str(text).map_err(|error| format!("invalid JSON: {error}"))
        }
        Value::Null => Ok(serde_json::Value::Null),
        Value::Unknown => Err("the declaration is not yet known".into()),
    }
}

#[derive(Default, Serialize, Deserialize)]
struct EngineState {
    images_json: Value<String>,
    containers_json: Value<String>,
    endpoint: Value<String>,
}
struct Engine;
#[async_trait]
impl DataSource for Engine {
    type State<'a> = EngineState;
    type ProviderMetaState<'a> = ValueEmpty;
    fn schema(&self, _: &mut Diagnostics) -> Option<Schema> {
        use AttributeConstraint::{Computed, Optional};
        Some(schema(&[
            (
                "images_json",
                Optional,
                "JSON list of images: reference, id, and optional architecture, labels, and fabric_catalog.",
            ),
            (
                "containers_json",
                Optional,
                "JSON list of containers: id, name, image, labels, running, started_at, mounts (destination to volume), files (path to content, mode 0600), and by_name. Found by ID, and by name when by_name is true.",
            ),
            ("endpoint", Computed, "The fake engine's endpoint."),
        ]))
    }
    async fn read<'a>(
        &self,
        diags: &mut Diagnostics,
        mut config: EngineState,
        _: ValueEmpty,
    ) -> Option<EngineState> {
        let work = async {
            let body = serde_json::json!({
                "images": json(&config.images_json)?,
                "containers": json(&config.containers_json)?,
            });
            control("PUT", "/engine", &body.to_string()).await
        };
        match work.await {
            Ok(reply) => {
                config.endpoint = Value::Value(reply["endpoint"].as_str()?.to_owned());
                Some(config)
            }
            Err(error) => {
                diags.root_error("Fixture engine declaration failed", error);
                None
            }
        }
    }
}

#[derive(Default, Serialize, Deserialize)]
struct HttpState {
    routes_json: Value<String>,
    endpoint: Value<String>,
}
struct Http;
#[async_trait]
impl DataSource for Http {
    type State<'a> = HttpState;
    type ProviderMetaState<'a> = ValueEmpty;
    fn schema(&self, _: &mut Diagnostics) -> Option<Schema> {
        use AttributeConstraint::{Computed, Optional};
        Some(schema(&[
            (
                "routes_json",
                Optional,
                "JSON object from `METHOD /path` to a reply: status and an optional JSON body. Other requests receive 404.",
            ),
            ("endpoint", Computed, "The inference upstream's endpoint."),
        ]))
    }
    async fn read<'a>(
        &self,
        diags: &mut Diagnostics,
        mut config: HttpState,
        _: ValueEmpty,
    ) -> Option<HttpState> {
        let work = async {
            let body = serde_json::json!({"routes": json(&config.routes_json)?});
            control("PUT", "/http", &body.to_string()).await
        };
        match work.await {
            Ok(reply) => {
                config.endpoint = Value::Value(reply["endpoint"].as_str()?.to_owned());
                Some(config)
            }
            Err(error) => {
                diags.root_error("Fixture HTTP declaration failed", error);
                None
            }
        }
    }
}

#[derive(Default, Serialize, Deserialize)]
struct ObservationState {
    openshell_json: Value<String>,
    engine_json: Value<String>,
    http_json: Value<String>,
}
struct Observations;
#[async_trait]
impl DataSource for Observations {
    type State<'a> = ObservationState;
    type ProviderMetaState<'a> = ValueEmpty;
    fn schema(&self, _: &mut Diagnostics) -> Option<Schema> {
        use AttributeConstraint::Computed;
        Some(schema(&[
            (
                "openshell_json",
                Computed,
                "The OpenShell gateway fixture: RPCs, created objects, sandbox execs, and current objects.",
            ),
            (
                "engine_json",
                Computed,
                "The fake engine: requests, mutations, and current volumes, networks, and containers.",
            ),
            ("http_json", Computed, "The inference upstream: requests."),
        ]))
    }
    async fn read<'a>(
        &self,
        diags: &mut Diagnostics,
        mut config: ObservationState,
        _: ValueEmpty,
    ) -> Option<ObservationState> {
        match control("GET", "/observations", "").await {
            Ok(reply) => {
                for (slot, name) in [
                    (&mut config.openshell_json, "openshell"),
                    (&mut config.engine_json, "engine"),
                    (&mut config.http_json, "http"),
                ] {
                    *slot = Value::Value(reply[name].to_string());
                }
                Some(config)
            }
            Err(error) => {
                diags.root_error("Fixture observation failed", error);
                None
            }
        }
    }
}

struct FixtureProvider;
#[async_trait]
impl Provider for FixtureProvider {
    type Config<'a> = ValueEmpty;
    type MetaState<'a> = ValueEmpty;
    fn schema(&self, _: &mut Diagnostics) -> Option<Schema> {
        Some(Schema {
            version: 0,
            block: Block::default(),
        })
    }
    fn get_resources(
        &self,
        _: &mut Diagnostics,
    ) -> Option<HashMap<String, Box<dyn DynamicResource>>> {
        Some(HashMap::new())
    }
    fn get_data_sources(
        &self,
        _: &mut Diagnostics,
    ) -> Option<HashMap<String, Box<dyn DynamicDataSource>>> {
        Some(HashMap::from([
            (
                "engine".into(),
                Box::new(Engine) as Box<dyn DynamicDataSource>,
            ),
            ("http".into(), Box::new(Http) as Box<dyn DynamicDataSource>),
            (
                "observations".into(),
                Box::new(Observations) as Box<dyn DynamicDataSource>,
            ),
        ]))
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    tf_provider::serve("fixture", FixtureProvider).await?;
    Ok(())
}
