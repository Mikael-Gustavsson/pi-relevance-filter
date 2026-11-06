/** Shared types for Pi Relevance Filter. Service shapes follow relevance_filter/openapi.json (API v1). */

export type Decision = "keep" | "maybe" | "neighbor" | "drop";

export interface FilterChunk {
	/** Offsets in Unicode code points (not UTF-16 units). The extension uses filtered_text instead. */
	start: number;
	end: number;
	line_start: number;
	line_end: number;
	tokens: number;
	logit: number;
	score: number;
	decision: Decision;
}

/** Response of POST /v1/filter. */
export interface FilterResponse {
	api_version: string;
	device: string;
	precision: string;
	model: string;
	infer_ms: number;
	chunk_ms: number;
	total_ms: number;
	batches: number;
	filtered_text: string;
	format: "annotated" | "plain";
	chunks: FilterChunk[];
	total_tokens: number;
	retained_tokens: number;
	retained_chunks: number;
	reduction_pct: number;
}

export interface Limits {
	max_body_bytes: number;
	max_items: number;
	max_text_chars: number;
	recommended_max_text_chars: number;
	time_budget: { base_ms: number; per_100kb_ms: number };
}

/** Response of GET /v1/health (fields used by the extension). */
export interface Health {
	api_version: string;
	service: string;
	device: string;
	precision: string;
	model: string;
	mode_selection: { requested: string; selected: string };
	limits: Limits;
}

export interface PolicyOverrides {
	keep_threshold: number;
	maybe_threshold: number;
	neighbor_window: number;
	severity_boost: number;
	conditional_budget_tokens: number;
}

/** One line in metrics.jsonl. Never contains tool content. */
export interface FilterMetrics {
	ts: string;
	raw_result_id: string;
	tool: string;
	task_hash: string;
	source: "content" | "full-output-file";
	original_chars: number;
	filtered_chars: number;
	original_tokens_est: number;
	filtered_tokens_est: number;
	chunks: number;
	retained_chunks: number;
	reduction_pct: number;
	infer_ms: number;
	service_ms: number;
	total_filter_ms: number;
	device: string;
	precision: string;
	model: string;
}

export interface StoredResult {
	id: string;
	timestamp: string;
	tool: string;
	tool_call_id: string;
	args_hash: string;
	task_hash: string;
	source: "content" | "full-output-file";
	raw: string;
	filter?: Omit<FilterMetrics, "ts" | "raw_result_id" | "tool" | "task_hash" | "source">;
}
