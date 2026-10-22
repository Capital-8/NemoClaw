#!/bin/sh
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -eu
case "${1:-}" in
  install)
    set -eu
    for migration_version in 2026.9.5 2026.9.7; do
      migration_root="/usr/local/lib/nemoclaw/openclaw-migrations/$migration_version"
      case "$migration_version" in
        2026.9.5)
          migration_lock=8017b062c11b252e28c39935818ff236db1d10bcd7f2e563dafe6a88ebc467f4
          migration_integrity='sha512-TCO/ImVLh5HkF4tdfo7iriIa7kT6iYkIr/jR5ZOkePGFGhUx5Oe7DE716Y1DzzG2teRAVDdCjgJDu1A24Yta7w=='
          ;;
        2026.9.7)
          migration_lock=2cac5d8e136f4dbfb919a52ed61d6cc153048a090ae3ef5c38dd225a685eb7db
          migration_integrity='sha512-/8N2LnfTFQPvnZizi8qKSFfnLQaPvSG3Cb4xo1YV7b4JhYiUc43ZNRpXJ01bWghLK0Ezk3HVeo/DGHcIRQwRWA=='
          ;;
      esac
      node /scripts/lib/reviewed-npm-archive.mts --verify-lock \
        --lock-sha256 "$migration_lock" --lockfile "$migration_root/package-lock.json" \
        --registry-origin https://registry.npmjs.org/ \
        --package-spec "openclaw@$migration_version" --integrity "$migration_integrity" \
        --tarball-url "https://registry.npmjs.org/openclaw/-/openclaw-$migration_version.tgz" \
        --label "OpenClaw migration $migration_version"
      npm --prefix "$migration_root" ci --ignore-scripts --omit=dev --no-audit --no-fund --no-progress \
        --userconfig /dev/null --registry https://registry.npmjs.org/
    done
    ;;
  materialize)
    set -eu
    for migration_version in 2026.9.5 2026.9.7; do
      migration_root="/usr/local/lib/nemoclaw/openclaw-migrations/$migration_version"
      case "$migration_version" in
        2026.9.5) migration_lock=8017b062c11b252e28c39935818ff236db1d10bcd7f2e563dafe6a88ebc467f4 ;;
        2026.9.7) migration_lock=2cac5d8e136f4dbfb919a52ed61d6cc153048a090ae3ef5c38dd225a685eb7db ;;
      esac
      NPM_CONFIG_OFFLINE=true npm_config_offline=true \
        NPM_CONFIG_IGNORE_SCRIPTS=true npm_config_ignore_scripts=true \
        node "$migration_root/node_modules/openclaw/scripts/postinstall-bundled-plugins.mjs"
      node /scripts/lib/reviewed-npm-archive.mts --verify-installed-lock \
        --lock-sha256 "$migration_lock" --lockfile "$migration_root/package-lock.json" \
        --install-root "$migration_root" --label "OpenClaw migration $migration_version"
      chown -R root:root "$migration_root"
      chmod -R a+rX,go-w "$migration_root"
    done
    ;;
  *)
    echo "Expected install or materialize" >&2
    exit 1
    ;;
esac
