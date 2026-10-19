// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use std::{collections::BTreeMap, fs, path::Path};

/// Install a HashiCorp provider release's binary at `path` and its unchanged
/// upstream license at `license`, both from a checksum-verified archive.
pub(crate) fn install(
    root: &Path,
    archive: &[u8],
    path: &str,
    license: &str,
) -> Result<BTreeMap<String, String>, Box<dyn std::error::Error>> {
    let name = path.rsplit('/').next().ok_or("missing provider name")?;
    let binary = crate::extract_entry(archive, name, 256 << 20)?;
    let license_text = crate::extract_entry(archive, "LICENSE.txt", 1 << 20)?;
    let mut files = BTreeMap::new();
    for (relative, bytes) in [
        (path, binary.as_slice()),
        (license, license_text.as_slice()),
    ] {
        let destination = root.join(relative);
        fs::create_dir_all(destination.parent().ok_or("missing bundle parent")?)?;
        fs::write(&destination, bytes)?;
        files.insert(
            relative.to_owned(),
            nemoclaw_sdk::bundle::hash_file(&destination)?,
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root.join(path), fs::Permissions::from_mode(0o755))?;
    }
    Ok(files)
}
