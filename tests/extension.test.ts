// Run: npm test   (node --test with native TypeScript stripping)
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { RelevanceClient, validate } from "../src/client.ts";
import { loadConfig } from "../src/config.ts";
import { formatFilteredResult } from "../src/format.ts";
import { ResultStore } from "../src/result-store.ts";
import relevanceFilter from "../src/index.ts";

const BIG = Array.from({ length: 3000 }, (_, i) => (i === 1500 ? "ERROR the needle 🚀" : `INFO noise line ${i} 日本`)).join("\n");

/** A /v1/filter response like the service's: chunk offsets in code points, filtered_text built by the service. */
function fakeResponse(text: string, keepIdx: number[] = [1], device = "NPU") {
	const cps = [...text];
	const n = 4;
	const step = Math.ceil(cps.length / n);
	const chunks = Array.from({ length: n }, (_, i) => ({
		start: i * step,
		end: Math.min(cps.length, (i + 1) * step),
		line_start: 1,
		line_end: 1,
		tokens: 100,
		logit: 0,
		score: keepIdx.includes(i) ? 0.9 : 0.1,
		decision: keepIdx.includes(i) ? "keep" : "drop",
	}));
	const filtered_text = keepIdx.length ? `[lines 1-2]\nERROR the needle 🚀\n[... 2 chunks omitted, lines 3-9 ...]\n` : "";
	return {
		api_version: "1.0.0", device, precision: "fp16", model: "fake", infer_ms: 12, chunk_ms: 1, total_ms: 13, batches: 1,
		filtered_text, format: "annotated", chunks, total_tokens: 400, retained_tokens: 100 * keepIdx.length,
		retained_chunks: keepIdx.length, reduction_pct: 100 - 25 * keepIdx.length,
	};
}

const health = (device = "NPU", limits: any = {}) => ({
	api_version: "1.0.0", service: "relevance-filter", status: "ready", device, precision: "fp16", model: "fake",
	mode_selection: { requested: "auto", selected: device, attempts: [] },
	limits: { max_body_bytes: 33554432, max_items: 512, max_text_chars: 2_000_000, recommended_max_text_chars: 2_000_000,
		time_budget: { base_ms: 1500, per_100kb_ms: 1500 }, ...limits },
});

describe("format", () => {
	it("adds the extension header and keeps the service's filtered text verbatim", () => {
		const r = fakeResponse(BIG, [2]);
		const out = formatFilteredResult({ rawId: "abc123", text: BIG, response: r as any, totalFilterMs: 20, autoSelected: true });
		assert.match(out, /^\[relevance filter\]/);
		assert.match(out, /retained: 1\/4 chunks/);
		assert.match(out, /raw-result-id: abc123/);
		assert.match(out, /on NPU \(auto-selected\) \(fake, fp16\)/);
		assert.ok(out.endsWith(r.filtered_text), "service text appended unchanged (no offset arithmetic)");
	});
});

describe("validate", () => {
	it("checks device allow-list, retention, offsets and filtered_text", () => {
		const ok = fakeResponse(BIG);
		assert.doesNotThrow(() => validate(ok as any, BIG.length));
		assert.throws(() => validate({ ...ok, device: "CPU" } as any, BIG.length), /not allowed/);
		assert.doesNotThrow(() => validate({ ...ok, device: "CPU" } as any, BIG.length, ["NPU", "GPU", "CPU"]));
		assert.throws(() => validate(fakeResponse(BIG, []) as any, BIG.length), /filtered_text|nothing retained/);
		assert.throws(() => validate({ ...ok, filtered_text: "" } as any, BIG.length), /filtered_text/);
		assert.throws(() => validate(ok as any, 10), /offsets/);
	});
});

