import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Keep the coordinator, CustomProvider, parser, retry queue and HTTP limiter real.
// Only browser/settings boundaries and the physical HTTP response are fixtures.
vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: { getBrowserInfo: vi.fn(), getManifest: () => ({ version: '1.0.0' }) },
    storage: { local: { get: vi.fn(), set: vi.fn() } },
    tabs: { sendMessage: vi.fn() },
  },
}));
vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: () => ({ init: vi.fn(), debug: vi.fn(), debugLazy: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/shared/storage/core/StorageCore.js', () => ({
  storageManager: {
    get: vi.fn(async defaults => ({ ...defaults, CUSTOM_API_KEY: settings.keys.join('\n') })),
    set: vi.fn(),
  },
}));
const settings = vi.hoisted(() => ({ level: 5, keys: ['fixture-key'] }));
vi.mock('@/shared/config/config.js', async importOriginal => ({
  ...await importOriginal(),
  getCustomApiKeysAsync: vi.fn(async () => settings.keys),
  getCustomApiUrlAsync: vi.fn(async () => 'https://fixture.invalid/v1/chat/completions'),
  getCustomApiModelAsync: vi.fn(async () => 'fixture-model'),
  getProviderOptimizationLevelAsync: vi.fn(async () => settings.level),
  getBilingualTranslationEnabledAsync: vi.fn(async () => false),
  getAIConversationHistoryEnabledAsync: vi.fn(async () => false),
}));
vi.mock('@/shared/proxy/ProxyManager.js', () => ({
  proxyManager: { fetch: vi.fn(), setConfig: vi.fn() },
}));

import { UnifiedModeCoordinator } from './UnifiedModeCoordinator.js';
import { CustomProvider, clearCustomResponseFormatSupportCache } from '@/features/translation/providers/CustomProvider.js';
import { queueManager } from '@/features/translation/core/QueueManager.js';
import { rateLimitManager } from '@/features/translation/core/RateLimitManager.js';
import { TranslationMode } from '@/shared/config/config.js';
import { proxyManager } from '@/shared/proxy/ProxyManager.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';

