export type DebugLogger = {
	debug: (message: string, meta?: Record<string, unknown>) => void;
	info: (message: string, meta?: Record<string, unknown>) => void;
	warn: (message: string, meta?: Record<string, unknown>) => void;
	error: (message: string, meta?: Record<string, unknown>) => void;
};

export function createDebugLogger(options: {
	getEnabled: () => boolean;
	prefix: string;
}): DebugLogger {
	const log = (
		level: "debug" | "info" | "warn" | "error",
		message: string,
		meta?: Record<string, unknown>,
	) => {
		if (!options.getEnabled()) return;

		const payload = meta ? [message, meta] : [message];
		// eslint-disable-next-line no-console
		console[level](`[${options.prefix}]`, ...payload);
	};

	return {
		debug: (message, meta) => log("debug", message, meta),
		info: (message, meta) => log("info", message, meta),
		warn: (message, meta) => log("warn", message, meta),
		error: (message, meta) => log("error", message, meta),
	};
}