describe("config", () => {
	it("is disabled by default, allows all devices and refuses non-local URLs", () => {
		const home = mkdtempSync(join(tmpdir(), "rf-"));
		const c = loadConfig({ PI_RELEVANCE_FILTER_HOME: home });
		assert.equal(c.enabled, false);
		assert.deepEqual(c.allowedDevices, ["NPU", "GPU", "CPU"]);
		assert.equal(c.timeoutMs, undefined, "timeouts come from the service unless set");
		assert.equal(loadConfig({ PI_RELEVANCE_FILTER_HOME: home, PI_RELEVANCE_FILTER: "1" }).enabled, true);
		assert.throws(() => loadConfig({ PI_RELEVANCE_FILTER_HOME: home, PI_RELEVANCE_FILTER_URL: "http://example.com:8765" }), /localhost/);
		assert.throws(() => loadConfig({ PI_RELEVANCE_FILTER_HOME: home, PI_RELEVANCE_FILTER_ALLOWED_DEVICES: "NPU,TPU" }), /TPU/);
	});
	it("accepts deprecated PI_NPU_* names and reports them", () => {
		const home = mkdtempSync(join(tmpdir(), "rf-"));
		const c = loadConfig({ PI_NPU_HOME: home, PI_NPU_FILTER: "1", PI_NPU_TIMEOUT_MS: "900" });
		assert.equal(c.enabled, true);
		assert.equal(c.home, home);
		assert.equal(c.timeoutMs, 900);
		assert.deepEqual(c.deprecated.sort(), ["PI_NPU_FILTER", "PI_NPU_HOME", "PI_NPU_TIMEOUT_MS"]);
		const n = loadConfig({ PI_RELEVANCE_FILTER_HOME: home, PI_RELEVANCE_FILTER: "1", PI_NPU_FILTER: "0" });
		assert.equal(n.enabled, true, "new name wins");
	});
});

describe("client limits", () => {
	it("derives timeout and input cap from the service, explicit settings win", () => {
		const home = mkdtempSync(join(tmpdir(), "rf-"));
		const c = new RelevanceClient(loadConfig({ PI_RELEVANCE_FILTER_HOME: home }));
		assert.equal(c.timeoutFor(150_000), 1500 + 2 * 1500, "fallback before health");
		c.limits = health("CPU", { recommended_max_text_chars: 100_000, time_budget: { base_ms: 1000, per_100kb_ms: 4000 } }).limits;
		assert.equal(c.timeoutFor(150_000), 1000 + 2 * 4000);
		assert.equal(c.maxInputChars(), 100_000);
		const o = new RelevanceClient(loadConfig({ PI_RELEVANCE_FILTER_HOME: home, PI_RELEVANCE_FILTER_TIMEOUT_MS: "10", PI_RELEVANCE_FILTER_MAX_INPUT_CHARS: "5000" }));
		o.limits = c.limits;
		assert.equal(o.timeoutFor(150_000), 10 + 2 * 4000);
		assert.equal(o.maxInputChars(), 5000);
	});
});

describe("result store", () => {
	it("round-trips raw content, resolves prefixes and finds results in the legacy store", () => {
		const s = new ResultStore(mkdtempSync(join(tmpdir(), "rf-")));
		const id = s.save({ tool: "bash", tool_call_id: "t", args_hash: "a", task_hash: "b", source: "content", raw: BIG });
		assert.equal(s.get(id)?.raw, BIG);
		assert.equal(s.get(id.slice(0, 8))?.raw, BIG);
		assert.equal(s.get("../../etc/passwd"), undefined);
		const legacy = mkdtempSync(join(tmpdir(), "npu-"));
		mkdirSync(join(legacy, "results"));
		const oldId = "0123abcd-0000-4000-8000-000000000000";
		writeFileSync(join(legacy, "results", `${oldId}.json`), JSON.stringify({ id: oldId, raw: "old raw" }));
		const s2 = new ResultStore(mkdtempSync(join(tmpdir(), "rf-")), [legacy]);
		assert.equal(s2.get(oldId)?.raw, "old raw");
		assert.equal(s2.get("0123abcd")?.raw, "old raw");
	});
});

