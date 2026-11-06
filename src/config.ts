/**
 * Configuration of Pi Relevance Filter. Defaults live here (source control); machine-specific values come
 * from environment variables or the ignored file ~/.pi/relevance-filter/config.json.
 *
 *   PI_RELEVANCE_FILTER=1|0                 enable/disable (default 0 = Pi unchanged)
 *   PI_RELEVANCE_FILTER_URL=http://127.0.0.1:8765
 *   PI_RELEVANCE_FILTER_ALLOWED_DEVICES=NPU,GPU,CPU   devices accepted from the service
 *   PI_RELEVANCE_FILTER_MIN_TOKENS=4000     results smaller than this bypass the filter
 *   PI_RELEVANCE_FILTER_KEEP_THRESHOLD=0.70
 *   PI_RELEVANCE_FILTER_MAYBE_THRESHOLD=0.40
 *   PI_RELEVANCE_FILTER_NEIGHBOR_WINDOW=1
 *   PI_RELEVANCE_FILTER_SEVERITY_BOOST=3.0  recall prior for error-marker chunks (0 = off)
 *   PI_RELEVANCE_FILTER_TIMEOUT_MS          base request timeout   (default: service limits.time_budget)
 *   PI_RELEVANCE_FILTER_TIMEOUT_PER_100KB_MS extra timeout / 100 KB (default: service limits.time_budget)
 *   PI_RELEVANCE_FILTER_MAX_INPUT_CHARS     cap on input size      (default: service recommended_max_text_chars)
 *   PI_RELEVANCE_FILTER_USE_FULL_OUTPUT=1   filter bash's full output file instead of Pi's truncated tail
 *   PI_RELEVANCE_FILTER_HOME=~/.pi/relevance-filter   raw-result store, metrics and logs
 *
 * The former PI_NPU_* names still work for one transition release (with a warning).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEVICES = ["NPU", "GPU", "CPU"] as const;

export interface RelevanceFilterConfig {
	enabled: boolean;
	url: string;
	allowedDevices: string[];
	minTokens: number;
	keepThreshold: number;
	maybeThreshold: number;
	neighborWindow: number;
	severityBoost: number;
	conditionalBudgetTokens: number;
	/** Explicit overrides; undefined = use the limits published by the service (or FALLBACK). */
	timeoutMs?: number;
	timeoutPer100KbMs?: number;
	maxInputChars?: number;
	useFullOutput: boolean;
	home: string;
	/** Older store directories searched by get_raw_tool_result (results from earlier sessions). */
	legacyHomes: string[];
	/** Tools never filtered (our own raw-retrieval tool, mutating tools). */
	bypassTools: string[];
	/** Deprecated variable names that were used (shown as a warning). */
	deprecated: string[];
}


/** Used when the service does not publish limits (unreachable or older service). */
export const FALLBACK = { timeoutMs: 1500, timeoutPer100KbMs: 1500, maxInputChars: 2_000_000 };

const LEGACY_HOME = join(homedir(), ".pi", "npu-filter");

export const DEFAULTS: RelevanceFilterConfig = {
	enabled: false,
	url: "http://127.0.0.1:8765",
	allowedDevices: [...DEVICES],
	minTokens: 4000,
	keepThreshold: 0.7,
	maybeThreshold: 0.4,
	neighborWindow: 1,
	severityBoost: 3.0,
	conditionalBudgetTokens: 6000,
	useFullOutput: true,
	home: join(homedir(), ".pi", "relevance-filter"),
	legacyHomes: [LEGACY_HOME],
	bypassTools: ["get_raw_tool_result", "edit", "write"],
	deprecated: [],
};

const num = (v: string | undefined) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
const bool = (v: string | undefined) => (v === undefined || v === "" ? undefined : !["0", "false", "off", "no"].includes(v.toLowerCase()));

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelevanceFilterConfig {
	const deprecated: string[] = [];
	/** Read PI_RELEVANCE_FILTER<suffix>, falling back to the deprecated PI_NPU<suffix>. */
	const get = (suffix: string, legacySuffix = suffix): string | undefined => {
		const v = env[`PI_RELEVANCE_FILTER${suffix}`];
		if (v !== undefined && v !== "") return v;
		const old = env[`PI_NPU${legacySuffix}`];
		if (old !== undefined && old !== "") {
			deprecated.push(`PI_NPU${legacySuffix}`);
			return old;
		}
		return undefined;
	};

	const home = get("_HOME") || DEFAULTS.home;
	let file: Partial<RelevanceFilterConfig> = {};
	for (const dir of [home, LEGACY_HOME]) {
		const path = join(dir, "config.json");
		if (!existsSync(path)) continue;
		try {
			file = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			/* ignore malformed local config: defaults + env still apply */
		}
		break;
	}
	const base: RelevanceFilterConfig = { ...DEFAULTS, ...file, home, legacyHomes: [LEGACY_HOME].filter((h) => h !== home) };
	const devices = get("_ALLOWED_DEVICES");
	const cfg: RelevanceFilterConfig = {
		...base,
		enabled: bool(get("", "_FILTER")) ?? base.enabled,
		url: get("_URL") || base.url,
		allowedDevices: devices ? devices.split(",").map((d) => d.trim().toUpperCase()).filter(Boolean) : base.allowedDevices,
		minTokens: num(get("_MIN_TOKENS")) ?? base.minTokens,
		keepThreshold: num(get("_KEEP_THRESHOLD")) ?? base.keepThreshold,
		maybeThreshold: num(get("_MAYBE_THRESHOLD")) ?? base.maybeThreshold,
		neighborWindow: num(get("_NEIGHBOR_WINDOW")) ?? base.neighborWindow,
		severityBoost: num(get("_SEVERITY_BOOST")) ?? base.severityBoost,
		timeoutMs: num(get("_TIMEOUT_MS")) ?? base.timeoutMs,
		timeoutPer100KbMs: num(get("_TIMEOUT_PER_100KB_MS")) ?? base.timeoutPer100KbMs,
		maxInputChars: num(get("_MAX_INPUT_CHARS")) ?? base.maxInputChars,
		useFullOutput: bool(get("_USE_FULL_OUTPUT")) ?? base.useFullOutput,
		deprecated,
	};
	const unknown = cfg.allowedDevices.filter((d) => !(DEVICES as readonly string[]).includes(d));
	if (unknown.length) throw new Error(`PI_RELEVANCE_FILTER_ALLOWED_DEVICES: unknown device(s) ${unknown.join(", ")}`);
	// Security: the service must be local.
	const host = new URL(cfg.url).hostname;
	if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
		throw new Error(`PI_RELEVANCE_FILTER_URL must point to localhost, got ${host}`);
	}
	return cfg;
}
