// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use std::{collections::BTreeMap, path::Path};

// Release v3.3.0, source revision 0e0a60f31821ab5d2948daecb882a1ac27a98405.
// On 2026-10-06, versions.json archive pins were verified against the official
// SHA256SUMS signature using HashiCorp's published signing key fingerprint
// C874011F0AB405110D02105534365D9472D7468F. Upstream binary and license are unchanged.
/// Install the binary and unchanged upstream license from a checksum-verified release.
pub fn install(
    root: &Path,
    archive: &[u8],
    version: &str,
    platform: &str,
) -> Result<BTreeMap<String, String>, Box<dyn std::error::Error>> {
    if version != nemoclaw_sdk::kubernetes::gateway::PROVIDER_VERSION {
        return Err("unsupported Helm provider version".into());
    }
    crate::hashicorp_provider::install(
        root,
        archive,
        &nemoclaw_sdk::bundle::helm_provider_path(platform)?,
        "licenses/helm-provider-LICENSE",
    )
}
