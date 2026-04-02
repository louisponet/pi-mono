export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	bashTool,
	bashToolDefinition,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.js";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
	editTool,
	editToolDefinition,
} from "./edit.js";
export { withFileMutationQueue } from "./file-mutation-queue.js";
export { FileReadTracker } from "./file-read-tracker.js";
export {
	createFindTool,
	createFindToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
	findTool,
	findToolDefinition,
} from "./find.js";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
	grepTool,
	grepToolDefinition,
} from "./grep.js";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
	lsTool,
	lsToolDefinition,
} from "./ls.js";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
	readTool,
	readToolDefinition,
} from "./read.js";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.js";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
	writeTool,
	writeToolDefinition,
} from "./write.js";

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ToolDefinition } from "../extensions/types.js";
import {
	type BashToolOptions,
	bashTool,
	bashToolDefinition,
	createBashTool,
	createBashToolDefinition,
} from "./bash.js";
import { createEditTool, createEditToolDefinition, editTool, editToolDefinition } from "./edit.js";
import type { FileReadTracker } from "./file-read-tracker.js";
import { createFindTool, createFindToolDefinition, findTool, findToolDefinition } from "./find.js";
import { createGrepTool, createGrepToolDefinition, grepTool, grepToolDefinition } from "./grep.js";
import { createLsTool, createLsToolDefinition, lsTool, lsToolDefinition } from "./ls.js";
import {
	createReadTool,
	createReadToolDefinition,
	type ReadToolOptions,
	readTool,
	readToolDefinition,
} from "./read.js";
import { createWriteTool, createWriteToolDefinition, writeTool, writeToolDefinition } from "./write.js";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;

export const codingTools: Tool[] = [readTool, bashTool, editTool, writeTool];
export const readOnlyTools: Tool[] = [readTool, grepTool, findTool, lsTool];

export const allTools = {
	read: readTool,
	bash: bashTool,
	edit: editTool,
	write: writeTool,
	grep: grepTool,
	find: findTool,
	ls: lsTool,
};

export const allToolDefinitions = {
	read: readToolDefinition,
	bash: bashToolDefinition,
	edit: editToolDefinition,
	write: writeToolDefinition,
	grep: grepToolDefinition,
	find: findToolDefinition,
	ls: lsToolDefinition,
};

export type ToolName = keyof typeof allTools;

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	/** Shared file read tracker for read-before-edit enforcement */
	fileReadTracker?: FileReadTracker;
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	const tracker = options?.fileReadTracker;
	return [
		createReadToolDefinition(cwd, { ...options?.read, fileReadTracker: tracker }),
		createBashToolDefinition(cwd, options?.bash),
		createEditToolDefinition(cwd, { fileReadTracker: tracker }),
		createWriteToolDefinition(cwd, { fileReadTracker: tracker }),
	];
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createGrepToolDefinition(cwd),
		createFindToolDefinition(cwd),
		createLsToolDefinition(cwd),
	];
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	const tracker = options?.fileReadTracker;
	return {
		read: createReadToolDefinition(cwd, { ...options?.read, fileReadTracker: tracker }),
		bash: createBashToolDefinition(cwd, options?.bash),
		edit: createEditToolDefinition(cwd, { fileReadTracker: tracker }),
		write: createWriteToolDefinition(cwd, { fileReadTracker: tracker }),
		grep: createGrepToolDefinition(cwd),
		find: createFindToolDefinition(cwd),
		ls: createLsToolDefinition(cwd),
	};
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	const tracker = options?.fileReadTracker;
	return [
		createReadTool(cwd, { ...options?.read, fileReadTracker: tracker }),
		createBashTool(cwd, options?.bash),
		createEditTool(cwd, { fileReadTracker: tracker }),
		createWriteTool(cwd, { fileReadTracker: tracker }),
	];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [createReadTool(cwd, options?.read), createGrepTool(cwd), createFindTool(cwd), createLsTool(cwd)];
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	const tracker = options?.fileReadTracker;
	return {
		read: createReadTool(cwd, { ...options?.read, fileReadTracker: tracker }),
		bash: createBashTool(cwd, options?.bash),
		edit: createEditTool(cwd, { fileReadTracker: tracker }),
		write: createWriteTool(cwd, { fileReadTracker: tracker }),
		grep: createGrepTool(cwd),
		find: createFindTool(cwd),
		ls: createLsTool(cwd),
	};
}
