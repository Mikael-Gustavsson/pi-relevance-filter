/** Pure formatting of filtered tool results. No I/O. */
import type { FilterResponse } from "./types.ts";

export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

/** Index of line starts for fast offset -> 1-based line number lookup. */
export function lineIndex(text: string): number[] {
	const starts = [0];
	for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
	return starts;
}

export function lineOf(starts: number[], offset: number): number {
	let lo = 0;
	let hi = starts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (starts[mid] <= offset) lo = mid;
		else hi = mid - 1;
	}
	return lo + 1;
}

export interface FormatInput {
	rawId: string;
	text: string;
	response: FilterResponse;
	totalFilterMs: number;
	sourceNote?: string;
}

export function formatFilteredResult({ rawId, text, response, totalFilterMs, sourceNote }: FormatInput): string {
	const starts = lineIndex(text);
	const chunks = response.chunks;
	const kept = chunks.filter((c) => c.decision !== "drop");
	const body: string[] = [];
	let i = 0;
	while (i < chunks.length) {
		if (chunks[i].decision === "drop") {
			let j = i;
			while (j < chunks.length && chunks[j].decision === "drop") j++;
			const l1 = lineOf(starts, chunks[i].start);
			const l2 = lineOf(starts, Math.max(chunks[i].start, chunks[j - 1].end - 1));
			body.push(`[... ${j - i} chunk${j - i > 1 ? "s" : ""} omitted, lines ${l1}-${l2} ...]`);
			i = j;
			continue;
		}
		// merge consecutive retained chunks into one span
		let j = i;
		while (j + 1 < chunks.length && chunks[j + 1].decision !== "drop") j++;
		const s = chunks[i].start;
		const e = chunks[j].end;
		const l1 = lineOf(starts, s);
		const l2 = lineOf(starts, Math.max(s, e - 1));
		body.push(`[lines ${l1}-${l2}]`);
		body.push(text.slice(s, e).replace(/\s+$/, ""));
		i = j + 1;
	}
	const retainedChars = kept.reduce((n, c) => n + (c.end - c.start), 0);
	const reduction = text.length ? (100 * (1 - retainedChars / text.length)).toFixed(1) : "0.0";
	const header = [
		"[NPU filter]",
		`retained: ${kept.length}/${chunks.length} chunks`,
		`reduction: ${reduction}% (${estimateTokens(text)} -> ${estimateTokens(text.slice(0, retainedChars))} tokens est.)`,
		`raw-result-id: ${rawId}`,
		`inference: ${Math.round(response.npu_ms)}ms on ${response.device} (${response.model}), filter total ${Math.round(totalFilterMs)}ms`,
		...(sourceNote ? [sourceNote] : []),
		`Irrelevant-looking chunks were omitted by a local relevance filter. If something seems missing, call get_raw_tool_result with id "${rawId}" (supports grep, offset, limit) to recover the original output.`,
		"",
	];
	return `${header.join("\n")}\n${body.join("\n")}\n`;
}
