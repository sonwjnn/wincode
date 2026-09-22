import type { RpcResponse } from "./protocol";
import {
	MAX_OUTPUT_BYTES,
	OUTPUT_DRAIN_TIMEOUT_MS,
	type OutputWriter,
	RpcOutputOverflowError,
} from "./types";

type SerializedFrame = {
	encoded: string;
	bytes: number;
	coalescable: boolean;
	started: boolean;
	resolve: () => void;
	reject: (reason?: unknown) => void;
	promise: Promise<void>;
};

export type DeferredNotification = {
	bytes: number;
	coalescable: boolean;
	value: Record<string, unknown>;
};

export class SerializedWriter {
	private pendingBytes = 0;
	private readonly queue: SerializedFrame[] = [];
	private writing = false;
	private idle = Promise.resolve();
	private idleDeferred:
		| {
				promise: Promise<void>;
				resolve: () => void;
		  }
		| undefined;
	private readonly writer: OutputWriter;
	private failure: unknown;

	constructor(writer: OutputWriter) {
		this.writer = writer;
	}
	get bufferedBytes(): number {
		return this.pendingBytes;
	}

	enqueue(
		value: RpcResponse | Record<string, unknown>,
		options: { coalescable?: boolean } = {}
	): Promise<void> {
		if (this.failure !== undefined) {
			return Promise.reject(this.failure);
		}
		let encoded: string;
		try {
			encoded = `${JSON.stringify(value)}\n`;
		} catch {
			return Promise.reject(new Error("RPC frame is not JSON serializable."));
		}
		const bytes = Buffer.byteLength(encoded, "utf8");
		const coalescable = options.coalescable === true;
		const tail = this.queue.at(-1);
		if (coalescable && tail?.coalescable === true && !tail.started) {
			if (this.pendingBytes - tail.bytes + bytes > MAX_OUTPUT_BYTES) {
				return Promise.reject(new RpcOutputOverflowError());
			}
			this.pendingBytes += bytes - tail.bytes;
			tail.bytes = bytes;
			tail.encoded = encoded;
			return tail.promise;
		}
		if (this.pendingBytes + bytes > MAX_OUTPUT_BYTES) {
			return Promise.reject(new RpcOutputOverflowError());
		}
		if (!this.writing && this.queue.length === 0) {
			const deferred = Promise.withResolvers<void>();
			this.idle = deferred.promise;
			this.idleDeferred = deferred;
		}
		const deferred = Promise.withResolvers<void>();
		const frame: SerializedFrame = {
			bytes,
			coalescable,
			encoded,
			promise: deferred.promise,
			reject: deferred.reject,
			resolve: deferred.resolve,
			started: false,
		};
		this.queue.push(frame);
		this.pendingBytes += bytes;
		void this.pump();
		return frame.promise;
	}

	private async pump(): Promise<void> {
		if (this.writing) {
			return;
		}
		this.writing = true;
		try {
			while (this.queue.length > 0) {
				const frame = this.queue.shift();
				if (frame === undefined) {
					break;
				}
				frame.started = true;
				try {
					const ready = this.writer.write(frame.encoded);
					if (ready === false) {
						await this.waitForDrain();
					}
					this.pendingBytes -= frame.bytes;
					frame.resolve();
				} catch (error) {
					const failure =
						error instanceof Error ? error : new Error(String(error));
					this.failure = failure;
					this.pendingBytes -= frame.bytes;
					frame.reject(failure);
					for (const queued of this.queue.splice(0)) {
						this.pendingBytes -= queued.bytes;
						queued.reject(failure);
					}
					break;
				}
			}
		} finally {
			this.writing = false;
			if (this.queue.length === 0) {
				this.idleDeferred?.resolve();
				this.idleDeferred = undefined;
			}
		}
	}
	private async waitForDrain(): Promise<void> {
		const drain = this.writer.drain?.();
		if (drain === undefined) {
			return;
		}
		const timeout = Promise.withResolvers<void>();
		const timer = setTimeout(() => {
			timeout.reject(new Error("RPC output drain timed out."));
		}, OUTPUT_DRAIN_TIMEOUT_MS);
		try {
			await Promise.race([drain, timeout.promise]);
		} finally {
			clearTimeout(timer);
		}
	}

	async drain(): Promise<void> {
		await this.idle;
	}
}
