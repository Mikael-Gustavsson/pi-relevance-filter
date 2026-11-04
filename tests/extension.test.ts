// Run: cd extension && npm test   (node --test with native TypeScript stripping)
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { validate } from "../extension/src/client.ts";
import { loadConfig } from "../extension/src/config.ts";
import { formatFilteredResult, lineIndex, lineOf } from "../extension/src/format.ts";
import { ResultStore } from "../extension/src/result-store.ts";
import npuFilter from "../extension/src/index.ts";

const BIG = Array.from({ length: 3000 }, (_, i) => (i === 1500 ? "ERROR the needle" : `INFO noise line ${i}`)).join("\n");

function fakeResponse(text: string, keepIdx: number[] = [1]) {
	const n = 4;
	const step = Math.ceil(text.length / n);
	const chunks = Array.from({ length: n }, (_, i) => ({
		start: i * step,
		end: Math.min(text.length, (i + 1) * step),
		tokens: 100,
		logit: 0,
		score: keepIdx.includes(i) ? 0.9 : 0.1,
		decision: keepIdx.includes(i) ? "keep" : "drop",
	}));
	return { device: "NPU", model: "fake", npu_ms: 12, chunk_ms: 1, total_ms: 13, batches: 1, chunks, total_tokens: 400, retained_tokens: 100, retained_chunks: keepIdx.length, reduction_pct: 75 };
}

describe("format", () => {
	it("maps offsets to line numbers", () => {
		const s = lineIndex("a\nb\nc");
		assert.equal(lineOf(s, 0), 1);
		assert.equal(lineOf(s, 2), 2);
		assert.equal(lineOf(s, 4), 3);
	});
	it("keeps retained chunks verbatim and marks gaps", () => {
		const r = fakeResponse(BIG, [2]);
		const out = formatFilteredResult({ rawId: "abc123", text: BIG, response: r as any, totalFilterMs: 20 });
		assert.match(out, /^\[NPU filter\]/);
		assert.match(out, /retained: 1\/4 chunks/);
		assert.match(out, /raw-result-id: abc123/);
		assert.match(out, /chunks? omitted, lines/);
		const kept = BIG.slice(r.chunks[2].start, r.chunks[2].end).trimEnd();
		assert.ok(out.includes(kept));
	});
});

describe("validate", () => {
	it("rejects non-NPU device, empty retention and bad offsets", () => {
		const ok = fakeResponse(BIG);
		assert.doesNotThrow(() => validate(ok as any, BIG.length));
		assert.throws(() => validate({ ...ok, device: "CPU" } as any, BIG.length), /not NPU/);
		assert.throws(() => validate(fakeResponse(BIG, []) as any, BIG.length), /nothing retained/);
		assert.throws(() => validate(ok as any, 10), /offsets/);
	});
});

describe("config", () => {
	it("is disabled by default and refuses non-local URLs", () => {
		const home = mkdtempSync(join(tmpdir(), "npu-"));
		assert.equal(loadConfig({ PI_NPU_HOME: home }).enabled, false);
		assert.equal(loadConfig({ PI_NPU_HOME: home, PI_NPU_FILTER: "1" }).enabled, true);
		assert.throws(() => loadConfig({ PI_NPU_HOME: home, PI_NPU_URL: "http://example.com:8765" }), /localhost/);
	});
});

describe("result store", () => {
	it("round-trips raw content and resolves prefixes", () => {
		const s = new ResultStore(mkdtempSync(join(tmpdir(), "npu-")));
		const id = s.save({ tool: "bash", tool_call_id: "t", args_hash: "a", task_hash: "b", source: "content", raw: BIG });
		assert.equal(s.get(id)?.raw, BIG);
		assert.equal(s.get(id.slice(0, 8))?.raw, BIG);
		assert.equal(s.get("../../etc/passwd"), undefined);
	});
});

// ---- Extension end-to-end with a fake Pi host and fake/stopped service ----
type Handler = (event: any, ctx: any) => Promise<any>;

