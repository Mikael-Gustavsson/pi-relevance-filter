/**
 * Configuration. Defaults live here (source control); machine-specific values come
 * from environment variables or the ignored file ~/.pi/npu-filter/config.json.
 *
 *   PI_NPU_FILTER=1|0               enable/disable (default 0 = Pi unchanged)
 *   PI_NPU_URL=http://127.0.0.1:8765
 *   PI_NPU_MIN_TOKENS=4000          results smaller than this bypass the filter
 *   PI_NPU_KEEP_THRESHOLD=0.70
 *   PI_NPU_MAYBE_THRESHOLD=0.40
 *   PI_NPU_NEIGHBOR_WINDOW=1
 *   PI_NPU_SEVERITY_BOOST=3.0       recall prior for error-marker chunks (0 = off)
 *   PI_NPU_TIMEOUT_MS=1500          base request timeout
 *   PI_NPU_TIMEOUT_PER_100KB_MS=1500  extra timeout per 100 KB of input
 *   PI_NPU_MAX_INPUT_CHARS=2000000  larger results are passed through untouched
 *   PI_NPU_USE_FULL_OUTPUT=1        filter bash's full output file instead of Pi's truncated tail
 *   PI_NPU_HOME=~/.pi/npu-filter    raw-result store, metrics and logs
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface NpuFilterConfig {
	enabled: boolean;
	url: string;
	minTokens: number;
	keepThreshold: number;
	maybeThreshold: number;
	neighborWindow: number;
	severityBoost: number;
	conditionalBudgetTokens: number;
	timeoutMs: number;
	timeoutPer100KbMs: number;
	maxInputChars: number;
	useFullOutput: boolean;
	home: string;
	/** Tools never filtered (our own raw-retrieval tool, mutating tools). */
	bypassTools: string[];
}

export const DEFAULTS: NpuFilterConfig = {
	enabled: false,
	url: "http://127.0.0.1:8765",
	minTokens: 4000,
	keepThreshold: 0.7,
	maybeThreshold: 0.4,
	neighborWindow: 1,
	severityBoost: 3.0,
	conditionalBudgetTokens: 6000,
	timeoutMs: 1500,
	timeoutPer100KbMs: 1500,
	maxInputChars: 2_000_000,
	useFullOutput: true,
	home: join(homedir(), ".pi", "npu-filter"),
	bypassTools: ["get_raw_tool_result", "edit", "write"],
};

const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
const bool = (v: string | undefined, d: boolean) => (v === undefined || v === "" ? d : !["0", "false", "off", "no"].includes(v.toLowerCase()));

export function loadConfig(env: NodeJS.ProcessEnv = process.env): NpuFilterConfig {
	const home = env.PI_NPU_HOME || DEFAULTS.home;
	let file: Partial<NpuFilterConfig> = {};
	const path = join(home, "config.json");
	if (existsSync(path)) {
		try {
			file = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			/* ignore malformed local config: defaults + env still apply */
		}
	}
	const base = { ...DEFAULTS, ...file, home };
	const cfg: NpuFilterConfig = {
		...base,
		enabled: bool(env.PI_NPU_FILTER, base.enabled),
		url: env.PI_NPU_URL || base.url,
		minTokens: num(env.PI_NPU_MIN_TOKENS, base.minTokens),
		keepThreshold: num(env.PI_NPU_KEEP_THRESHOLD, base.keepThreshold),
		maybeThreshold: num(env.PI_NPU_MAYBE_THRESHOLD, base.maybeThreshold),
		neighborWindow: num(env.PI_NPU_NEIGHBOR_WINDOW, base.neighborWindow),
		severityBoost: num(env.PI_NPU_SEVERITY_BOOST, base.severityBoost),
		timeoutMs: num(env.PI_NPU_TIMEOUT_MS, base.timeoutMs),
		timeoutPer100KbMs: num(env.PI_NPU_TIMEOUT_PER_100KB_MS, base.timeoutPer100KbMs),
		maxInputChars: num(env.PI_NPU_MAX_INPUT_CHARS, base.maxInputChars),
		useFullOutput: bool(env.PI_NPU_USE_FULL_OUTPUT, base.useFullOutput),
	};
	// Security: the service must be local.
	const host = new URL(cfg.url).hostname;
	if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
		throw new Error(`PI_NPU_URL must point to localhost, got ${host}`);
	}
	return cfg;
}
