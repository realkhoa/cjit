# Handover — C/C++ Studio (`realkhoa/cjit`)

Written for the next agent. Everything below was true at commit `97e29f4` (branch `main`, working tree clean,
deployed). Read this first, then `README.md` for the user-facing story.

---

## 1. What this is, and where it stands

A **client-only** C/C++ web IDE (no backend): Monaco editor on the left, live variable values on the right,
console below, VS 2022 dark theme. Two engines:

- **fast engine** (`src/lang/**`): the engine that always feeds the Watch pane (1 s debounce). It is the
  simulator this handover is mostly about.
- **clang-wasm** (`src/lang/clang/**` + `src/worker/clang.worker.ts`): real clang 8 + lld, used only for **Run**.

| | |
|---|---|
| Live | https://realkhoa.github.io/cjit/ |
| Deploy | GitHub Actions → Pages (`worktree main`, `enablement: true`) |
| Tests | **724 passing, 58 files** (`npm test`) |
| Typecheck / build | both clean (`npm run typecheck`, `npm run build`) |
| Last deploy | CI green, `index-aXOFXXco.js` |

## 2. The active goal (this is the job)

Goal id `goal-a246128b-5413-4e1b-8690-9530f8df3f13`, still **active**:

> Make the fast engine behave like a native C++ compiler: valid C++ (clang accepts) must parse and run
> correctly, and what clang rejects must be rejected too — never accept something and return a wrong value.
> Each feature: implement + automated test + clean typecheck/build + push + green CI + live verification +
> **deploy immediately after the feature**, then report honestly (say what is verified and what is not).

**Invariants that are not negotiable**

1. **Never invent a value.** Refusing loudly ("not supported") is always better than a plausible wrong number.
   This is the reason the conformance corpus exists.
2. The **fast engine is always the Watch pane's engine**; only Run uses clang.
3. Client-only, no backend; the toolchain in IndexedDB (see §6).
4. Mobile layout below 880 px must keep working (`tests/mobileLayout.test.tsx`).
5. **Deploy after every feature** (the user asked for this explicitly).

## 3. The workflow per feature (do exactly this)

```powershell
# 1. work, then:
npm run typecheck              # must print 0
npm test                       # must be all green
npm run build                  # app + service worker
# 2. commit (see the quoting trap in §8) and push
git -c core.safecrlf=false commit -q -m "Title" -m "Paragraph..." -m "Tests: ..."
git push
# 3. CI + live
$gh = 'C:\Program Files\GitHub CLI\gh.exe'          # NOT on PATH
$id = & $gh run list --limit 1 --json databaseId --jq '.[0].databaseId'
& $gh run watch $id --exit-status
# 4. verify the deployed bundle actually contains the new behaviour (grep a literal string)
$r = Invoke-WebRequest 'https://realkhoa.github.io/cjit/' -UseBasicParsing
```

Then report: what was implemented, what the evidence is, **and what is still missing or unverified**.

## 4. The conformance corpus — use it as the work list

`tests/conformance/corpus.ts` holds complete C++ programs with the exact stdout clang produces. Each case is
either:

- `support: 'fast'` — the fast engine must produce **exactly** that output (not "contains", not "similar").
- `support: 'clang-only'` — a **known gap**. The rule is absolute: the fast engine may **refuse** it, but it may
  **never print something else**. A gap that starts passing makes its own test fail with
  *"now matches a native compiler — move it to support: 'fast'"*; that is the signal to promote it.

Two suites run it:

- `tests/conformance.test.ts` — drives every case through the fast engine (exact equality for `fast`, honest
  failure for gaps).
- `tests/conformanceVsClang.test.ts` — runs the `fast` cases through the **real clang+lld toolchain** and
  compares. This is the strongest evidence that "fast ≈ native". It is **skipped when `public/toolchain` is
  missing**, which is the case in CI, so **run it locally** (`npm run toolchain` first if needed). It has
  already caught **8 wrong expectations written by me** where the engine was right.

Current state: **45 `fast` cases**, 1 gap left:

| Gap | What is missing |
|---|---|
| `function overloading` | two functions with one name; the engine refuses loudly instead of guessing |

## 5. What is done (goal features 1–10)

| # | Feature | Tests | Notes |
|---|---|---|---|
| 1 | `using` declarations | `tests/usingDeclarations.test.ts` | also fixed an integer literal truncating to 32 bits, and a typedef losing "stringness" |
| 2 | Conformance corpus | `tests/conformance*.test.ts` | 39 fast + gaps |
| 3 | References `int&` / `const T&` | `tests/references.test.ts` | parameters, locals, `const`, refuse temporary for non-const |
| 4 | Namespaces | `tests/namespaces.test.ts` | blocks, qualified names, nested, `using namespace X` |
| 5 | Classes, methods, `this`, access | `tests/classes.test.ts` | class = struct + default private; access enforced both ways |
| 6 | Ctor/dtor, operator overloading, default args | `tests/classFeatures.test.ts` | destructors run at scope exit in reverse |
| 7 | Lambdas, captures, `std::function` | `tests/lambdas.test.ts` | `[x]`, `[&x]`, `[=]`, `[&]`; lambdas as values |
| 8 | `new`/`delete`, `std::sort` with a comparator, **class templates** | `tests/classTemplates.test.ts` + corpus | templates: several instantiations, two parameters, a container member, a self-referential pointer. **Methods of a class template are not supported** and warn |
| 9 | Range-for over initializer lists | `tests/cpp.test.ts` + corpus | `for (int v : {1, 2, 3})`, typed or auto/reference |
| 10 | `std::stringstream` / `std::ostringstream` | corpus | `out << text << int; out.str()`; shared buffer layout with std::string |

