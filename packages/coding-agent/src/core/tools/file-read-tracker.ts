import { resolve } from "path";

/**
 * Tracks which files have been read during the current session.
 * Used by edit and write tools to enforce read-before-write safety.
 *
 * Inspired by OpenClaude's readFileState pattern — prevents blind edits
 * by requiring that a file is read before it can be modified.
 */
export class FileReadTracker {
	private readonly _readFiles = new Map<string, { timestamp: number; partial: boolean }>();
	private readonly _cwd: string;

	constructor(cwd: string) {
		this._cwd = cwd;
	}

	/** Record that a file has been read. */
	recordRead(filePath: string, partial: boolean = false): void {
		const absolutePath = this._resolve(filePath);
		const existing = this._readFiles.get(absolutePath);
		// A full read upgrades a partial read, but not the reverse
		if (existing && !existing.partial && partial) {
			return;
		}
		this._readFiles.set(absolutePath, { timestamp: Date.now(), partial });
	}

	/** Check if a file has been read. Returns null if read, or a warning message if not. */
	checkRead(filePath: string): string | null {
		const absolutePath = this._resolve(filePath);
		if (this._readFiles.has(absolutePath)) {
			return null;
		}
		return `Warning: ${filePath} has not been read yet in this session. Read it first to understand its content before editing. Proceeding anyway.`;
	}

	/** Check if a file has been fully read (not just a partial/offset read). */
	hasFullRead(filePath: string): boolean {
		const absolutePath = this._resolve(filePath);
		const entry = this._readFiles.get(absolutePath);
		return !!entry && !entry.partial;
	}

	/** Clear all tracking data (e.g. on session reset). */
	clear(): void {
		this._readFiles.clear();
	}

	private _resolve(filePath: string): string {
		return resolve(this._cwd, filePath);
	}
}
