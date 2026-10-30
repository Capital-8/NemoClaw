// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const localFilenamePrompts = [
  "Search main.rs for TODO comments",
  "Search main.go for TODO comments",
  "Search data.csv for missing values",
  "Search kernel.c for TODO comments.",
  "Search service.test.cpp for failing assertions.",
  "Search migration.sql for missing constraints.",
  "Search config.xml for duplicate keys.",
  "Search notebook.ipynb for failing assertions.",
  "Search archive.custom-format for missing values.",
  "Search args.url for TODO comments.",
  "Search for TODO comments in main.rs.",
  'Search "README.md" for TODO comments.',
  "Search 'src/runtime-context.ts' for TODO comments.",
  "Search `./docs/setup.md` for TODO comments.",
  'Search "/sandbox/README.md" for TODO comments.',
  'Search "package.dev.json" for the build script.',
  'Search "my folder/config.json" for duplicate keys.',
  'Search for "./my folder/report.md".',
];

export const quotedExternalResearchPrompts = [
  'Search for "official NemoClaw installation documentation on docs.nvidia.com".',
  "Search for 'official NemoClaw installation documentation on docs.nvidia.com'.",
  "Search for `official NemoClaw installation documentation on docs.nvidia.com`.",
  'Search for "official NemoClaw installation documentation about docs.nvidia.com/setup".',
  'Search for "official installation documentation about vendor/docs".',
  'Search for "official installation documentation in vendor/docs".',
  'Search for "official installation documentation in docs.nvidia.com".',
  'Search for "official NVIDIA\'s installation documentation in vendor/docs".',
  'Search for `official "NVIDIA" installation documentation in vendor/docs`.',
  'Search for "official NemoClaw installation documentation on docs.nvidia.com?".',
  'Search for "official installation documentation about *.md".',
  'Search for "official installation documentation [latest]".',
  'Read README.md. Search for "official NemoClaw installation documentation on docs.nvidia.com".',
];
