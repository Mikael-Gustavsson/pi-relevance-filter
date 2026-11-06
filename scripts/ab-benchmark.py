"""A/B benchmark: Pi vanilla vs Pi + relevance filter on identical synthetic tasks.

Both variants load the same extension; only PI_RELEVANCE_FILTER differs (0 = vanilla).
Each run gets a fresh temp workspace containing ONLY the tool-output file (never
the answer key). Success = all expected keywords appear in Pi's final answer.

    python scripts/ab-benchmark.py --device NPU --model github-copilot/claude-sonnet-5.5 --repeats 2

--device is required: the running service (python -m relevance_filter) must report exactly that device,
so a benchmark never runs on an automatically chosen one.

The cases (tool output + ground truth) come from the Relevance Filter repository: run
`python benchmarks/generate_cases.py` there. --cases-dir defaults to ../relevance-filter/benchmarks/cases
(a sibling checkout) or $RELEVANCE_FILTER_CASES.
Writes benchmarks/results/ab-<timestamp>.json (metrics only, no tool content) and
prints a comparison table.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CASES = os.environ.get("RELEVANCE_FILTER_CASES") or str(ROOT.parent / "relevance-filter" / "benchmarks" / "cases")
FILES ={"logs": "pod.log", "tests": "test-output.txt", "rg": "rg-retry-results.txt", "build": "build.log"}
INTROS = {
    "logs": "Start by running exactly: cat pod.log",
    "tests": "The test runner output is saved in test-output.txt. Start by running exactly: cat test-output.txt",
    "rg": "I already ran `rg -n retry` over the repository; the output is saved in rg-retry-results.txt (the source files themselves are not available). Start by running exactly: cat rg-retry-results.txt",
    "build": "The verbose Maven output is saved in build.log. Start by running exactly: cat build.log",
}


def parse_run(jsonl: str) -> dict:
    usage = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "cost": 0.0}
    turns, tool_chars, filter_ms, filtered, raw_calls, final, errors = 0, 0, 0.0, 0, 0, "", []
    for line in jsonl.splitlines():
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        if e.get("type") != "message_end":
            continue
        m = e["message"]
        if m.get("role") == "assistant":
            turns += 1
            u = m.get("usage") or {}
            for k in ("input", "output", "cacheRead", "cacheWrite"):
                usage[k] += u.get(k, 0)
            usage["cost"] += (u.get("cost") or {}).get("total", 0.0)
            if m.get("stopReason") == "error":
                errors.append((m.get("errorMessage") or "")[:200])
            texts = [c.get("text", "") for c in m.get("content", []) if c.get("type") == "text"]
            if texts:
                final = "\n".join(texts)
        elif m.get("role") == "toolResult":
            tool_chars += sum(len(c.get("text", "")) for c in m.get("content", []) if c.get("type") == "text")
            if m.get("toolName") == "get_raw_tool_result":
                raw_calls += 1
            nf = (m.get("details") or {}).get("relevanceFilter")
            if nf:
                filtered += 1
                filter_ms += nf.get("total_filter_ms", 0)
    return dict(usage=usage, turns=turns, tool_tokens_est=tool_chars // 4, filter_overhead_ms=round(filter_ms),
                filtered_results=filtered, raw_recoveries=raw_calls, final=final, errors=errors,
                frontier_input_tokens=usage["input"] + usage["cacheRead"] + usage["cacheWrite"])


def extension_registered() -> bool:
    settings = Path.home() / ".pi" / "agent" / "settings.json"
    try:
        exts = json.loads(settings.read_text(encoding="utf-8-sig")).get("extensions", [])
    except (OSError, ValueError):
        return False
    me = ROOT.resolve()
    return any(Path(e).resolve() == me for e in exts if isinstance(e, str))


def run_once(case: str, meta: dict, variant: str, model: str, timeout: int, cases_dir: Path) -> dict:
    ws = Path(tempfile.mkdtemp(prefix=f"pi-ab-{case}-"))
    shutil.copy(cases_dir / f"{case}.txt", ws / FILES[case])
    prompt = f"{meta['query']} {INTROS[case]}"
    env = {**os.environ, "PI_RELEVANCE_FILTER": "1" if variant == "filter" else "0"}
    pi = shutil.which("pi") or shutil.which("pi.cmd")
    cmd = [pi, "-p", "--mode", "json", "--no-session", "--model", model]
    if not extension_registered():  # avoid loading the extension twice
        cmd += ["-e", str(ROOT)]
    cmd.append(prompt)
    t0 = time.time()
    try:
        p = subprocess.run(cmd, cwd=ws, env=env, capture_output=True, text=True, encoding="utf-8", timeout=timeout)
        out, rc = p.stdout, p.returncode
    except subprocess.TimeoutExpired as ex:
        out, rc = (ex.stdout or b"").decode("utf-8", "replace") if isinstance(ex.stdout, bytes) else (ex.stdout or ""), -1
    wall = time.time() - t0
    shutil.rmtree(ws, ignore_errors=True)
    r = parse_run(out)
    final_l = r["final"].lower()
    r["success"] = bool(r["final"]) and all(k.lower() in final_l for k in meta["keywords"])
    r.update(case=case, variant=variant, wall_s=round(wall, 1), exit=rc)
    r["final_excerpt"] = r.pop("final")[:400]  # model answer only; synthetic data
    return r


def table(rows: list[dict]) -> str:
    out = []
    hdr = f"{'case':<7}{'variant':<9}{'success':>8}{'frontier_in':>13}{'tool_out':>10}{'turns':>7}{'wall_s':>8}{'cost$':>8}{'filt_ms':>8}{'raw':>5}"
    out.append(hdr)
    for case in FILES:
        for v in ("vanilla", "filter"):
            rs = [r for r in rows if r["case"] == case and r["variant"] == v]
            if not rs:
                continue
            md = lambda k: statistics.median(r[k] for r in rs)  # noqa: E731
            out.append(f"{case:<7}{v:<9}{sum(r['success'] for r in rs):>5}/{len(rs):<2}"
                       f"{md('frontier_input_tokens'):>13.0f}{md('tool_tokens_est'):>10.0f}{md('turns'):>7.0f}"
                       f"{md('wall_s'):>8.1f}{statistics.median(r['usage']['cost'] for r in rs):>8.3f}"
                       f"{md('filter_overhead_ms'):>8.0f}{md('raw_recoveries'):>5.0f}")
    return "\n".join(out)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", required=True, type=str.upper, choices=["NPU", "GPU", "CPU"])
    ap.add_argument("--url", default="http://127.0.0.1:8765")
    ap.add_argument("--model", default="github-copilot/claude-sonnet-5.5")
    ap.add_argument("--repeats", type=int, default=2)
    ap.add_argument("--cases", default=",".join(FILES))
    ap.add_argument("--cases-dir", default=DEFAULT_CASES, help="directory with <case>.txt/.json from relevance-filter")
    ap.add_argument("--timeout", type=int, default=900)
    args = ap.parse_args()
    cases_dir = Path(args.cases_dir)
    if not (cases_dir / "logs.json").exists():
        print(f"FAIL: no cases in {cases_dir}; run `python benchmarks/generate_cases.py` in relevance-filter or pass --cases-dir")
        return 1
    try:
        h = json.load(urllib.request.urlopen(f"{args.url}/v1/health", timeout=3))
        assert h["device"] == args.device, f"service runs on {h['device']}, not {args.device}"
    except Exception as e:  # noqa: BLE001
        print(f"FAIL: relevance filter service not healthy on {args.device}: {e}")
        return 1
    rows = []
    out = ROOT / "benchmarks" / "results" / f"ab-{time.strftime('%Y%m%d-%H%M%S')}.json"
    for rep in range(args.repeats):
        for case in args.cases.split(","):
            meta = json.loads((cases_dir / f"{case}.json").read_text(encoding="utf-8"))
            for variant in (("vanilla", "filter") if rep % 2 == 0 else ("filter", "vanilla")):
                r = run_once(case, meta, variant, args.model, args.timeout, cases_dir)
                rows.append(r)
                print(f"[{rep + 1}/{args.repeats}] {case:<6} {variant:<8} success={r['success']!s:<5} "
                      f"in={r['frontier_input_tokens']:>7} tool={r['tool_tokens_est']:>6} turns={r['turns']:>2} "
                      f"wall={r['wall_s']:>6}s filter={r['filter_overhead_ms']}ms raw={r['raw_recoveries']}"
                      f"{' ERR ' + r['errors'][0] if r['errors'] else ''}", flush=True)
                out.write_text(json.dumps({"model": args.model, "device": args.device, "health": h, "rows": rows}, indent=2), encoding="utf-8")
    print()
    print(table(rows))
    print(f"\nsaved {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
