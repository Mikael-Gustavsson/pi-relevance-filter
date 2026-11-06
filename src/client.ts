/** HTTP client for the local Relevance Filter service (API v1). Throws on any problem; caller fails open. */
import { FALLBACK, type RelevanceFilterConfig } from "./config.ts";
import type { FilterResponse, Health, Limits, PolicyOverrides } from "./types.ts";

export class RelevanceClient {
	private readonly cfg: RelevanceFilterConfig;
	/** Limits published by the service (GET /v1/health); undefined until fetched. */
	limits?: Limits;
	health?: Health;
	constructor(cfg: RelevanceFilterConfig) {
		this.cfg = cfg;
	}

	/** Client timeout: explicit env/config values win, then the service's time budget, then FALLBACK. */
	timeoutFor(chars: number): number {
		const base = this.cfg.timeoutMs ?? this.limits?.time_budget.base_ms ?? FALLBACK.timeoutMs;
		const per = this.cfg.timeoutPer100KbMs ?? this.limits?.time_budget.per_100kb_ms ?? FALLBACK.timeoutPer100KbMs;
		return base + Math.ceil(chars / 100_000) * per;
	}

	/** Effective input cap: min(service recommendation, explicit override). */
	maxInputChars(): number {
		const rec = this.limits ? Math.min(this.limits.recommended_max_text_chars, this.limits.max_text_chars) : FALLBACK.maxInputChars;
		return this.cfg.maxInputChars !== undefined ? Math.min(rec, this.cfg.maxInputChars) : rec;
	}

	async fetchHealth(signal?: AbortSignal): Promise<Health> {
		const res = await fetch(`${this.cfg.url}/v1/health`, { signal: combine(signal, this.cfg.timeoutMs ?? FALLBACK.timeoutMs) });
		if (!res.ok) throw new Error(`health HTTP ${res.status}`);
		const h = (await res.json()) as Health;
		if (!h?.limits?.time_budget) throw new Error("health: service does not publish limits (API v1 required)");
		this.health = h;
		this.limits = h.limits;
		return h;
	}

	async filter(query: string, text: string, signal?: AbortSignal): Promise<FilterResponse> {
		const policy: PolicyOverrides = {
			keep_threshold: this.cfg.keepThreshold,
			maybe_threshold: this.cfg.maybeThreshold,
			neighbor_window: this.cfg.neighborWindow,
			severity_boost: this.cfg.severityBoost,
			conditional_budget_tokens: this.cfg.conditionalBudgetTokens,
		};
		const res = await fetch(`${this.cfg.url}/v1/filter`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query, text, policy, format: "annotated" }),
			signal: combine(signal, this.timeoutFor(text.length)),
		});
		if (!res.ok) throw new Error(`filter HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
		const body = (await res.json()) as FilterResponse;
		validate(body, text.length, this.cfg.allowedDevices);
		return body;
	}
}

function combine(signal: AbortSignal | undefined, ms: number): AbortSignal {
	const t = AbortSignal.timeout(ms);
	return signal ? AbortSignal.any([signal, t]) : t;
}

/** Reject anything that could turn into corrupted or empty context. */
export function validate(r: FilterResponse, textLength: number, allowedDevices: string[] = ["NPU"]): void {
	if (!r || !Array.isArray(r.chunks) || r.chunks.length === 0) throw new Error("invalid response: no chunks");
	if (!allowedDevices.includes(r.device)) throw new Error(`service ran on ${r.device}, not allowed (allowed: ${allowedDevices.join(",")})`);
	if (typeof r.filtered_text !== "string" || !r.filtered_text.trim()) throw new Error("invalid response: no filtered_text");
	let prevEnd = 0;
	let kept = 0;
	for (const c of r.chunks) {
		// Offsets are code points; a UTF-16 length is always >= the code-point length, so it is a safe upper bound.
		if (!Number.isInteger(c.start) || !Number.isInteger(c.end) || c.start < prevEnd || c.end <= c.start || c.end > textLength) {
			throw new Error("invalid response: bad chunk offsets");
		}
		if (!["keep", "maybe", "neighbor", "drop"].includes(c.decision)) throw new Error("invalid response: bad decision");
		if (c.decision !== "drop") kept++;
		prevEnd = c.end;
	}
	if (kept === 0) throw new Error("invalid response: nothing retained");
}
