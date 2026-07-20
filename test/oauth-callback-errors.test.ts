import type { OAuthLoginCallbacks } from '@earendil-works/pi-ai';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { _collectAuthCode, resolveManualCode } from '../index';

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

  // --- Issue 3: Silent error swallowing in collectAuthCode ---

  test('collectAuthCode propagates sync throw from onAuth', async () => {
    const mockServer = {
      cancelWait: vi.fn(),
      close: vi.fn(),
      server: {},
      waitForCode: vi.fn().mockResolvedValue(null),
    };

    const mockServerFactory = vi.fn().mockResolvedValue(mockServer);

    const callbacks: OAuthLoginCallbacks = {
      onAuth: () => {
        throw new Error('UI framework error displaying URL');
      },
      onDeviceCode: () => {},
      onPrompt: vi.fn().mockResolvedValue('fallback-code'),
      onSelect: () => Promise.resolve(''),
    };

    await expect(
      _collectAuthCode(callbacks, 'https://auth.berget.ai', 'test-state', mockServerFactory),
    ).rejects.toThrow('UI framework error displaying URL');
    expect(mockServer.close).toHaveBeenCalled();
  });

  test('collectAuthCode propagates EADDRINUSE from startCallbackServer', async () => {
    const mockServerFactory = vi
      .fn()
      .mockRejectedValue(
        new Error('Port 8787 is already in use. Close other applications using this port.'),
      );

    const callbacks: OAuthLoginCallbacks = {
      onAuth: vi.fn(),
      onDeviceCode: () => {},
      onPrompt: vi.fn().mockResolvedValue('fallback-code'),
      onSelect: () => Promise.resolve(''),
    };

    await expect(
      _collectAuthCode(callbacks, 'https://auth.berget.ai', 'test-state', mockServerFactory),
    ).rejects.toThrow('Port 8787 is already in use');
  });

  // --- Issue 3b: onAuth async rejections are unhandled ---

  test('collectAuthCode catches async rejection from onAuth', async () => {
    const mockServer = {
      cancelWait: vi.fn(),
      close: vi.fn(),
      server: {},
      waitForCode: vi.fn().mockResolvedValue(null),
    };

    const mockServerFactory = vi.fn().mockResolvedValue(mockServer);

    const callbacks: OAuthLoginCallbacks = {
      onAuth: vi.fn().mockRejectedValue(new Error('Async auth UI failure')),
      onDeviceCode: () => {},
      onPrompt: vi.fn().mockResolvedValue('fallback-code'),
      onSelect: () => Promise.resolve(''),
    };

    await expect(
      _collectAuthCode(callbacks, 'https://auth.berget.ai', 'test-state', mockServerFactory),
    ).rejects.toThrow('Async auth UI failure');
    expect(mockServer.close).toHaveBeenCalled();
  });

  // --- Issue 5: No timeout on manual code input ---

  test('resolveManualCode times out when onManualCodeInput never resolves', async () => {
    const mockServer = {
      cancelWait: vi.fn(),
      close: vi.fn(),
      waitForCode: vi.fn().mockResolvedValue(null),
    };

    const callbacks: OAuthLoginCallbacks = {
      onAuth: vi.fn(),
      onDeviceCode: () => {},
      onManualCodeInput: (): Promise<string> => new Promise(() => {}),
      onPrompt: vi.fn().mockResolvedValue('fallback-code'),
      onSelect: () => Promise.resolve(''),
    };

    process.env.BERGET_OAUTH_TIMEOUT_MS = '100';

    // @ts-expect-error — using a plain object as the callback server interface
    const code = await resolveManualCode(mockServer, callbacks);
    expect(code).toBeNull();
    expect(mockServer.cancelWait).toHaveBeenCalled();
  });

  // --- Issue E: callback server cleanup on manual input hang ---

  test('resolveManualCode timeout still allows callbackServer.close() to work', async () => {
    let serverClosed = false;

    const mockServer = {
      cancelWait: vi.fn(),
      close: vi.fn(() => {
        serverClosed = true;
      }),
      waitForCode: vi.fn().mockResolvedValue(null),
    };

    const callbacks: OAuthLoginCallbacks = {
      onAuth: vi.fn(),
      onDeviceCode: () => {},
      onManualCodeInput: (): Promise<string> => new Promise(() => {}),
      onPrompt: vi.fn().mockResolvedValue('fallback-code'),
      onSelect: () => Promise.resolve(''),
    };

    process.env.BERGET_OAUTH_TIMEOUT_MS = '100';

    // @ts-expect-error — using a plain object as the callback server interface
    const code = await resolveManualCode(mockServer, callbacks);
    expect(code).toBeNull();
    expect(mockServer.cancelWait).toHaveBeenCalled();

    // Simulate what collectAuthCode finally block does
    mockServer.close();
    expect(serverClosed).toBe(true);
  });

  // --- Verify fallback prompt still works when everything else fails ---

  test('collectAuthCode falls back to onPrompt after callback server timeout', async () => {
    const mockServer = {
      cancelWait: vi.fn(),
      close: vi.fn(),
      server: {},
      waitForCode: vi.fn().mockResolvedValue(null),
    };

    const mockServerFactory = vi.fn().mockResolvedValue(mockServer);

    const callbacks: OAuthLoginCallbacks = {
      onAuth: vi.fn(),
      onDeviceCode: () => {},
      onPrompt: vi.fn().mockResolvedValue('prompt-code'),
      onSelect: () => Promise.resolve(''),
    };

    const code = await _collectAuthCode(
      callbacks,
      'https://auth.berget.ai',
      'test-state',
      mockServerFactory,
    );
    expect(code).toBe('prompt-code');
  });
});