// ---- Extension end-to-end with a fake Pi host and fake/stopped service ----
type Handler = (event: any, ctx: any) => Promise<any>;

function loadExtension(env: Record<string, string>) {
	const saved = { ...process.env };
	for (const k of Object.keys(process.env)) if (k.startsWith("PI_NPU") || k.startsWith("PI_RELEVANCE")) delete process.env[k];
	Object.assign(process.env, env);
	const handlers: Record<string, Handler[]> = {};
	const tools: any[] = [];
	const commands: Record<string, any> = {};
	const notes: string[] = [];
	const status: string[] = [];
	const pi: any = {
		on: (ev: string, h: Handler) => ((handlers[ev] ??= []).push(h), () => {}),
		registerTool: (t: any) => tools.push(t),
		registerCommand: (name: string, c: any) => (commands[name] = c),
	};
	relevanceFilter(pi);
	process.env = saved;
	const ctx = {
		hasUI: true,
		ui: { notify: (m: string) => notes.push(m), setStatus: (_k: string, s: string) => status.push(s) },
		sessionManager: { getBranch: () => [] },
	};
	const emit = async (ev: string, e: any) => {
		let r: any;
		for (const h of handlers[ev] ?? []) r = await h(e, ctx);
		return r;
	};
	return { emit, tools, notes, status, commands, ctx };
}

const toolEvent = (text: string) => ({ type: "tool_result", toolName: "bash", toolCallId: "c1", input: { command: "cat big.log" }, content: [{ type: "text", text }], isError: false, details: undefined });

