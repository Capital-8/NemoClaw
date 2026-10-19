// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use std::{collections::BTreeMap, path::Path};

// Release v3.3.0, source revision a612b9cfce0fd1321cf2d25084b07b8fccd79737.
// On 2026-10-19, versions.json archive pins were verified against the official
// SHA256SUMS signature using HashiCorp's published signing key fingerprint
// C874011F0AB405110D02105534365D9472D7468F. Upstream binary and license are unchanged.
/// Install the binary and unchanged upstream license from a checksum-verified release.
pub fn install(
    root: &Path,
    archive: &[u8],
    version: &str,
    platform: &str,
) -> Result<BTreeMap<String, String>, Box<dyn std::error::Error>> {
    if version != nemoclaw_sdk::kubernetes::models::PROVIDER_VERSION {
        return Err("unsupported Kubernetes provider version".into());
    }
    crate::hashicorp_provider::install(
        root,
        archive,
        &nemoclaw_sdk::bundle::kubernetes_provider_path(platform)?,
        "licenses/kubernetes-provider-LICENSE",
    )
}
