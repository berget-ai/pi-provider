import type { AuthInteraction, AuthPrompt } from '@earendil-works/pi-ai';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Mock } from 'vitest';

import { _collectAuthCode, resolveManualCode } from '../index';

/**
 * Build an `AuthInteraction` mock. `notify` defaults to a no-op (fire-and-
 * forget per the `AuthInteraction` contract), `prompt` defaults to resolving
 * the `text` fallback with `'fallback-code'` and hanging the `manual_code`
 * race so the callback server / timeout decides. Spies are returned for
 * assertions.
 */
function mockInteraction(
  overrides: {
    notify?: Mock;
    manualCode?: (prompt: AuthPrompt) => Promise<string>;
    text?: (prompt: AuthPrompt) => Promise<string>;
  } = {},
): AuthInteraction & { notify: Mock; prompt: Mock } {
  const notify = overrides.notify ?? vi.fn();
  const prompt = vi.fn((p: AuthPrompt): Promise<string> => {
    if (p.type === 'manual_code') {
      return (overrides.manualCode ?? (() => new Promise(() => {})))(p);
    }
    return (overrides.text ?? (() => Promise.resolve('fallback-code')))(p);
  });
  return { notify, prompt };
}

describe('OAuth Callback Error Handling', () => {
  let originalEnvironment: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnvironment = { ...process.env };
    process.env.BERGET_OAUTH_TIMEOUT_MS = '500';
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnvironment;
    vi.restoreAllMocks();
  });

  // --- A throwing notify (sync) propagates out of _collectAuthCode ---

  test('_collectAuthCode propagates sync throw from notify', async () => {
    const mockServer = {
      cancelWait: vi.fn(),
      close: vi.fn(),
      server: {},
      waitForCode: vi.fn().mockResolvedValue(null),
    };

    const mockServerFactory = vi.fn().mockResolvedValue(mockServer);

    const interaction = mockInteraction({
      notify: vi.fn(() => {
        throw new Error('UI framework error displaying URL');
      }),
    });

    await expect(
      _collectAuthCode(interaction, 'https://auth.berget.ai', 'test-state', mockServerFactory),
    ).rejects.toThrow('UI framework error displaying URL');
    expect(mockServer.close).toHaveBeenCalled();
  });

  test('_collectAuthCode propagates EADDRINUSE from startCallbackServer', async () => {
    const mockServerFactory = vi
      .fn()
      .mockRejectedValue(
        new Error('Port 8787 is already in use. Close other applications using this port.'),
      );

    const interaction = mockInteraction();

    await expect(
      _collectAuthCode(interaction, 'https://auth.berget.ai', 'test-state', mockServerFactory),
    ).rejects.toThrow('Port 8787 is already in use');
  });

  // --- `notify` is fire-and-forget per the AuthInteraction contract: an
  // async rejection inside `notify` is the caller's concern, not
  // _collectAuthCode's. _collectAuthCode must not surface it as its own
  // rejection (the legacy `onAuth` was awaited; `notify` is not). ---

  test('_collectAuthCode does not surface an async notify rejection as its own (notify is fire-and-forget)', async () => {
    const mockServer = {
      cancelWait: vi.fn(),
      close: vi.fn(),
      server: {},
      waitForCode: vi.fn().mockResolvedValue(null),
    };

    const mockServerFactory = vi.fn().mockResolvedValue(mockServer);

    // Swallow the unhandled rejection that the fire-and-forget notify would
    // otherwise produce, so it does not fail the test run.
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onUnhandled);

    const notify = vi.fn(() => {
      // An async failure in the UI layer — surfaces as an unhandled rejection,
      // NOT as _collectAuthCode's rejection.
      void Promise.reject(new Error('Async auth UI failure'));
    });

    const interaction = mockInteraction({
      notify,
      // The text fallback resolves so _collectAuthCode completes.
      text: () => Promise.resolve('fallback-code'),
    });

    try {
      const code = await _collectAuthCode(
        interaction,
        'https://auth.berget.ai',
        'test-state',
        mockServerFactory,
      );
      // _collectAuthCode resolves via the text fallback, not by surfacing the
      // notify rejection.
      expect(code).toBe('fallback-code');
      expect(mockServer.close).toHaveBeenCalled();
      // Drain the microtask queue so the unhandled rejection is recorded.
      await new Promise((resolve) => setImmediate(resolve));
      expect(rejections).toHaveLength(1);
      expect(String(rejections[0])).toContain('Async auth UI failure');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  // --- The manual_code prompt (legacy onManualCodeInput) times out ---

  test('resolveManualCode times out when the manual_code prompt never resolves', async () => {
    const mockServer = {
      cancelWait: vi.fn(),
      close: vi.fn(),
      waitForCode: vi.fn().mockResolvedValue(null),
    };

    const interaction = mockInteraction({
      manualCode: (): Promise<string> => new Promise(() => {}),
    });

    process.env.BERGET_OAUTH_TIMEOUT_MS = '100';

    // @ts-expect-error — using a plain object as the callback server interface
    const code = await resolveManualCode(mockServer, interaction);
    expect(code).toBeNull();
    expect(mockServer.cancelWait).toHaveBeenCalled();
  });

  // --- Invariant: the .catch on the concurrent manual promise means a late
  // manual_code rejection (settling after the callback won) does not surface
  // as an unhandled rejection. ---

  test('resolveManualCode does not emit an unhandled rejection when the manual_code prompt rejects after a callback win', async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onUnhandled);

    let rejectManual!: (error: Error) => void;
    const mockServer = {
      cancelWait: vi.fn(),
      close: vi.fn(),
      waitForCode: vi.fn().mockResolvedValue({ code: 'callback-code', state: 's' }),
    };

    const interaction = mockInteraction({
      manualCode: () =>
        new Promise<string>((_resolve, reject) => {
          rejectManual = reject;
        }),
    });

    try {
      // @ts-expect-error — using a plain object as the callback server interface
      const code = await resolveManualCode(mockServer, interaction);
      expect(code).toBe('callback-code');

      // The late rejection arrives after resolveManualCode returned.
      rejectManual(new Error('late manual failure'));
      // Let the microtask queue drain so the .catch would run.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(rejections).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  // --- callback server cleanup on manual prompt hang ---

  test('resolveManualCode timeout still allows callbackServer.close() to work', async () => {
    let serverClosed = false;

    const mockServer = {
      cancelWait: vi.fn(),
      close: vi.fn(() => {
        serverClosed = true;
      }),
      waitForCode: vi.fn().mockResolvedValue(null),
    };

    const interaction = mockInteraction({
      manualCode: (): Promise<string> => new Promise(() => {}),
    });

    process.env.BERGET_OAUTH_TIMEOUT_MS = '100';

    // @ts-expect-error — using a plain object as the callback server interface
    const code = await resolveManualCode(mockServer, interaction);
    expect(code).toBeNull();
    expect(mockServer.cancelWait).toHaveBeenCalled();

    // Simulate what collectAuthCode finally block does
    mockServer.close();
    expect(serverClosed).toBe(true);
  });

  // --- Verify the text fallback prompt still works when everything else fails ---

  test('_collectAuthCode falls back to the text prompt after callback server timeout', async () => {
    const mockServer = {
      cancelWait: vi.fn(),
      close: vi.fn(),
      server: {},
      waitForCode: vi.fn().mockResolvedValue(null),
    };

    const mockServerFactory = vi.fn().mockResolvedValue(mockServer);

    const interaction = mockInteraction({
      text: () => Promise.resolve('prompt-code'),
    });

    const code = await _collectAuthCode(
      interaction,
      'https://auth.berget.ai',
      'test-state',
      mockServerFactory,
    );
    expect(code).toBe('prompt-code');
  });
});
