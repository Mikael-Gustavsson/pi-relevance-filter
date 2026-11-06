# Pi Relevance Filter

[![tests](https://github.com/Mikael-Gustavsson/pi-relevance-filter/actions/workflows/tests.yml/badge.svg)](https://github.com/Mikael-Gustavsson/pi-relevance-filter/actions/workflows/tests.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> **Status: experiment.** The extension is off by default and fails open: if anything breaks, Pi gets the
> original tool output. The measurements come from synthetic benchmark data, not real repositories.

An extension for [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) that sends large tool results
through a local [Relevance Filter](https://github.com/Mikael-Gustavsson/relevance-filter) service, so only the
relevant chunks reach the frontier model. The raw output stays recoverable through `get_raw_tool_result`.

The service is a separate project. It scores chunks with a small cross-encoder on the NPU, GPU or CPU and never
generates text. This extension is one of its clients and talks to it only through its versioned HTTP API (`/v1`).

## Quick start (Windows, PowerShell)

1. Install and start the service, following its
   [README](https://github.com/Mikael-Gustavsson/relevance-filter#quick-start-windows-powershell). It listens on
   `127.0.0.1:8765` and picks the device automatically (NPU → GPU → CPU).
2. Set up this extension:

```powershell
.\scripts\setup.ps1          # npm install, typecheck, register in ~/.pi/agent/settings.json, check the service

$env:PI_RELEVANCE_FILTER="1"
pi
```

On Linux or macOS use `scripts/setup.sh`.

Turn the filter off without uninstalling anything:

```powershell
$env:PI_RELEVANCE_FILTER="0"     # or unset; default is OFF
pi
```

Inside Pi, `/relevance-filter status` shows the device, how it was chosen, the time budget and session statistics.
`/relevance-filter on|off` toggles the filter for the current session.

`get_raw_tool_result(id, grep?, offset?, limit?)` lets the frontier model recover anything that was dropped.

## Practical use: when the filter makes a difference

The filter helps when **one tool call returns a large, mostly irrelevant output, and the task needs only a
small part of it**. Typical cases are a failing build, a long test run, pod logs, or a broad `rg` search.
There are two effects:

1. **Less frontier context.** Only the relevant chunks reach the expensive model.
2. **The whole output is considered.** Pi's `bash` tool normally keeps only the last 50 KB / 2000 lines.
   The extension sends bash's full output file and the service selects relevant chunks from *all* of it. The
   frontier model then usually answers after the first command instead of running follow-up `grep`s.

### Measured examples (NPU)

These four tasks come from the A/B benchmark. Each is 2 runs per variant, with the frontier model
`claude-sonnet-5.5` and synthetic but realistic data from the service's case generator. Each prompt ends with
"Start by running exactly: `cat <file>`" so both variants see identical tool output. Details and method:
[`docs/ab-benchmark.md`](docs/ab-benchmark.md).

| Example prompt | Tool output | Frontier input tokens, vanilla → filter | Turns | Cost $ | Filter overhead | Correct answer |
|---|---|---|---|---|---|---|
| *"The Maven build fails. Explain why and which file must be fixed."* | `cat build.log`: 164 KB verbose Maven log, one compile error | 57 908 → **10 742 (−81 %)** | 3 → 2 | 0.077 → 0.022 | 1.2 s | 2/2 → 2/2 |
| *"The CI test run fails. Which tests fail and why?"* | `cat test-output.txt`: 169 KB, ~2 300 passing tests, 2 failures | 55 431 → **13 816 (−75 %)** | 3 → 2 | 0.073 → 0.031 | 1.0 s | 2/2 → 2/2 |
| *"The payment-service pods never become Ready in OpenShift. Determine the root cause from the logs."* | `cat pod.log`: 300 KB OpenShift log, one TLS/DB failure buried in noise | 80 602 → **37 876 (−53 %)** | 4 → 2 | 0.094 → 0.092 | 2.2 s | 2/2 → 2/2 |
| *"Where is the retry backoff for the payment gateway HTTP client configured, and what are the effective values?"* | `rg -n retry` output: 48 KB, ~600 hits, 4 relevant | 25 821 → **14 427 (−44 %)** | 2 → 3 | 0.068 → 0.021 | 0.4 s | 2/2 → 2/2 |

How to read the results:

* **Build and test failures benefit most.** The useful part is a few lines in a sea of `[INFO] Downloaded …`
  or `PASSED` lines. Reduction is about 90 % per call, and cost drops by roughly 60–70 %.
* **Logs:** the token saving comes mostly from fewer turns. The filtered result (≈15 k tokens) is about the
  size of vanilla's truncated tail, so cost per run is roughly the same. The filter does guarantee that the
  relevant events are taken from the entire log, not only its end.
* **Search results:** the frontier model sometimes calls `get_raw_tool_result` once to check context (2 → 3 turns).
  Even so, it reads far less and costs about a third.
* **On GPU or CPU** the service's filtering decisions are practically the same (100 % recall in the same cases).
  The overhead differs: on the reference machine the GPU is about twice as fast as the NPU, and the CPU about
  4× slower. See the service's
  [per-device results](https://github.com/Mikael-Gustavsson/relevance-filter/blob/main/docs/benchmark.md#per-device-results).

### What the frontier model actually sees (build example)

Pi's notification line:

```text
Relevance filter: 389 chunks -> 24 | context reduction: 93.3% | NPU: 1098 ms | raw-result-id: 67bf1cbf
```

The tool result handed to the model, 11 KB instead of 164 KB (raw-result id shortened):

```text
[relevance filter]
retained: 24/389 chunks
reduction: 94.0% (41025 -> 2482 tokens est.)
raw-result-id: 67bf1cbf-…
inference: 1098ms on NPU (auto-selected) (ms-marco-MiniLM-L-6-v2, fp16), filter total 1212ms
Irrelevant-looking chunks were omitted by a local relevance filter. If something seems missing, call
get_raw_tool_result with id "67bf1cbf-…" (supports grep, offset, limit) to recover the original output.

[... 29 chunks omitted, lines 1-91 ...]
…
[... 20 chunks omitted, lines 1048-1106 ...]
[lines 1107-1128]
[INFO] --- maven-compiler-plugin:3.13.0:compile (default-compile) @ shop-billing ---
[INFO] Compiling 87 source files with javac [debug release 21] to target/classes
[WARNING] /work/shop-billing/src/main/java/se/example/billing/LegacyExport.java:[12,8] [deprecation] …
[ERROR] COMPILATION ERROR :
[ERROR] /work/shop-billing/src/main/java/se/example/billing/InvoiceMapper.java:[44,31] cannot find symbol
  symbol:   method getAmountCents()
  location: variable line of type se.example.orders.OrderLine
[INFO] 1 error
…
[... 7 chunks omitted, lines 1129-1156 ...]
[lines 1157-1165]
[INFO] shop-billing ......................................... FAILURE
[INFO] BUILD FAILURE
```

Everything from the empty line onwards is the service's `filtered_text` (format `annotated`). The extension adds
only the header. Measured with version 0.1, when the header was still `[NPU filter]`; the content is unchanged.
With this input, Pi answered in 2 turns. Its answer (summarised) said the build fails in `shop-billing` because
`InvoiceMapper.java` line 44 calls `OrderLine.getAmountCents()`, which does not exist.

### Other prompts where it should help (not benchmarked)

These follow the same pattern (large output, narrow question) but have **not** been measured:

* *"Why is order-service crash-looping?"* → `oc logs deploy/order-service --since=2h`, `kubectl get events -A`
* *"Which integration tests fail in the nightly run and what is the first error?"* → `mvn -B verify`, `gradle test --info`, `dotnet test -v n`
* *"Where is the JWT expiry configured?"* → `rg -n -i expir` over a large monorepo
* *"Which resources in this subscription lack the `owner` tag?"* → large JSON from `az resource list`
* *"Why does the Docker build fail?"* → `docker build --progress=plain .`

### When it does *not* help, or should be turned off

* **Small outputs** (under ~4 000 tokens, e.g. `git status`, short file reads) bypass the filter. The
  check costs no extra work.
* **Tasks that need the whole output**, such as "summarise this file", "count the warnings", or editing a large
  source file that Pi read with `read`. The filter keeps only relevant chunks, so the model sees part of
  the file. Use `/relevance-filter off` for such sessions, or rely on `get_raw_tool_result`.
* **Very large outputs** cost time: on the NPU about 0.85 s per 100 KB, on the GPU about 0.4 s and on the CPU
  about 3.5–4 s. On the CPU the service therefore recommends at most 100 KB. Larger full-output files fall back to
  filtering Pi's own 50 KB tail.

### Try it yourself

Generate the synthetic cases in your checkout of the service, then:

```powershell
mkdir $env:TEMP\rf-demo; copy <relevance-filter>\benchmarks\cases\build.txt $env:TEMP\rf-demo\build.log
cd $env:TEMP\rf-demo

$env:PI_RELEVANCE_FILTER="1"; pi "The Maven build fails. Explain why and which file must be fixed. Start by running exactly: cat build.log"
$env:PI_RELEVANCE_FILTER="0"; pi "The Maven build fails. Explain why and which file must be fixed. Start by running exactly: cat build.log"
```

Compare token usage in Pi's footer, or check `~/.pi/relevance-filter/metrics.jsonl` for per-call reduction and
inference time. To repeat the full comparison, see [`docs/ab-benchmark.md`](docs/ab-benchmark.md#reproduce).

## Configuration

Defaults are in `src/config.ts`. Machine-specific overrides go in environment variables or
`~/.pi/relevance-filter/config.json`. Limits and time budgets come from the service's `/v1/health` unless set here.
The service's own settings are described in its
[integrator guide](https://github.com/Mikael-Gustavsson/relevance-filter/blob/main/docs/service.md#configuration).

| Variable | Default | Meaning |
|---|---|---|
| `PI_RELEVANCE_FILTER` | `0` | `1` enables the filter |
| `PI_RELEVANCE_FILTER_URL` | `http://127.0.0.1:8765` | service URL (must be localhost) |
| `PI_RELEVANCE_FILTER_ALLOWED_DEVICES` | `NPU,GPU,CPU` | devices accepted from the service; set `NPU` to accept only the NPU |
| `PI_RELEVANCE_FILTER_MIN_TOKENS` | `4000` | smaller results bypass the filter (chars/4 estimate) |
| `PI_RELEVANCE_FILTER_KEEP_THRESHOLD` | `0.70` | calibrated score to KEEP |
| `PI_RELEVANCE_FILTER_MAYBE_THRESHOLD` | `0.40` | calibrated score for CONDITIONAL (kept while 6000-token budget lasts) |
| `PI_RELEVANCE_FILTER_NEIGHBOR_WINDOW` | `1` | keep ±N neighbours of very-high chunks |
| `PI_RELEVANCE_FILTER_SEVERITY_BOOST` | `3.0` | recall prior for chunks with error markers (0 = pure model) |
| `PI_RELEVANCE_FILTER_TIMEOUT_MS` | from the service | base timeout (fail-open on expiry) |
| `PI_RELEVANCE_FILTER_TIMEOUT_PER_100KB_MS` | from the service | added timeout per 100 KB input |
| `PI_RELEVANCE_FILTER_MAX_INPUT_CHARS` | from the service | larger inputs pass through unfiltered (the service's recommendation caps it) |
| `PI_RELEVANCE_FILTER_USE_FULL_OUTPUT` | `1` | filter bash's full output file rather than Pi's truncated tail |
| `PI_RELEVANCE_FILTER_HOME` | `~/.pi/relevance-filter` | raw results, metrics, logs |

The former `PI_NPU_*` names and the `/npu-filter` command still work for one transition release. Pi shows a
warning when they are used.

The extension does not send a bearer token, so run the service without `RELEVANCE_FILTER_TOKEN_FILE`.

## Data locations

| Path | Content |
|---|---|
| `~/.pi/relevance-filter/results/<uuid>.json` | raw tool output and metadata (uuid, timestamp, tool, args hash, task hash, filter metrics) |
| `~/.pi/relevance-filter/metrics.jsonl` | one line per filtered call: sizes, chunk counts, reduction, timings, device (no content) |
| `~/.pi/relevance-filter/extension.log` | fail-open reasons (no content) |
| `~/.pi/npu-filter/results/` | results from earlier versions; still readable by `get_raw_tool_result` |

## Repository layout

```text
src/        the extension (TypeScript, loaded by Pi via jiti): index, client, format, result-store, config, types
tests/      extension.test.ts: client, formatting, store, the tool_result hook and every fail-open path (fake service)
scripts/    setup.ps1, setup.sh, ab-benchmark.py (Pi vanilla vs Pi + filter)
benchmarks/ results/ (A/B metrics only, no tool content)
docs/       architecture.md, ab-benchmark.md
```

## Tests

```powershell
npm test
npx tsc --noEmit -p .
python scripts\ab-benchmark.py --device NPU --repeats 2   # needs the running service, its cases and a Pi login
```

## History

Until 2026-11 the extension and the service lived in one repository (`pi-npu-context-filter`, later renamed
`relevance-filter`). The extension's history was carried over to this repository. The original assignment and the
specification of the split service are in the service repository
([`SPEC.md`](https://github.com/Mikael-Gustavsson/relevance-filter/blob/main/SPEC.md),
[`docs/evaluation-filter-service.md`](https://github.com/Mikael-Gustavsson/relevance-filter/blob/main/docs/evaluation-filter-service.md)).

## License

[MIT](LICENSE) © 2026 Mikael Gustavsson
