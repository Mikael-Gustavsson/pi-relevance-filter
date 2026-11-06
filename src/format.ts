/** Pure formatting of filtered tool results. No I/O.
 *
 * The service builds the filtered text (retained spans with original line numbers and omission markers),
 * so the extension never does offset arithmetic. It only adds its own header (raw-result id, recovery hint).
 */
import type { FilterResponse } from "./types.ts";

export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

export const HEADER = "[relevance filter]";

export interface FormatInput {
	rawId: string;
	text: string;
	response: FilterResponse;
	totalFilterMs: number;
	sourceNote?: string;
	autoSelected?: boolean;
}

export function formatFilteredResult({ rawId, text, response, totalFilterMs, sourceNote, autoSelected }: FormatInput): string {
	const r = response;
	const header = [
		HEADER,
		`retained: ${r.retained_chunks}/${r.chunks.length} chunks`,
		`reduction: ${r.reduction_pct.toFixed(1)}% (${estimateTokens(text)} -> ${estimateTokens(r.filtered_text)} tokens est.)`,
		`raw-result-id: ${rawId}`,
		`inference: ${Math.round(r.infer_ms)}ms on ${r.device}${autoSelected ? " (auto-selected)" : ""} (${r.model}, ${r.precision}), filter total ${Math.round(totalFilterMs)}ms`,
		...(sourceNote ? [sourceNote] : []),
		`Irrelevant-looking chunks were omitted by a local relevance filter. If something seems missing, call get_raw_tool_result with id "${rawId}" (supports grep, offset, limit) to recover the original output.`,
		"",
	];
	return `${header.join("\n")}\n${r.filtered_text}`;
}
