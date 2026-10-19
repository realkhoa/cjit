# CJIT Diagnostic & Benchmarking Scripts

## 1. Overview & Purpose
This directory contains developer CLI scripts and utilities for benchmarking, diagnosing, and stress-testing CJIT's Fast Engine and Clang-WASM compilation pipelines against real-world C/C++ repositories (e.g., `TheAlgorithms/C-Plus-Plus`).

`scan-algorithms.ts` provides automated recursive analysis of C++ source trees, parsing them through CJIT's Lexer, Preprocessor, and Recursive-Descent Parser (`analyzeSource`) to measure parser pass rates, identify grammar ambiguities, and catch regressions.

## 2. Prerequisites & Dependencies
- **Runtime**: Bun (`v1.2+`) or Node.js (`v20+` with tsx / ts-node)
- **Dependencies**: Project dependencies (`npm install` / `bun install`)
- **Repository Under Test**: Cloned repository in `.repos/TheAlgorithms-CPP` (ignored by git)

## 3. CLI Options & Arguments Reference

| Argument / Option | Type | Default | Purpose |
| :--- | :--- | :--- | :--- |
| `[file_path]` | `string` (optional) | `undefined` | Target a single `.cpp` file to print full line:column diagnostics. |
| *(no arguments)* | `void` | `all` | Scans all `.cpp` files in `search`, `sorting`, `data_structures`, and `strings` directories. |

## 4. Usage Examples

### Full Repository Scan
Scan all algorithm files and print aggregate pass rate:
```bash
bun scripts/scan-algorithms.ts
```

### Single File Diagnostic Inspection
Inspect a specific file for precise error messages and line coordinates:
```bash
bun scripts/scan-algorithms.ts .repos/TheAlgorithms-CPP/data_structures/bloom_filter.cpp
```

## 5. Output Structure & Schema
The script produces console metrics:
- **Total Files**: Count of scanned C++ files.
- **Clean Passes**: Count and percentage of files passing analysis with 0 errors.
- **With Errors**: Count and percentage of files triggering diagnostics.
- **Top Error Patterns**: Grouped frequency table of recurring diagnostics.
- **All Failed Files**: List of failing file paths with their top 3 diagnostic messages.

## 6. Troubleshooting & Edge Cases
- **Missing Repository Directory**: If `.repos/TheAlgorithms-CPP` does not exist, clone it with `git clone --depth 1 https://github.com/TheAlgorithms/C-Plus-Plus.git .repos/TheAlgorithms-CPP`.
- **Missing Sibling Headers**: Standalone test files (`test_queue.cpp`) referencing local relative headers (`./queue.hpp`) trigger `cannot find in the workspace`. This is expected when files are inspected in isolation.
- **Clang-WASM Routed Constructs**: `try/catch/throw` constructs emit informational notices indicating execution routes to clang-wasm. These are expected and reflect the engine's dual-tier architecture.
