/** HTTP client for the local NPU inference service. Throws on any problem; caller fails open. */
import type { NpuFilterConfig } from "./config.ts";
import type { FilterResponse, PolicyOverrides } from "./types.ts";

export class NpuClient {
	private readonly cfg: NpuFilterConfig;
	constructor(cfg: NpuFilterConfig) {
		this.cfg = cfg;
	}

	timeoutFor(chars: number): number {
		return this.cfg.timeoutMs + Math.ceil(chars / 100_000) * this.cfg.timeoutPer100KbMs;
	}

	async health(signal?: AbortSignal): Promise<Record<string, unknown>> {
		const res = await fetch(`${this.cfg.url}/health`, { signal: combine(signal, this.cfg.timeoutMs) });
		if (!res.ok) throw new Error(`health HTTP ${res.status}`);
		return (await res.json()) as Record<string, unknown>;
	}

	async filter(query: string, text: string, signal?: AbortSignal): Promise<FilterResponse> {
		const policy: PolicyOverrides = {
			keep_threshold: this.cfg.keepThreshold,
			maybe_threshold: this.cfg.maybeThreshold,
			neighbor_window: this.cfg.neighborWindow,
			severity_boost: this.cfg.severityBoost,
			conditional_budget_tokens: this.cfg.conditionalBudgetTokens,
		};
		const res = await fetch(`${this.cfg.url}/filter`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query, text, policy }),
			signal: combine(signal, this.timeoutFor(text.length)),
		});
		if (!res.ok) throw new Error(`filter HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
		const body = (await res.json()) as FilterResponse;
		validate(body, text.length);
		return body;
	}
}

function combine(signal: AbortSignal | undefined, ms: number): AbortSignal {
	const t = AbortSignal.timeout(ms);
	return signal ? AbortSignal.any([signal, t]) : t;
}

/** Reject anything that could turn into corrupted or empty context. */
export function validate(r: FilterResponse, textLength: number): void {
	if (!r || !Array.isArray(r.chunks) || r.chunks.length === 0) throw new Error("invalid response: no chunks");
	if (r.device !== "NPU") throw new Error(`service ran on ${r.device}, not NPU`);
	let prevEnd = 0;
	let kept = 0;
	for (const c of r.chunks) {
		if (!Number.isInteger(c.start) || !Number.isInteger(c.end) || c.start < prevEnd || c.end <= c.start || c.end > textLength) {
			throw new Error("invalid response: bad chunk offsets");
		}
		if (!["keep", "maybe", "neighbor", "drop"].includes(c.decision)) throw new Error("invalid response: bad decision");
		if (c.decision !== "drop") kept++;
		prevEnd = c.end;
	}
	if (kept === 0) throw new Error("invalid response: nothing retained");
}
