/**
 * Pi Relevance Filter.
 *
 * Intercepts large tool results (tool_result event), persists the raw output locally, sends it to the local
 * Relevance Filter service (python -m relevance_filter; NPU, GPU or CPU) and replaces the tool result content
 * with the service's filtered text plus recovery metadata.
 *
 * Fail-open: any problem returns the ORIGINAL result untouched.
 * Disabled by default: PI_RELEVANCE_FILTER=1 enables it (PI_NPU_FILTER=1 still works, deprecated).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	type ExtensionContext,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { RelevanceClient } from "./client.ts";
import { loadConfig, type RelevanceFilterConfig } from "./config.ts";
import { estimateTokens, formatFilteredResult, HEADER } from "./format.ts";
import { ResultStore, sha256 } from "./result-store.ts";
import type { FilterMetrics } from "./types.ts";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

const NAME = "Relevance filter";
const STATUS_KEY = "relevance-filter";
const HEALTH_RETRY_MS = 30_000;

export default function relevanceFilter(pi: ExtensionAPI) {
	let cfg: RelevanceFilterConfig;
	try {
		cfg = loadConfig();
	} catch (e) {
		// Misconfiguration must not break Pi: stay disabled.
		console.error(`[relevance-filter] disabled: ${(e as Error).message}`);
		return;
	}
	const store = new ResultStore(cfg.home, cfg.legacyHomes);
	const client = new RelevanceClient(cfg);
	let lastTask = "";
	let toolRegistered = false;
	let lastHealthTry = 0;
	const stats = { evaluated: 0, filtered: 0, bypassedSmall: 0, failedOpen: 0, origTokens: 0, keptTokens: 0, inferMs: 0 };
	if (cfg.deprecated.length) store.log(`deprecated variables used: ${cfg.deprecated.join(", ")}`);

	/** Fetch limits from GET /v1/health once (retried at most every 30 s while it fails). */
	const ensureHealth = async (signal?: AbortSignal) => {
		if (client.health || Date.now() - lastHealthTry < HEALTH_RETRY_MS) return client.health;
		lastHealthTry = Date.now();
		try {
			return await client.fetchHealth(signal);
		} catch (e) {
			store.log(`health failed: ${(e as Error).message}`);
			return undefined;
		}
	};

	const statusText = () => {
		const h = client.health;
		if (!h) return `${NAME}: service unreachable (fail-open)`;
		const how = h.mode_selection?.requested === "auto" ? "auto" : "explicit";
		return `${NAME}: on (${h.device} ${how}, ${h.model})`;
	};

	const isBypassed = (tool: string) => cfg.bypassTools.includes(tool);

	const registerRawTool = () => {
		if (toolRegistered) return;
		toolRegistered = true;
		pi.registerTool({
			name: "get_raw_tool_result",
			label: "Raw tool result",
			description:
				"Retrieve the original, unfiltered output of a tool call whose result was shortened by the local relevance filter. " +
				`Use the raw-result-id from the ${HEADER} header. Optional grep (case-insensitive regex) returns only matching lines with line numbers; offset/limit page through lines. Output is limited to ${DEFAULT_MAX_LINES} lines / ${DEFAULT_MAX_BYTES / 1024}KB per call.`,
			promptSnippet: "Recover original tool output that the relevance filter shortened (by raw-result-id)",
			promptGuidelines: [
				`When a tool result starts with ${HEADER}, omitted chunks were judged irrelevant by a small local model; use get_raw_tool_result with its raw-result-id (optionally with grep) if needed evidence may be missing.`,
			],
			parameters: Type.Object({
				id: Type.String({ description: `raw-result-id from the ${HEADER} header (full id or unique prefix)` }),
				grep: Type.Optional(Type.String({ description: "case-insensitive regex; return only matching lines" })),
				offset: Type.Optional(Type.Number({ description: "1-based start line (default 1)" })),
				limit: Type.Optional(Type.Number({ description: `max lines (default ${DEFAULT_MAX_LINES})` })),
			}),
			async execute(_id, params) {
				const rec = store.get(params.id);
				if (!rec) throw new Error(`No stored raw result with id ${params.id}`);
				const lines = rec.raw.split("\n");
				const total = lines.length;
				let numbered = lines.map((l, i) => `${i + 1}: ${l}`);
				if (params.grep) {
					const rx = new RegExp(params.grep, "i");
					numbered = numbered.filter((_, i) => rx.test(lines[i]));
				}
				const offset = Math.max(1, Math.floor(params.offset ?? 1));
				const limit = Math.max(1, Math.min(DEFAULT_MAX_LINES, Math.floor(params.limit ?? DEFAULT_MAX_LINES)));
				const page = numbered.slice(offset - 1, offset - 1 + limit);
				const tr = truncateHead(page.join("\n"), { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
				const shown = tr.outputLines;
				const more = (params.grep ? numbered.length : total) - (offset - 1 + shown);
				const head = `[raw result ${rec.id} | tool=${rec.tool} | ${total} lines${params.grep ? ` | ${numbered.length} matching /${params.grep}/i` : ""} | showing ${shown} from ${params.grep ? "match" : "line"} ${offset}${more > 0 ? ` | ${more} more: use offset=${offset + shown}` : ""}]`;
				return { content: [{ type: "text", text: `${head}\n${tr.content}` }], details: { id: rec.id, total, shown } };
			},
		});
	};

	if (cfg.enabled) registerRawTool();

	pi.on("session_start", async (_e, ctx) => {
		if (!cfg.enabled) return;
		await ensureHealth();
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, statusText());
		if (cfg.deprecated.length) {
			ctx.ui.notify(`${NAME}: deprecated variables ${cfg.deprecated.join(", ")}; rename PI_NPU_* to PI_RELEVANCE_FILTER_*`, "warning");
		}
	});

	pi.on("before_agent_start", async (event) => {
		if (event.messageType === "user" && event.prompt) lastTask = event.prompt;
	});

	const currentTask = (ctx: ExtensionContext): string => {
		if (lastTask) return lastTask;
		try {
			const branch = ctx.sessionManager.getBranch() as Array<{ type: string; message?: { role: string; content: unknown } }>;
			for (let i = branch.length - 1; i >= 0; i--) {
				const m = branch[i].message;
				if (branch[i].type === "message" && m?.role === "user") {
					if (typeof m.content === "string") return m.content;
					if (Array.isArray(m.content)) return m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
				}
			}
		} catch {
			/* fall through */
		}
		return "";
	};

	pi.on("tool_result", async (event, ctx) => {
		if (!cfg.enabled || isBypassed(event.toolName)) return;
		const content = event.content as Content[];
		if (!content.length || content.some((c) => c.type !== "text")) return; // never touch images
		const shown = content.map((c) => (c as { text: string }).text).join("\n");
		// Cheap size gate first: small results cost zero extra work.
		if (estimateTokens(shown) < cfg.minTokens && !fullOutputPath(event)) {
			stats.bypassedSmall++;
			return;
		}
		const t0 = performance.now();
		stats.evaluated++;
		try {
			await ensureHealth(ctx.signal);
			const maxChars = client.maxInputChars();
			// Prefer bash's full output file: Pi's own truncation keeps only the tail.
			let text = shown;
			let source: "content" | "full-output-file" = "content";
			let sourceNote: string | undefined;
			const full = fullOutputPath(event);
			if (cfg.useFullOutput && full && existsSync(full)) {
				if (statSync(full).size <= maxChars) {
					text = readFileSync(full, "utf8");
					source = "full-output-file";
					sourceNote = `source: complete command output (${text.split("\n").length} lines; Pi had truncated it to the tail), full file: ${full}`;
				} else {
					store.log(`full output larger than ${maxChars} chars for ${client.health?.device ?? "service"}; filtering Pi's tail instead`);
				}
			}
			if (text.length > maxChars) throw new Error(`input ${text.length} chars exceeds the limit of ${maxChars} for this device`);
			if (estimateTokens(text) < cfg.minTokens) {
				stats.bypassedSmall++;
				return;
			}
			const task = currentTask(ctx);
			if (!task.trim()) throw new Error("no current task text available");

			const rawId = store.save({
				tool: event.toolName,
				tool_call_id: event.toolCallId,
				args_hash: sha256(JSON.stringify(event.input ?? {})),
				task_hash: sha256(task),
				source,
				raw: text,
			});

			const tReq = performance.now();
			const resp = await client.filter(task, text, ctx.signal);
			const serviceMs = performance.now() - tReq;
			const totalMs = performance.now() - t0;
			const autoSelected = client.health?.mode_selection?.requested === "auto";
			const out = formatFilteredResult({ rawId, text, response: resp, totalFilterMs: totalMs, sourceNote, autoSelected });
			if (!out.trim() || out.length >= text.length) throw new Error("filtered output not smaller than original");

			const m: FilterMetrics = {
				ts: new Date().toISOString(),
				raw_result_id: rawId,
				tool: event.toolName,
				task_hash: sha256(task),
				source,
				original_chars: text.length,
				filtered_chars: out.length,
				original_tokens_est: estimateTokens(text),
				filtered_tokens_est: estimateTokens(out),
				chunks: resp.chunks.length,
				retained_chunks: resp.retained_chunks,
				reduction_pct: Number((100 * (1 - out.length / text.length)).toFixed(1)),
				infer_ms: resp.infer_ms,
				service_ms: Math.round(serviceMs),
				total_filter_ms: Math.round(totalMs),
				device: resp.device,
				precision: resp.precision,
				model: resp.model,
			};
			try {
				store.update(rawId, { filter: { ...m } });
				store.metric(m);
			} catch (e) {
				store.log(`metrics write failed: ${(e as Error).message}`);
			}
			stats.filtered++;
			stats.origTokens += m.original_tokens_est;
			stats.keptTokens += m.filtered_tokens_est;
			stats.inferMs += m.infer_ms;
			if (ctx.hasUI) {
				ctx.ui.notify(
					`${NAME}: ${m.chunks} chunks -> ${m.retained_chunks} | context reduction: ${m.reduction_pct}% | ${m.device}: ${Math.round(m.infer_ms)} ms | raw-result-id: ${rawId.slice(0, 8)}`,
					"info",
				);
			}
			const details = { ...((event.details as object) ?? {}), relevanceFilter: m };
			return { content: [{ type: "text", text: out }], details };
		} catch (e) {
			// FAIL-OPEN: original result passes through untouched.
			stats.failedOpen++;
			const msg = (e as Error).message;
			store.log(`fail-open tool=${event.toolName} reason=${msg}`);
			if (ctx.hasUI) ctx.ui.notify(`${NAME} bypassed (original output kept): ${msg}`, "warning");
			return;
		}
	});

	const command = (deprecatedAlias: boolean) => ({
		description: `${NAME}: status | on | off${deprecatedAlias ? " (deprecated alias of /relevance-filter)" : ""}`,
		handler: async (args: string, ctx: any) => {
			if (deprecatedAlias) ctx.ui.notify("/npu-filter is deprecated; use /relevance-filter", "warning");
			const a = (args || "status").trim().toLowerCase();
			if (a === "on" || a === "off") {
				cfg.enabled = a === "on";
				if (cfg.enabled) {
					registerRawTool();
					await ensureHealth();
				}
				ctx.ui.setStatus(STATUS_KEY, cfg.enabled ? statusText() : undefined);
				ctx.ui.notify(`${NAME} ${cfg.enabled ? "enabled" : "disabled"} for this session`, "info");
				return;
			}
			let health = "unreachable";
			try {
				const h = await client.fetchHealth();
				const tb = h.limits.time_budget;
				health = `${h.device} (${h.mode_selection?.requested === "auto" ? "auto-selected" : "explicit"}) ${h.precision} ${h.model} | budget ${tb.base_ms}+${tb.per_100kb_ms}/100KB ms, max input ${client.maxInputChars()} chars`;
			} catch (e) {
				health = `unreachable (${(e as Error).message})`;
			}
			const red = stats.origTokens ? (100 * (1 - stats.keptTokens / stats.origTokens)).toFixed(1) : "-";
			ctx.ui.notify(
				[
					`${NAME}: ${cfg.enabled ? "ENABLED" : "disabled"} | service ${cfg.url}: ${health}`,
					`evaluated ${stats.evaluated}, filtered ${stats.filtered}, small-bypass ${stats.bypassedSmall}, fail-open ${stats.failedOpen}`,
					`tokens ${stats.origTokens} -> ${stats.keptTokens} (reduction ${red}%), inference total ${Math.round(stats.inferMs)} ms`,
					`store: ${store.dir}`,
				].join("\n"),
				"info",
			);
		},
	});
	pi.registerCommand("relevance-filter", command(false));
	pi.registerCommand("npu-filter", command(true));
}

function fullOutputPath(event: { toolName: string; details?: unknown }): string | undefined {
	const d = event.details as { fullOutputPath?: string } | undefined;
	return typeof d?.fullOutputPath === "string" ? d.fullOutputPath : undefined;
}
