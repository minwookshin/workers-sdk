import { convertV4MiniflareOptions, Miniflare, Response } from "miniflare";
import { describe, test, vi } from "vitest";
import { serialiseError } from "../../../api/startDevWorker/events";
import { ProxyController } from "../../../api/startDevWorker/ProxyController";
import { createDeferred } from "../../../api/startDevWorker/utils";
import { FakeBus } from "../../helpers/fake-bus";
import { mockConsoleMethods } from "../../helpers/mock-console";
import type { SerializedError } from "../../../api/startDevWorker/events";

describe("ProxyController", () => {
	mockConsoleMethods();

	test("ProxyWorker error reports preserve message/name/stack across the JSON channel", async ({
		expect,
	}) => {
		// Regression test for https://github.com/cloudflare/workers-sdk/issues/14641:
		// the ProxyWorker's error reports arrive as JSON-serialized plain objects,
		// and used to be re-wrapped in a message-less Error, so the resulting
		// fatal log was an empty `✘ [ERROR]` with no clue about the failure.
		const bus = new FakeBus();
		const controller = new ProxyController(bus);
		const waited = bus.waitFor("error");

		const original = new Error("Network connection lost.");
		const serialized = JSON.parse(
			JSON.stringify(serialiseError(original))
		) as SerializedError;
		controller.onProxyWorkerMessage({ type: "error", error: serialized });

		const event = await waited;
		expect(event.source).toBe("ProxyController");
		expect(event.reason).toBe("Error inside ProxyWorker");
		expect(event.cause).toBeInstanceOf(Error);
		expect(event.cause.message).toBe("Network connection lost.");
		expect(event.cause.stack).toBe(original.stack);
	});

	test("Runtime.exceptionThrown dispatches a typed runtimeError event", async ({
		expect,
	}) => {
		const bus = new FakeBus();
		const controller = new ProxyController(bus);
		const waited = bus.waitFor("runtimeError");
		controller.onInspectorProxyWorkerMessage({
			method: "Runtime.exceptionThrown",
			params: {
				timestamp: 0,
				exceptionDetails: {
					exceptionId: 1,
					text: "Uncaught Error: boom",
					lineNumber: 0,
					columnNumber: 0,
					exception: {
						type: "object",
						subtype: "error",
						description: "Error: boom\n    at fetch (index.js:1:1)",
					},
				},
			},
		});
		const event = await waited;
		expect(event.source).toBe("ProxyController");
		expect(event.text).toBe("Uncaught Error: boom");
		expect(event.stack).toContain("Error: boom");
		expect(event.exceptionDetails?.exceptionId).toBe(1);
	});
});

describe("ProxyController teardown", () => {
	mockConsoleMethods();

	test("finishes an in-flight message before disposing and skips queued messages", async ({
		expect,
	}) => {
		const controller = new ProxyController(new FakeBus());
		const worker = new Miniflare(
			convertV4MiniflareOptions({
				workers: [
					{
						modules: true,
						script:
							"export default {fetch() {return new Response(null, {status: 204})}}",
					},
				],
			})
		);
		controller.proxyWorker = worker;
		controller.emitReadyEvent(worker, await worker.ready, undefined);
		const started = createDeferred<void>();
		const finished = createDeferred<Response>();
		const dispatch = vi
			.spyOn(worker, "dispatchFetch")
			.mockImplementation(() => {
				started.resolve();
				return finished.promise;
			});
		const dispose = vi.spyOn(worker, "dispose");
		const first = controller.sendMessageToProxyWorker({ type: "pause" });
		await started.promise;
		const queued = controller.sendMessageToProxyWorker({ type: "pause" });
		const teardown = controller.teardown();
		try {
			await Promise.resolve();
			expect(dispose).not.toHaveBeenCalled();
		} finally {
			finished.resolve(new Response(null, { status: 204 }));
			await Promise.all([first, queued, teardown]);
		}
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(dispose).toHaveBeenCalledTimes(1);
		await controller.sendMessageToProxyWorker({ type: "pause" });
		expect(dispatch).toHaveBeenCalledTimes(1);
	});

	test("does not wait for initial readiness when tearing down", async ({
		expect,
	}) => {
		const controller = new ProxyController(new FakeBus());
		const message = controller.sendMessageToProxyWorker({ type: "pause" });
		await controller.teardown();
		await expect(message).resolves.toBeUndefined();
	}, 5000);

	test("does not wait for a pending reload when tearing down", async ({
		expect,
	}) => {
		const controller = new ProxyController(new FakeBus());
		const worker = new Miniflare(
			convertV4MiniflareOptions({
				workers: [
					{
						modules: true,
						script:
							"export default {fetch() {return new Response(null, {status: 204})}}",
					},
				],
			})
		);
		const url = await worker.ready;
		controller.proxyWorker = worker;
		controller.emitReadyEvent(worker, url, undefined);
		const pendingReload = createDeferred<URL>();
		const waiting = createDeferred<void>();
		const ready = vi.spyOn(worker, "ready", "get").mockImplementation(() => {
			waiting.resolve();
			return pendingReload.promise;
		});
		const dispatch = vi.spyOn(worker, "dispatchFetch");
		try {
			const message = controller.sendMessageToProxyWorker({ type: "pause" });
			await waiting.promise;
			await controller.teardown();
			await expect(message).resolves.toBeUndefined();
			expect(dispatch).not.toHaveBeenCalled();
		} finally {
			ready.mockRestore();
			pendingReload.resolve(url);
			await worker.dispose();
		}
	}, 5000);
});
