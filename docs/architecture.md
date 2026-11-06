# Architecture

The extension is a thin client of the [Relevance Filter](https://github.com/Mikael-Gustavsson/relevance-filter)
service. All scoring, calibration and text selection happen in the service. The extension decides *when* to filter,
keeps the raw result recoverable, and fails open. The contract is the service's
[OpenAPI document](https://github.com/Mikael-Gustavsson/relevance-filter/blob/main/relevance_filter/openapi.json)
(`/v1`), also served at `GET /v1/openapi.json`.

```text
 Pi (frontier model)                                                                   local machine only
 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
 tool call ──► tool execution ──► tool_result event
                                      │
                         src/index.ts
                                      │ disabled? small? image? bypass tool? ──► original (no work)
                                      │ GET /v1/health once: device, limits (time budget, max input)
                                      ├─ prefer bash details.fullOutputPath (Pi kept only the tail), if ≤ max input
                                      ├─ ResultStore.save(raw)  ──► ~/.pi/relevance-filter/results/<uuid>.json
                                      │
                                      └─ POST 127.0.0.1:8765/v1/filter {query: current task, text, policy}
                                                    │
                                                    ▼
                                      Relevance Filter service (separate process and repository)
                                                    │
                                      ◄── filtered_text, chunks (code-point offsets, lines, scores, decisions), timings
                                      │
                         validate (device allowed, filtered_text present, offsets sane, ≥1 chunk kept)
                         format: [relevance filter] header + the service's filtered_text
                                      │
                                      ▼
                               Pi context ──► frontier model
                                      ▲
               get_raw_tool_result(id, grep?, offset?, limit?)  ◄── recovery path
```

## Components (`src/`)

| File | Responsibility |
|---|---|
| `index.ts` | `tool_result` hook, fail-open wrapper, `get_raw_tool_result` tool, `/relevance-filter status\|on\|off` command (alias `/npu-filter`, deprecated), status line and notifications showing the device. |
| `client.ts` | HTTP client for `/v1`. Reads limits from `/v1/health`, computes the timeout from the service's time budget (explicit settings win) and validates responses. |
| `format.ts` | Pure formatter: the extension's header plus the service's `filtered_text`. No offset arithmetic, so code points versus UTF-16 never matter here. |
| `result-store.ts` | Raw-result persistence (reads the legacy `~/.pi/npu-filter` store too), metrics JSONL, extension log. |
| `config.ts` | Defaults, `PI_RELEVANCE_FILTER_*` env (deprecated `PI_NPU_*` aliases), ignored `~/.pi/relevance-filter/config.json`. Refuses non-localhost URLs. |
| `types.ts` | Types for the `/v1` responses the extension reads. |

The policy values the extension sends (`keep_threshold`, `maybe_threshold`, `neighbor_window`, `severity_boost`, …)
are described in the service's
[architecture](https://github.com/Mikael-Gustavsson/relevance-filter/blob/main/docs/architecture.md#relevance-policy).
The service always keeps at least one chunk. The extension still validates this and fails open otherwise.

## Fail-open

Any exception in the extension returns `undefined` from the `tool_result` handler, and Pi then uses the original
result untouched. Causes include:

* the service is down, a timeout or an HTTP error
* an invalid response, or a device that is not allowed
* a failed store write, missing task text, or input above the device's limit.

The reason goes to `~/.pi/relevance-filter/extension.log` and appears as a UI warning, so failures are never hidden.
`tests/extension.test.ts` covers each path.

## Disabling

`PI_RELEVANCE_FILTER` unset or `0` (the default) means the handler returns immediately and
`get_raw_tool_result` is not registered, so the system prompt and tool set match vanilla Pi.
`/relevance-filter off` disables it for the running session.

## Security

* The extension refuses non-localhost service URLs. The service itself binds `127.0.0.1` only.
* Raw results stay in `~/.pi/relevance-filter/results/` (outside any repository).
* The extension log contains sizes, ids, hashes and timings, never content.
* The device that served a request is shown in every header. `PI_RELEVANCE_FILTER_ALLOWED_DEVICES` rejects
  responses from devices you have not accepted (fail-open).
