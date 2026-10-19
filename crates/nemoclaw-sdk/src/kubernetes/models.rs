// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Managed model services on a managed Kubernetes gateway's cluster. This
//! module builds configuration only: the bundled Kubernetes provider creates
//! the objects, and Kubernetes runs, restarts and schedules them.

use crate::artifact_pins as pins;

pub const PROVIDER_ADDRESS: &str = "registry.opentofu.org/hashicorp/kubernetes";
pub use pins::KUBERNETES_PROVIDER_VERSION as PROVIDER_VERSION;
