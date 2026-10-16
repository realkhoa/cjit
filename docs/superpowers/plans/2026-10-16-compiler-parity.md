# C++ Compiler Parity (GCC / Clang 1-1 Features) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement 1-1 compiler parity features from GCC, Clang/LLVM into the Cjit fast engine: Type Traits evaluation, Stream Manipulators (`boolalpha`), `<random>` MT19937 engine and distributions, `<chrono>` clocks and duration casts, `<fstream>` virtual memory file I/O, and GCC/Clang compiler built-in intrinsics.

**Architecture:** Extend Cjit's parser, type resolver (`ctype.ts`), and tree-walk interpreter (`interpreter.ts`) with native C++ standard library structures and runtime evaluators, backed by virtual memory filesystem for I/O and standard deterministic MT19937 PRNG.

**Tech Stack:** TypeScript, Vite, Vitest, Node.js, WebAssembly, C++17 Standard Library semantics.

## Global Constraints

- Strict TDD: Unit test for every feature before implementation.
- Zero regression: All 65 existing test suites (777 tests) must continue to pass.
- Clean build: `npm run build` must succeed with exit code 0.
- Rule 5: 100% Doxygen docstrings on all exported symbols.
- Rule 6: Deterministic code review with zero unresolved violations.
- Rule 7: Vietnamese reporting, English codebase and commit messages.

---

### Task 1: Type Traits Expressions (`<type_traits>`)

**Files:**
- Modify: `src/lang/parser.ts`
- Modify: `src/lang/ctype.ts`
- Modify: `src/lang/runtime/interpreter.ts`
- Test: `tests/typeTraits.test.ts`

**Interfaces:**
- Produces: `is_integral_v<T>`, `is_floating_point_v<T>`, `is_arithmetic_v<T>`, `is_same_v<T, U>`, `is_pointer_v<T>`, `is_void_v<T>`, `is_array_v<T>` evaluated as boolean/integer constants in expressions.

- [x] **Step 1: Write the failing test for type traits**
- [x] **Step 2: Run test to confirm failure**
- [x] **Step 3: Implement type trait token and expression evaluation in interpreter**
- [x] **Step 4: Run test to verify passes cleanly**
- [x] **Step 5: Commit changes**

---

### Task 2: Stream Manipulators (`boolalpha`, `noboolalpha`, formatting)

**Files:**
- Modify: `src/lang/runtime/interpreter.ts`
- Test: `tests/streamManipulators.test.ts`

**Interfaces:**
- Produces: `cout << boolalpha` enables boolean string formatting (`true`/`false`), `noboolalpha` restores numeric `1`/`0`.

- [x] **Step 1: Write the failing test for `boolalpha` and stream manipulators**
- [x] **Step 2: Run test to confirm failure**
- [x] **Step 3: Implement `boolalphaState` flag in interpreter and format boolean values in `streamText`**
- [x] **Step 4: Run test to verify passes cleanly**
- [x] **Step 5: Commit changes**

---

### Task 3: `<random>` Module (MT19937 and Uniform Int Distribution)

**Files:**
- Modify: `src/lang/ctype.ts`
- Modify: `src/lang/runtime/interpreter.ts`
- Test: `tests/random.test.ts`

**Interfaces:**
- Produces: `std::mt19937` PRNG object supporting seed initialization and `rng()` call. `std::uniform_int_distribution<T>` supporting `(min, max)` and `dist(rng)`.

- [x] **Step 1: Write the failing test for `mt19937` and `uniform_int_distribution`**
- [x] **Step 2: Run test to confirm failure**
- [x] **Step 3: Implement Mersenne Twister MT19937 generator and distribution evaluation in interpreter**
- [x] **Step 4: Run test to verify passes cleanly**
- [x] **Step 5: Commit changes**

---

### Task 4: `<chrono>` Module (Clocks, Durations, Duration Casts)

**Files:**
- Modify: `src/lang/ctype.ts`
- Modify: `src/lang/runtime/interpreter.ts`
- Test: `tests/chrono.test.ts`

**Interfaces:**
- Produces: `std::chrono::steady_clock::now()`, time point subtraction `end - start`, `duration_cast<microseconds>`, and `.count()` method.

- [x] **Step 1: Write the failing test for `chrono::steady_clock` and `duration_cast`**
- [x] **Step 2: Run test to confirm failure**
- [x] **Step 3: Implement chrono types, clock helpers, duration arithmetic, and member methods in interpreter**
- [x] **Step 4: Run test to verify passes cleanly**
- [x] **Step 5: Commit changes**

---

### Task 5: `<fstream>` Module & Virtual Memory Filesystem (MemFS)

**Files:**
- Modify: `src/lang/ctype.ts`
- Modify: `src/lang/runtime/interpreter.ts`
- Test: `tests/fstream.test.ts`

**Interfaces:**
- Produces: `std::ofstream`, `std::ifstream`, virtual file write via `<<`, virtual file read via `getline(file, line)`, truthiness check `if (file)`.

- [x] **Step 1: Write the failing test for `ofstream`, `ifstream`, and `getline`**
- [x] **Step 2: Run test to confirm failure**
- [x] **Step 3: Implement virtual file store in interpreter, file stream operators, and `getline` helper**
- [x] **Step 4: Run test to verify passes cleanly**
- [x] **Step 5: Commit changes**

---

### Task 6: GCC & Clang Built-in Intrinsics

**Files:**
- Modify: `src/lang/runtime/interpreter.ts`
- Test: `tests/builtins.test.ts`

**Interfaces:**
- Produces: `__builtin_popcount`, `__builtin_popcountll`, `__builtin_clz`, `__builtin_ctz`, `__builtin_expect`, `__builtin_unreachable`, `__builtin_constant_p`, `__builtin_abs`, `__builtin_bswap16`, `__builtin_bswap32`, `__builtin_bswap64`.

- [x] **Step 1: Write the failing test for compiler built-in functions**
- [x] **Step 2: Run test to confirm failure**
- [x] **Step 3: Implement builtins in `callCppHelper` in interpreter**
- [x] **Step 4: Run test to verify passes cleanly**
- [x] **Step 5: Commit changes**

---

### Task 7: Full 1-1 STL Demo Suite Verification & Build Gate

**Files:**
- Modify: `tests/userStlDemo.test.ts`
- Verify: Full regression test suite (`npm test`)
- Verify: Full TypeScript & Vite build (`npm run build`)
- Review: Static deterministic code review

- [x] **Step 1: Add full `main()` execution test in `tests/userStlDemo.test.ts`**
- [x] **Step 2: Execute full test suite and confirm 100% pass rate**
- [x] **Step 3: Run `npm run build` and confirm exit code 0**
- [x] **Step 4: Run static code review and confirm 0 violations**
- [x] **Step 5: Commit and push changes**