function loadExtension(env: Record<string, string>) {
	const saved = { ...process.env };
	Object.assign(process.env, env);
	const handlers: Record<string, Handler[]> = {};
	const tools: any[] = [];
	const notes: string[] = [];
	const pi: any = {
		on: (ev: string, h: Handler) => ((handlers[ev] ??= []).push(h), () => {}),
		registerTool: (t: any) => tools.push(t),
		registerCommand: () => {},
	};
	npuFilter(pi);
	process.env = saved;
	const ctx = { hasUI: true, ui: { notify: (m: string) => notes.push(m), setStatus: () => {} }, sessionManager: { getBranch: () => [] } };
	const emit = async (ev: string, e: any) => {
		let r: any;
		for (const h of handlers[ev] ?? []) r = await h(e, ctx);
		return r;
	};
	return { emit, tools, notes };
}

const toolEvent = (text: string) => ({ type: "tool_result", toolName: "bash", toolCallId: "c1", input: { command: "cat big.log" }, content: [{ type: "text", text }], isError: false, details: undefined });

describe("extension", () => {
	let server: Server;
	let port = 0;
	let mode: "ok" | "invalid" | "slow" = "ok";
	before(async () => {
		server = createServer((req, res) => {
			let body = "";
			req.on("data", (d) => (body += d));
			req.on("end", () => {
				if (mode === "slow") return setTimeout(() => res.end("{}"), 3000);
				const { text } = JSON.parse(body);
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify(mode === "ok" ? fakeResponse(text, [1, 2]) : { device: "NPU", chunks: [] }));
			});
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
		port = (server.address() as any).port;
	});
	after(() => {
		server.closeAllConnections();
		server.close();
	});

	const env = () => ({ PI_NPU_FILTER: "1", PI_NPU_URL: `http://127.0.0.1:${port}`, PI_NPU_HOME: mkdtempSync(join(tmpdir(), "npu-")), PI_NPU_TIMEOUT_MS: "500", PI_NPU_TIMEOUT_PER_100KB_MS: "0" });

	it("is a no-op when disabled", async () => {
		const x = loadExtension({ ...env(), PI_NPU_FILTER: "0" });
		assert.equal(x.tools.length, 0, "raw tool not registered when disabled");
		await x.emit("before_agent_start", { messageType: "user", prompt: "find the needle" });
		assert.equal(await x.emit("tool_result", toolEvent(BIG)), undefined);
	});

	it("bypasses small results", async () => {
		const x = loadExtension(env());
		await x.emit("before_agent_start", { messageType: "user", prompt: "task" });
		assert.equal(await x.emit("tool_result", toolEvent("small output")), undefined);
	});

	it("filters large results and raw output is recoverable", async () => {
		mode = "ok";
		const x = loadExtension(env());
		await x.emit("before_agent_start", { messageType: "user", prompt: "find the needle" });
		const r = await x.emit("tool_result", toolEvent(BIG));
		assert.ok(r, "result replaced");
		const out: string = r.content[0].text;
		assert.match(out, /^\[NPU filter\]/);
		assert.ok(out.length < BIG.length * 0.7);
		const id = /raw-result-id: (\S+)/.exec(out)![1];
		const raw = x.tools.find((t) => t.name === "get_raw_tool_result");
		const got = await raw.execute("x", { id, grep: "needle" });
		assert.match(got.content[0].text, /1501: ERROR the needle/);
		assert.ok(x.notes.some((n) => /NPU filter: 4 chunks -> 2/.test(n)));
	});

	for (const [name, setup] of [
		["service stopped", (e: any) => ({ ...e, PI_NPU_URL: "http://127.0.0.1:1" })],
		["invalid response", (e: any) => ((mode = "invalid"), e)],
		["timeout", (e: any) => ((mode = "slow"), e)],
	] as const) {
		it(`fails open: ${name}`, async () => {
			const x = loadExtension(setup(env()));
			await x.emit("before_agent_start", { messageType: "user", prompt: "find the needle" });
			assert.equal(await x.emit("tool_result", toolEvent(BIG)), undefined, "original passes through");
			assert.ok(x.notes.some((n) => /bypassed/.test(n)), "failure is visible, not hidden");
			mode = "ok";
		});
	}

	it("fails open when the result store is unwritable", async () => {
		const home = join(mkdtempSync(join(tmpdir(), "npu-")), "file");
		writeFileSync(home, "not a dir");
		const x = loadExtension({ ...env(), PI_NPU_HOME: home });
		await x.emit("before_agent_start", { messageType: "user", prompt: "find the needle" });
		assert.equal(await x.emit("tool_result", toolEvent(BIG)), undefined);
	});
});
