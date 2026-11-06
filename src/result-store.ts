/**
 * Raw-result store. Every filtered tool result is persisted in full BEFORE filtering,
 * so filtering is always reversible via get_raw_tool_result(id).
 *
 * Layout (outside Git):  <home>/results/<uuid>.json
 *                        <home>/metrics.jsonl      (measurements only, no content)
 *                        <home>/extension.log      (reasons for fail-open, no content)
 */
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FilterMetrics, StoredResult } from "./types.ts";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

export class ResultStore {
	readonly dir: string;
	readonly home: string;
	/** Older result directories, searched read-only by get() (e.g. ~/.pi/npu-filter/results). */
	readonly legacyDirs: string[];

	constructor(home: string, legacyHomes: string[] = []) {
		this.home = home;
		this.dir = join(home, "results");
		this.legacyDirs = legacyHomes.map((h) => join(h, "results"));
	}

	private ensure() {
		mkdirSync(this.dir, { recursive: true });
	}

	save(r: Omit<StoredResult, "id" | "timestamp">): string {
		this.ensure();
		const id = randomUUID();
		const rec: StoredResult = { id, timestamp: new Date().toISOString(), ...r };
		writeFileSync(join(this.dir, `${id}.json`), JSON.stringify(rec), { encoding: "utf8", flag: "wx" });
		return id;
	}

	update(id: string, patch: Partial<StoredResult>): void {
		const rec = this.lookup(this.dir, id);
		if (!rec) return;
		writeFileSync(join(this.dir, `${id}.json`), JSON.stringify({ ...rec, ...patch }), "utf8");
	}

	/** Accepts a full UUID or a unique prefix (>= 6 chars). Searches the current store, then legacy stores. */
	get(idOrPrefix: string): StoredResult | undefined {
		for (const dir of [this.dir, ...this.legacyDirs]) {
			const rec = this.lookup(dir, idOrPrefix);
			if (rec) return rec;
		}
		return undefined;
	}

	private lookup(dir: string, idOrPrefix: string): StoredResult | undefined {
		const id = idOrPrefix.trim().toLowerCase();
		if (!/^[0-9a-f-]{6,36}$/.test(id) || !existsSync(dir)) return undefined;
		let file = join(dir, `${id}.json`);
		if (!existsSync(file)) {
			const matches = readdirSync(dir).filter((f) => f.startsWith(id) && f.endsWith(".json"));
			if (matches.length !== 1) return undefined;
			file = join(dir, matches[0]);
		}
		return JSON.parse(readFileSync(file, "utf8")) as StoredResult;
	}

	metric(m: FilterMetrics): void {
		mkdirSync(this.home, { recursive: true });
		appendFileSync(join(this.home, "metrics.jsonl"), `${JSON.stringify(m)}\n`, "utf8");
	}

	log(msg: string): void {
		try {
			mkdirSync(this.home, { recursive: true });
			appendFileSync(join(this.home, "extension.log"), `${new Date().toISOString()} ${msg}\n`, "utf8");
		} catch {
			/* logging must never break Pi */
		}
	}
}