describe("extension", () => {
	let server: Server;
	let port = 0;
	let mode: "ok" | "invalid" | "slow" = "ok";
	let device = "NPU";
	let limits: any = {};
	let paths: string[] = [];
	before(async () => {
		server = createServer((req, res) => {
			paths.push(req.url ?? "");
			res.setHeader("Content-Type", "application/json");
			if (req.url === "/v1/health") return res.end(JSON.stringify(health(device, limits)));
			let body = "";
			req.on("data", (d) => (body += d));
			req.on("end", () => {
				if (mode === "slow") return setTimeout(() => res.end("{}"), 3000);
				const { text, format } = JSON.parse(body);
				assert.equal(format, "annotated");
				res.end(JSON.stringify(mode === "ok" ? fakeResponse(text, [1, 2], device) : { device, chunks: [] }));
			});
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
		port = (server.address() as any).port;
	});
	after(() => {
		server.closeAllConnections();
		server.close();
	});

	const env = () => ({
		PI_RELEVANCE_FILTER: "1",
		PI_RELEVANCE_FILTER_URL: `http://127.0.0.1:${port}`,
		PI_RELEVANCE_FILTER_HOME: mkdtempSync(join(tmpdir(), "rf-")),
		PI_RELEVANCE_FILTER_TIMEOUT_MS: "500",
		PI_RELEVANCE_FILTER_TIMEOUT_PER_100KB_MS: "0",
	});
	const reset = () => ((mode = "ok"), (device = "NPU"), (limits = {}), (paths = []));

	it("is a no-op when disabled", async () => {
		const x = loadExtension({ ...env(), PI_RELEVANCE_FILTER: "0" });
		assert.equal(x.tools.length, 0, "raw tool not registered when disabled");
		await x.emit("before_agent_start", { messageType: "user", prompt: "find the needle" });
		assert.equal(await x.emit("tool_result", toolEvent(BIG)), undefined);
	});

	it("registers /relevance-filter and the deprecated /npu-filter alias", () => {
		const x = loadExtension(env());
		assert.ok(x.commands["relevance-filter"]);
		assert.match(x.commands["npu-filter"].description, /deprecated/);
	});

	it("bypasses small results", async () => {
		const x = loadExtension(env());
		await x.emit("before_agent_start", { messageType: "user", prompt: "task" });
		assert.equal(await x.emit("tool_result", toolEvent("small output")), undefined);
	});

	it("filters large results with the service's text and keeps raw output recoverable", async () => {
		reset();
		const x = loadExtension(env());
		await x.emit("session_start", {});
		assert.ok(x.status.some((s) => /Relevance filter: on \(NPU auto, fake\)/.test(s)), x.status.join("|"));
		await x.emit("before_agent_start", { messageType: "user", prompt: "find the needle" });
		const r = await x.emit("tool_result", toolEvent(BIG));
		assert.ok(r, "result replaced");
		const out: string = r.content[0].text;
		assert.match(out, /^\[relevance filter\]/);
		assert.ok(out.includes("ERROR the needle 🚀"));
		assert.ok(out.length < BIG.length * 0.7);
		assert.ok(paths.includes("/v1/health") && paths.includes("/v1/filter"));
		assert.equal(r.details.relevanceFilter.device, "NPU");
		const id = /raw-result-id: (\S+)/.exec(out)![1];
		const raw = x.tools.find((t) => t.name === "get_raw_tool_result");
		const got = await raw.execute("x", { id, grep: "needle" });
		assert.match(got.content[0].text, /1501: ERROR the needle/);
		assert.ok(x.notes.some((n) => /Relevance filter: 4 chunks -> 2 .* NPU: 12 ms/.test(n)), x.notes.join("|"));
	});

	it("accepts a CPU service by default and warns about deprecated variables", async () => {
		reset();
		device = "CPU";
		const e = env();
		const x = loadExtension({ PI_NPU_FILTER: "1", PI_NPU_URL: e.PI_RELEVANCE_FILTER_URL, PI_NPU_HOME: e.PI_RELEVANCE_FILTER_HOME });
		await x.emit("session_start", {});
		assert.ok(x.notes.some((n) => /deprecated variables .*PI_NPU_FILTER/.test(n)));
		await x.emit("before_agent_start", { messageType: "user", prompt: "find the needle" });
		const r = await x.emit("tool_result", toolEvent(BIG));
		assert.ok(r, "CPU result accepted");
		assert.match(r.content[0].text, /on CPU \(auto-selected\)/);
	});

	it("respects the input cap published by the service", async () => {
		reset();
		limits = { recommended_max_text_chars: 10_000 };
		const x = loadExtension(env());
		await x.emit("before_agent_start", { messageType: "user", prompt: "find the needle" });
		assert.equal(await x.emit("tool_result", toolEvent(BIG)), undefined);
		assert.ok(x.notes.some((n) => /exceeds the limit of 10000/.test(n)));
	});

	for (const [name, setup] of [
		["service stopped", (e: any) => ({ ...e, PI_RELEVANCE_FILTER_URL: "http://127.0.0.1:1" })],
		["invalid response", (e: any) => ((mode = "invalid"), e)],
		["timeout", (e: any) => ((mode = "slow"), e)],
		["device not allowed", (e: any) => ((device = "GPU"), { ...e, PI_RELEVANCE_FILTER_ALLOWED_DEVICES: "NPU" })],
	] as const) {
		it(`fails open: ${name}`, async () => {
			reset();
			const x = loadExtension(setup(env()));
			await x.emit("before_agent_start", { messageType: "user", prompt: "find the needle" });
			assert.equal(await x.emit("tool_result", toolEvent(BIG)), undefined, "original passes through");
			assert.ok(x.notes.some((n) => /bypassed/.test(n)), "failure is visible, not hidden");
			reset();
		});
	}

	it("fails open when the result store is unwritable", async () => {
		reset();
		const home = join(mkdtempSync(join(tmpdir(), "rf-")), "file");
		writeFileSync(home, "not a dir");
		const x = loadExtension({ ...env(), PI_RELEVANCE_FILTER_HOME: home });
		await x.emit("before_agent_start", { messageType: "user", prompt: "find the needle" });
		assert.equal(await x.emit("tool_result", toolEvent(BIG)), undefined);
	});
});
