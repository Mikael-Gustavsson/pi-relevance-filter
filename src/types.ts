/** Shared types for the Pi NPU context filter extension. */

export type Decision = "keep" | "maybe" | "neighbor" | "drop";

export interface FilterChunk {
	start: number;
	end: number;
	tokens: number;
	logit: number;
	score: number;
	decision: Decision;
}

/** Response of POST /filter on the local inference service. */
export interface FilterResponse {
	device: string;
	model: string;
	npu_ms: number;
	chunk_ms: number;
	total_ms: number;
	batches: number;
	chunks: FilterChunk[];
	total_tokens: number;
	retained_tokens: number;
	retained_chunks: number;
	reduction_pct: number;
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
	npu_ms: number;
	service_ms: number;
	total_filter_ms: number;
	device: string;
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
