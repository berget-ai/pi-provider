import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createStreamInterceptor, handleAuthErrorAndRetry, readStreamToController } from '../index';

// Mock ModelRuntime at module level so we can control refreshBergetAuthToken paths
vi.mock('@earendil-works/pi-coding-agent', async () => {
  const actual = await vi.importActual<typeof import('@earendil-works/pi-coding-agent')>(
    '@earendil-works/pi-coding-agent',
  );
  return {
    ...actual,
    ModelRuntime: {
      create: vi.fn(),
    },
  };
});

// We'll need to import the mocked module later to configure it
async function getMockModelRuntime() {
  const mod = await import('@earendil-works/pi-coding-agent');
  return mod.ModelRuntime as unknown as { create: ReturnType<typeof vi.fn> };
}

describe('Stream Interceptor', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEnvironment: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnvironment = { ...process.env };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnvironment;
    vi.clearAllMocks();
  });

  // --- Issue 1: Stream hang on failed auth retry ---

  test('stream errors (does not hang) when auth refresh returns null', async () => {
    {
      const ModelRuntime = await getMockModelRuntime();
      ModelRuntime.create.mockResolvedValue({
        getAuth: vi.fn().mockImplementation(() => Promise.resolve()),
      });
    }

    const authErrorChunk = new TextEncoder().encode(
      'data: {"error":{"message":"Invalid token","type":"authentication_error"}}\n\n',
    );

    const streamFn = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(authErrorChunk);
            controller.close();
          },
        }),
        { status: 200 },
      ),
    );

    const interceptor = createStreamInterceptor(streamFn);
    const response = await interceptor(
      new Request('https://api.berget.ai/v1/chat/completions'),
      'test-key',
    );

    const reader = response.body!.getReader();
    await expect(readAllChunks(reader)).rejects.toThrow('Authentication failed');
  });

  test('stream errors (does not hang) when retry response has no body', async () => {
    {
      const ModelRuntime = await getMockModelRuntime();
      ModelRuntime.create.mockResolvedValue({
        getAuth: vi
          .fn()
          .mockImplementation(() => Promise.resolve({ auth: { apiKey: 'stored-access-token' } })),
      });
    }

    const authErrorChunk = new TextEncoder().encode(
      'data: {"error":{"message":"Invalid token","type":"authentication_error"}}\n\n',
    );

    let firstCall = true;
    const streamFn = vi.fn().mockImplementation(() => {
      if (firstCall) {
        firstCall = false;
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(authErrorChunk);
                controller.close();
              },
            }),
            { status: 200 },
          ),
        );
      }
      // retry response has no body
      return Promise.resolve(new Response(null, { status: 200 }));
    });

    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({ expires_in: 300, token: 'new-access-token' }, { status: 200 }),
      );

    const interceptor = createStreamInterceptor(streamFn);
    const response = await interceptor(
      new Request('https://api.berget.ai/v1/chat/completions'),
      'test-key',
    );

    const reader = response.body!.getReader();
    await expect(readAllChunks(reader)).rejects.toThrow('Authentication failed');
  });

  test('original reader is cancelled before entering retry path', async () => {
    {
      const ModelRuntime = await getMockModelRuntime();
      ModelRuntime.create.mockResolvedValue({
        getAuth: vi.fn().mockImplementation(() => Promise.resolve()),
      });
    }

    const cancelMock = vi.fn();
    const authErrorChunk = new TextEncoder().encode(
      'data: {"error":{"message":"Invalid token","type":"authentication_error"}}\n\n',
    );

    const streamFn = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          cancel: cancelMock,
          start(controller) {
            // enqueue but DO NOT close — simulate a live stream
            controller.enqueue(authErrorChunk);
          },
        }),
        { status: 200 },
      ),
    );

    const interceptor = createStreamInterceptor(streamFn);
    const response = await interceptor(
      new Request('https://api.berget.ai/v1/chat/completions'),
      'test-key',
    );

    try {
      const reader = response.body!.getReader();
      await readAllChunks(reader);
    } catch {
      // expected
    }

    expect(cancelMock).toHaveBeenCalled();
  });

  // --- Issue 2: Auth error chunk lost on retry failure ---

  test('error message includes original auth error chunk when retry fails', async () => {
    {
      const ModelRuntime = await getMockModelRuntime();
      ModelRuntime.create.mockResolvedValue({
        getAuth: vi.fn().mockImplementation(() => Promise.resolve()),
      });
    }

    const authErrorText =
      'data: {"error":{"message":"Invalid token","type":"authentication_error"}}\n\n';
    const authErrorChunk = new TextEncoder().encode(authErrorText);

    const streamFn = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(authErrorChunk);
            controller.close();
          },
        }),
        { status: 200 },
      ),
    );

    const interceptor = createStreamInterceptor(streamFn);
    const response = await interceptor(
      new Request('https://api.berget.ai/v1/chat/completions'),
      'test-key',
    );

    const reader = response.body!.getReader();
    await expect(readAllChunks(reader)).rejects.toThrow(authErrorText);
  });

  // --- Issue 10: readStreamToController robustness ---

  test('readStreamToController errors controller when enqueue throws', async () => {
    const sourceStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('hello'));
        controller.close();
      },
    });

    const reader = sourceStream.getReader();

    let errorCalled = false;
    let errorArg: unknown;

    const controller = {
      close: vi.fn(),
      enqueue: vi.fn().mockImplementation(() => {
        throw new Error('backpressure error');
      }),
      error: vi.fn((e: unknown) => {
        errorCalled = true;
        errorArg = e;
      }),
    } as unknown as ReadableStreamDefaultController<Uint8Array>;

    await readStreamToController(reader, controller);

    expect(errorCalled).toBe(true);
    expect(errorArg).toBeInstanceOf(Error);
    expect((errorArg as Error).message).toBe('backpressure error');
    expect(controller.close).not.toHaveBeenCalled();
  });

  test('readStreamToController closes controller normally when stream ends', async () => {
    const sourceStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('hello'));
        controller.close();
      },
    });

    const reader = sourceStream.getReader();

    const controller = {
      close: vi.fn(),
      enqueue: vi.fn(),
      error: vi.fn(),
    } as unknown as ReadableStreamDefaultController<Uint8Array>;

    await readStreamToController(reader, controller);

    expect(controller.enqueue).toHaveBeenCalledTimes(1);
    expect(controller.close).toHaveBeenCalledTimes(1);
    expect(controller.error).not.toHaveBeenCalled();
  });

  // --- Issue B simplification: handleAuthErrorAndRetry returns raw response ---

  test('handleAuthErrorAndRetry returns raw retry response (not wrapped)', async () => {
    {
      const ModelRuntime = await getMockModelRuntime();
      ModelRuntime.create.mockResolvedValue({
        getAuth: vi
          .fn()
          .mockImplementation(() => Promise.resolve({ auth: { apiKey: 'stored-access-token' } })),
      });
    }

    const retryResponse = new Response('retry-body', { status: 200 });
    const streamFn = vi.fn().mockResolvedValue(retryResponse);

    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({ expires_in: 300, token: 'new-access-token' }, { status: 200 }),
      );

    const result = await handleAuthErrorAndRetry(
      new Request('https://api.berget.ai/v1/chat/completions'),
      'test-key',
      streamFn,
    );

    expect(result).toBe(retryResponse);
  });

  // --- Happy path ---

  test('successful retry pipes retry response body through', async () => {
    {
      const ModelRuntime = await getMockModelRuntime();
      ModelRuntime.create.mockResolvedValue({
        getAuth: vi
          .fn()
          .mockImplementation(() => Promise.resolve({ auth: { apiKey: 'stored-access-token' } })),
      });
    }

    const authErrorChunk = new TextEncoder().encode(
      'data: {"error":{"message":"Invalid token","type":"authentication_error"}}\n\n',
    );
    const retryChunk = new TextEncoder().encode(
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
    );

    let firstCall = true;
    const streamFn = vi.fn().mockImplementation(() => {
      if (firstCall) {
        firstCall = false;
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(authErrorChunk);
                controller.close();
              },
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(retryChunk);
              controller.close();
            },
          }),
          { status: 200 },
        ),
      );
    });

    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({ expires_in: 300, token: 'new-access-token' }, { status: 200 }),
      );

    const interceptor = createStreamInterceptor(streamFn);
    const response = await interceptor(
      new Request('https://api.berget.ai/v1/chat/completions'),
      'test-key',
    );

    const reader = response.body!.getReader();
    const chunks = await readAllChunks(reader);
    const text = new TextDecoder().decode(concatChunks(chunks));
    expect(text).toContain('Hello');
  });

  test('non-auth stream passes through unchanged', async () => {
    const normalChunk = new TextEncoder().encode(
      'data: {"choices":[{"delta":{"content":"World"}}]}\n\n',
    );

    const streamFn = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(normalChunk);
            controller.close();
          },
        }),
        { status: 200 },
      ),
    );

    const interceptor = createStreamInterceptor(streamFn);
    const response = await interceptor(
      new Request('https://api.berget.ai/v1/chat/completions'),
      'test-key',
    );

    const reader = response.body!.getReader();
    const chunks = await readAllChunks(reader);
    const text = new TextDecoder().decode(concatChunks(chunks));
    expect(text).toContain('World');
  });
});

// Helpers

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function readAllChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
}