Other shipped work (from earlier rounds, all deployed): projects (several in one workspace, each with its own
files, recoverable project trash, `cjit.files.v3` with v1/v2 migration), data safety (file trash, non-destructive
example opening, share-link merge, JSON backup export/import, loud save-failure warning), `#pragma once` by
default, new files without `main`, entry-point selection for Run, Memory tab (pointer chains + hex dump),
Runtime issues tab, artifact download, PWA (manifest, icons, service worker, install/update UI).

## 6. Architecture map (what to open for what)

```
src/lang/
  lexer.ts token.ts          tokens
  preprocessor.ts            #include (workspace + built-in headers), macros, #pragma once
  parser.ts                  the big one: declarations, expressions, `using`, namespaces,
                             classes/methods/ctors/dtors, lambdas, new/delete, templates
  ast.ts                     node shapes (Declaration / Statement / Expression unions)
  ctype.ts                   the type system + TypeResolver (containers, std::function, tags,
                             typedefs, class templates would go here)
  analyze.ts                 preprocess + parse, returns diagnostics + unit
  runtime/
    interpreter.ts           evaluator: values, scopes, bindings (incl. `reference`),
                             containers, closures, methods, ctors/dtors, operators
    memory.ts value.ts container.ts
  clang/                     real compiler path (runtime.ts, toolchainCache.ts, diagnostics.ts)
src/worker/clang.worker.ts   Run in a worker (toolchain cached in IndexedDB)
src/state/                   store.ts (all app actions), fileStore.ts, projectStore.ts,
                             persistence.ts (v3 + migration), workspaceBackup.ts
src/ui/                      Explorer, EditorPane, WatchPane, ConsolePanel, Toolbar, StatusBar, SettingsDialog
src/pwa/                     cachePolicy.ts (pure, tested), serviceWorker.ts, register.ts, installState.ts
src/examples/sample.ts       the bundled default project (see the trap in §8)
public/                      manifest.webmanifest, icons/, toolchain/ (gitignored, ~58 MB)
tests/                       one file per feature; tests/conformance/ is the corpus
```

## 7. How the two engines are verified

- Fast engine: unit tests over `analyzeSource` + `execute` (see any `tests/*.test.ts`).
- Clang: `tests/clangRuntime.test.ts` drives the real wasm toolchain in Node against `public/toolchain`.
- Both: `tests/conformanceVsClang.test.ts` compares the corpus.

## 8. Traps that cost me time — read these

1. **Backticks inside template literals in `src/examples/sample.ts`.** That file is one big template literal;
   writing `` `T` `` inside a code comment terminates the string and breaks the build. I did it **four times**.
   No backticks, no `${` inside those samples.
2. **A keyword can be intercepted in several places.** `new`/`delete` failed until I removed three separate
   guards (`detectUnsupportedConstruct`, an expression-position guard, and the identifier branch of
   `parsePrimaryExpression`, which accepts keywords as names). When adding a keyword, grep for it everywhere.
3. **Diagnostics live in two places.** Parse problems are in `analyzeSource(...).diagnostics`; things the
   interpreter raises are in `executionResult.diagnostics`. Checking the wrong one makes a test lie.
4. **`parseParameterList()` expects `(` already consumed**, as does its use in function declarations.
5. **Aggregate values are addresses, not copies.** A by-value capture needed an explicit byte copy; anything
   similar (assignment from a struct, containers) will share storage unless you copy.
6. **Commits in PowerShell**: pass several single-line `-m` flags. A `"` inside a `-m "..."` truncates the
   message silently. Use `git -c core.safecrlf=false commit`.
7. **`gh` is not on PATH** — it is at `C:\Program Files\GitHub CLI\gh.exe`.
8. **The clang comparison test is skipped in CI** (no toolchain). Local runs are the evidence; say so in reports.
9. The clang run channel appends one `\n` after the program's own output; the comparison test drops exactly one.
10. `std::cout` uses C++'s default 6-significant-digit float formatting (`formatDefaultFloat`) — do not "fix" it
    back to raw doubles.

## 9. Honest status: what is *not* done

- **Methods of a class template** (`Box<T>::get()`): the instantiation carries data members only; using a
  method warns once and then fails visibly rather than returning an object that quietly lacks it.
- **Function overloading**, **stringstream** (the two remaining corpus gaps).
- Beyond the corpus: **reference return types** (`int& f()`), **member-form operators**
  (`Number Number::operator+`), **`operator<<` for user types**, **out-of-class method definitions**,
  **`const`/`static` methods**, **inheritance/virtual**, `mutable` lambdas, default member initialisers in a
  class (`int value = 0;`), deep copy of container captures (`vector<string>` shares its element buffer),
  template specialisation, and class templates as *parameters* of other templates.
- The fast engine is **not** a native compiler yet; it is converging on the corpus one feature at a time.

## 10. Quick start for the next agent

```powershell
cd E:\sourcecode\cjit
npm install            # if node_modules is missing
npm test               # expect 723 passing
npx vitest run tests/conformance.test.ts        # the work list
npm run toolchain      # only if public/toolchain is missing (58 MB) - enables the clang comparison
npx vitest run tests/conformanceVsClang.test.ts # the authority on what clang prints
```

Pick the next feature (class template is the largest remaining value), implement, test, deploy, and **report
what you verified and what you did not** — the user reads these reports closely and checks the claims.