describe('Page → CustomProvider physical concurrency', () => {
  let coordinator, engine, state, active, maximum, attempts, completions, controllers;

  beforeEach(async () => {
    vi.clearAllMocks();
    queueManager.cleanup();
    rateLimitManager.providerStates.forEach(providerState => clearTimeout(providerState.nextProcessTimer));
    rateLimitManager.providerStates.clear();
    settings.level = 5;
    settings.keys = ['fixture-key'];
    await rateLimitManager.reloadConfigurations();
    state = rateLimitManager.providerStates.get('Custom');
    clearCustomResponseFormatSupportCache();
    coordinator = new UnifiedModeCoordinator();
    const provider = new CustomProvider();
    controllers = new Map();
    engine = {
      getProvider: async () => provider,
      lifecycleRegistry: {
        registerRequest: messageId => {
          const controller = new AbortController();
          controllers.set(messageId, controller);
          return controller;
        },
        unregisterRequest: vi.fn(),
      },
    };
    active = 0; maximum = 0; attempts = []; completions = [];
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    queueManager.cleanup();
    rateLimitManager.providerStates.forEach(providerState => clearTimeout(providerState.nextProcessTimer));
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const runBatch = index => coordinator.processRequest({
    mode: TranslationMode.Page,
    messageId: `request-${index}`,
    data: {
      provider: 'custom', sourceLanguage: 'en', targetLanguage: 'ja', sessionId: 'page-session',
      text: JSON.stringify([0, 1].map(unit => ({ id: `unit-${index}-${unit}`, text: `Source ${index}/${unit}` }))),
    },
  }, { translationEngine: engine });

  const installHttp = responseForAttempt => {
    proxyManager.fetch.mockImplementation(async (_url, options) => {
      const body = JSON.parse(options.body);
      const content = body.messages.at(-1).content;
      let units;
      try { units = JSON.parse(content).translations; } catch { units = [{ id: '0', text: content }]; }
      const record = { units, start: Date.now(), end: null, aborted: options.signal?.aborted };
      attempts.push(record);
      active++;
      maximum = Math.max(maximum, active);
      const attemptIndex = attempts.length - 1;
      await new Promise(resolve => setTimeout(resolve, 100 + (4 - attemptIndex % 5) * 10));
      active--;
      record.end = Date.now();
      completions.push(attemptIndex);
      const fixture = responseForAttempt?.(record, attemptIndex) || {};
      const responseContent = fixture.content ?? JSON.stringify({ translations: [...units].reverse().map(unit => ({ id: unit.id, text: `訳 ${unit.text}` })) });
      const status = fixture.status || 200;
      const data = status === 200
        ? { choices: [{ finish_reason: 'stop', message: { content: responseContent } }] }
        : { error: { message: fixture.error || 'Rate limit exceeded' } };
      return {
        ok: status === 200, status, statusText: status === 200 ? 'OK' : 'Too Many Requests',
        headers: new Map([['content-type', 'application/json'], ...(fixture.retryAfter ? [['Retry-After', fixture.retryAfter]] : [])]),
        json: async () => data,
        clone() { return this; },
      };
    });
  };

  const assertMapped = results => results.forEach((result, index) => {
    expect(result.success).toBe(true);
    expect(JSON.parse(result.translatedText)).toEqual([0, 1].map(unit => ({ id: `unit-${index}-${unit}`, text: `訳 Source ${index}/${unit}` })));
  });

  const advance = async milliseconds => {
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(milliseconds);
  };

  it.each([[3, 2], [5, 4]])('achieves level %s concurrency %s and maps reversed HTTP/items correctly', async (level, cap) => {
    settings.level = level;
    installHttp();
    const pending = Array.from({ length: 8 }, (_, index) => runBatch(index));
    await advance(5000);
    const results = await Promise.all(pending);
    expect(maximum).toBe(cap);
    expect(attempts).toHaveLength(8);
    expect(completions[0]).not.toBe(0);
    assertMapped(results);
    expect(queueManager.getQueueStatus('Custom::parallel').total).toBe(0);
    expect(state.activeRequests).toBe(0);
  });

  it('respects an explicit concurrency limit of one', async () => {
    state.isManualConfig = true;
    state.config.maxConcurrent = 1;
    installHttp();
    const pending = Array.from({ length: 4 }, (_, index) => runBatch(index));
    await advance(5000);
    assertMapped(await Promise.all(pending));
    expect(maximum).toBe(1);
    expect(attempts).toHaveLength(4);
  });

  it('shares physical 429 cooldown with queued batches and the bounded queue retry', async () => {
    installHttp((_record, index) => index === 0 ? { status: 429, retryAfter: '5' } : {});
    const pending = Array.from({ length: 8 }, (_, index) => runBatch(index));
    await advance(20000);
    assertMapped(await Promise.all(pending));
    expect(maximum).toBe(4);
    expect(attempts).toHaveLength(9);
    const deadline = attempts[0].end + 5000;
    attempts.filter(attempt => attempt.start >= attempts[0].end).forEach(attempt => expect(attempt.start).toBeGreaterThanOrEqual(deadline));
    expect(state.activeRequests).toBe(0);
  });

  it('honors shared Retry-After even when API-key failover consumes the 429', async () => {
    settings.keys = ['fixture-first-key', 'fixture-second-key'];
    installHttp((_record, index) => index === 0 ? { status: 429, retryAfter: '5' } : {});
    const pending = Array.from({ length: 8 }, (_, index) => runBatch(index));
    await advance(20000);
    assertMapped(await Promise.all(pending));
    expect(attempts).toHaveLength(9);
    expect(state.performanceStats.failedRequests).toBe(0);
    const deadline = attempts[0].end + 5000;
    attempts.filter(attempt => attempt.start >= attempts[0].end).forEach(attempt => expect(attempt.start).toBeGreaterThanOrEqual(deadline));
    expect(maximum).toBe(4);
  });

  it('retains a cancelled live HTTP slot until an abort-ignoring response settles', async () => {
    state.isManualConfig = true;
    state.config.maxConcurrent = 1;
    installHttp();
    const first = runBatch(0);
    const second = runBatch(1);
    await advance(0);
    expect(attempts).toHaveLength(1);
    controllers.get('request-0').abort('user-cancelled');
    await advance(139);
    expect(attempts).toHaveLength(1);
    expect(state.activeRequests).toBe(1);
    await advance(1000);
    expect(await first).toMatchObject({ success: false });
    const result = await second;
    expect(result.success).toBe(true);
    expect(JSON.parse(result.translatedText)[0]).toEqual({ id: 'unit-1-0', text: '訳 Source 1/0' });
    expect(attempts).toHaveLength(2);
    expect(maximum).toBe(1);
    expect(state.activeRequests).toBe(0);
  });

  it('repairs malformed JSON under the same physical cap without resending successful siblings', async () => {
    installHttp((_record, index) => index === 0 ? { content: 'unparseable output' } : {});
    const pending = Array.from({ length: 8 }, (_, index) => runBatch(index));
    await advance(10000);
    assertMapped(await Promise.all(pending));
    expect(maximum).toBe(4);
    expect(attempts.length).toBeGreaterThan(8);
    expect(attempts.length).toBeLessThanOrEqual(10);
    for (let index = 1; index < 8; index++) {
      expect(attempts.filter(attempt => attempt.units.some(unit => unit.text === `Source ${index}/0`))).toHaveLength(1);
    }
    expect(state.activeRequests).toBe(0);
  });

  it('does not retry a permanent failed batch or lose successful sibling mappings', async () => {
    installHttp((_record, index) => index === 0 ? { status: 400, error: 'Invalid request parameters' } : {});
    const pending = Array.from({ length: 8 }, (_, index) => runBatch(index));
    await advance(10000);
    const results = await Promise.all(pending);
    expect(results[0]).toMatchObject({ success: false, errorType: ErrorTypes.HTTP_ERROR });
    results.slice(1).forEach((result, index) => {
      expect(JSON.parse(result.translatedText)[0]).toEqual({ id: `unit-${index + 1}-0`, text: `訳 Source ${index + 1}/0` });
    });
    expect(attempts).toHaveLength(8);
    expect(maximum).toBe(4);
  });
});
