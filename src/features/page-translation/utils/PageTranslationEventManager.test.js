import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import browser from 'webextension-polyfill';
import { PageTranslationEventManager } from './PageTranslationEventManager.js';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import { storageManager } from '@/shared/storage/core/StorageCore.js';
import { ErrorHandler } from '@/shared/error-management/ErrorHandler.js';
import { ErrorTypes } from '@/shared/error-management/ErrorTypes.js';
import { pageEventBus } from '@/core/PageEventBus.js';
import { TranslationMode } from '@/config.js';
import { ApiKeyManager } from '@/features/translation/providers/ApiKeyManager.js';

// Mock storageManager
vi.mock('@/shared/storage/core/StorageCore.js', () => ({
  storageManager: {
    on: vi.fn(),
    off: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
  }
}));

// Mock ExtensionContextManager
vi.mock('@/core/extensionContext.js', () => ({
  default: {
    isContextError: vi.fn(() => false)
  }
}));

// Mock ErrorHandler
vi.mock('@/shared/error-management/ErrorHandler.js');

describe('PageTranslationEventManager', () => {
  let mockManager;
  let mockBus;
  let eventManager;

  beforeEach(() => {
    vi.clearAllMocks();
    storageManager.get.mockReset();
    storageManager.set.mockReset();
    browser.runtime.id = 'test-extension';
    
    // Reset global state
    delete window._translateItPageTranslationListenersSet;
    
    mockBus = {
      on: vi.fn(),
      emit: vi.fn()
    };
    window.pageEventBus = mockBus;

    mockManager = {
      logger: {
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        warn: vi.fn()
      },
      addEventListener: vi.fn((target, _event, handler) => target.addListener(handler)),
      removeEventListener: vi.fn((target, _event, handler) => target.removeListener(handler)),
      settings: {
        scrollStopDelay: 500,
        translateAfterScrollStop: false
      },
      scrollTracker: {
        updateDelay: vi.fn(),
        start: vi.fn()
      },
      resetError: vi.fn(),
      translatePage: vi.fn(() => Promise.resolve()),
      restorePage: vi.fn(() => Promise.resolve()),
      cancelTranslation: vi.fn(),
      stopAutoTranslation: vi.fn(() => Promise.resolve()),
      _handleFatalError: vi.fn(),
      _broadcastEvent: vi.fn()
    };

    eventManager = new PageTranslationEventManager(mockManager);
  });

  afterEach(() => {
    eventManager.destroy();
  });

  describe('Trusted SPA navigation', () => {
    it('stops immediately even if an A-B-A navigation ends on the original URL', () => {
      mockManager.currentUrl = window.location.href;
      mockManager.isTranslating = true;
      const callback = mockManager.addEventListener.mock.calls[0][2];

      expect(callback({ action: MessageActions.SPA_NAVIGATION }, { id: browser.runtime.id })).toBeUndefined();
      expect(mockManager.stopAutoTranslation).toHaveBeenCalledWith({ cancellationReason: 'operation-abort' });
      expect(mockManager.currentUrl).toBe(window.location.href);
    });

    it.each([
      undefined,
      { id: 'another-extension' },
      { id: 'test-extension', tab: { id: 1 } },
    ])('ignores an untrusted navigation sender %o', (sender) => {
      mockManager.addEventListener.mock.calls[0][2]({ action: MessageActions.SPA_NAVIGATION }, sender);
      expect(mockManager.stopAutoTranslation).not.toHaveBeenCalled();
    });

    it('registers once, removes the tracked listener and registers again after reactivation', () => {
      const listener = eventManager.navigationListener;
      eventManager.initialize();
      expect(mockManager.addEventListener).toHaveBeenCalledOnce();
      eventManager.destroy();
      eventManager.destroy();
      expect(mockManager.removeEventListener).toHaveBeenCalledExactlyOnceWith(browser.runtime.onMessage, 'message', listener);
      eventManager.initialize();
      expect(mockManager.addEventListener).toHaveBeenCalledTimes(2);
      expect(eventManager.navigationListener).not.toBe(listener);
    });
  });

  describe('Storage Listeners', () => {
    it('should register storage listeners on init', () => {
      expect(storageManager.on).toHaveBeenCalledWith('change:TRANSLATION_API', expect.any(Function));
      expect(storageManager.on).toHaveBeenCalledWith('change:MODE_PROVIDERS', expect.any(Function));
      expect(storageManager.on).toHaveBeenCalledWith('change:WHOLE_PAGE_SCROLL_STOP_DELAY', expect.any(Function));
    });

    it('should reset error when TRANSLATION_API changes', () => {
      const callback = storageManager.on.mock.calls.find(c => c[0] === 'change:TRANSLATION_API')[1];
      callback({ newValue: 'gemini', oldValue: 'google' });
      expect(mockManager.resetError).toHaveBeenCalled();
      expect(mockManager.stopAutoTranslation).toHaveBeenCalledWith({ cancellationReason: 'operation-abort' });
    });

    it('stops immediately for a page provider change but ignores other modes and unchanged providers', () => {
      const callback = storageManager.on.mock.calls.find(c => c[0] === 'change:MODE_PROVIDERS')[1];
      callback({ newValue: { [TranslationMode.Page]: 'custom' }, oldValue: { [TranslationMode.Page]: 'custom' } });
      expect(mockManager.stopAutoTranslation).not.toHaveBeenCalled();

      callback({ newValue: { [TranslationMode.Page]: 'openai' }, oldValue: { [TranslationMode.Page]: 'custom' } });
      expect(mockManager.stopAutoTranslation).toHaveBeenCalledOnce();
      expect(mockManager.resetError).toHaveBeenCalledOnce();
    });

    it.each([
      'SOURCE_LANGUAGE', 'TARGET_LANGUAGE', 'OPTIMIZATION_LEVEL', 'AI_CONTEXT_TRANSLATION_ENABLED',
      'BILINGUAL_TRANSLATION',
      'PROMPT_TEMPLATE', 'PROMPT_TEMPLATE_AUTO', 'PROMPT_BASE_AI_BATCH',
      'CUSTOM_API_MODEL', 'CUSTOM_API_URL', 'CUSTOM_API_KEY',
    ])('immediately stops obsolete output for changed %s without logging values', (key) => {
      mockManager.settings.translationApi = 'custom';
      mockManager.isTranslating = true;
      const callback = storageManager.on.mock.calls.find(c => c[0] === 'change')[1];
      callback({ key, oldValue: 'previous-value', newValue: 'replacement-value' });

      expect(mockManager.stopAutoTranslation).toHaveBeenCalledWith({ cancellationReason: 'operation-abort' });
      expect(mockManager.resetError).toHaveBeenCalledOnce();
      expect(JSON.stringify(mockManager.logger.info.mock.calls)).not.toContain('replacement-value');
      expect(JSON.stringify(mockManager.logger.debug.mock.calls)).not.toContain('replacement-value');
    });

    it('ignores unchanged settings, unrelated provider settings, model lists and other provider optimization', () => {
      mockManager.settings.translationApi = 'custom';
      const callback = storageManager.on.mock.calls.find(c => c[0] === 'change')[1];
      callback({ key: 'TARGET_LANGUAGE', oldValue: 'ja', newValue: 'ja' });
      callback({ key: 'OPENAI_API_MODEL', oldValue: 'one', newValue: 'two' });
      callback({ key: 'CUSTOM_MODELS', oldValue: [], newValue: ['new-model'] });
      callback({ key: 'PROVIDER_OPTIMIZATION_LEVELS', oldValue: { custom: 3 }, newValue: { custom: 3, openai: 5 } });

      expect(mockManager.stopAutoTranslation).not.toHaveBeenCalled();
      expect(mockManager.resetError).not.toHaveBeenCalled();
    });

    it.each(['custom', 'Custom'])('stops for optimization override stored under %s', (providerKey) => {
      mockManager.settings.translationApi = 'custom';
      const callback = storageManager.on.mock.calls.find(c => c[0] === 'change')[1];
      callback({ key: 'PROVIDER_OPTIMIZATION_LEVELS', oldValue: { [providerKey]: 3 }, newValue: { [providerKey]: 5 } });

      expect(mockManager.stopAutoTranslation).toHaveBeenCalledOnce();
    });

    it('keeps page translation running when successful key failover promotes an existing key', async () => {
      mockManager.settings.translationApi = 'custom';
      const callback = storageManager.on.mock.calls.find(c => c[0] === 'change')[1];
      const oldValue = ' first-test-key \nsecond-test-key\n';
      storageManager.get.mockResolvedValue({ CUSTOM_API_KEY: oldValue });
      storageManager.set.mockImplementation(async (changes) => {
        callback({ key: 'CUSTOM_API_KEY', oldValue, newValue: changes.CUSTOM_API_KEY });
      });
      await ApiKeyManager.promoteKey('CUSTOM_API_KEY', 'second-test-key');

      expect(storageManager.set).toHaveBeenCalledWith({ CUSTOM_API_KEY: 'second-test-key\nfirst-test-key' });
      expect(mockManager.stopAutoTranslation).not.toHaveBeenCalled();
      expect(mockManager.resetError).not.toHaveBeenCalled();
    });

    it.each([
      ['first-test-key', 'first-test-key\nsecond-test-key'],
      ['first-test-key\nsecond-test-key', 'second-test-key'],
      ['first-test-key', 'replacement-test-key'],
    ])('stops when key membership changes', (oldValue, newValue) => {
      mockManager.settings.translationApi = 'custom';
      const callback = storageManager.on.mock.calls.find(c => c[0] === 'change')[1];
      callback({ key: 'CUSTOM_API_KEY', oldValue, newValue });
      expect(mockManager.stopAutoTranslation).toHaveBeenCalledOnce();
    });

    it('ignores bilingual changes for other modes and stops when the page mode changes', () => {
      const callback = storageManager.on.mock.calls.find(c => c[0] === 'change')[1];
      callback({
        key: 'BILINGUAL_TRANSLATION_MODES',
        oldValue: { [TranslationMode.Page]: false },
        newValue: { [TranslationMode.Page]: false, [TranslationMode.Selection]: true },
      });
      expect(mockManager.stopAutoTranslation).not.toHaveBeenCalled();
      callback({
        key: 'BILINGUAL_TRANSLATION_MODES',
        oldValue: { [TranslationMode.Page]: false },
        newValue: { [TranslationMode.Page]: true },
      });
      expect(mockManager.stopAutoTranslation).toHaveBeenCalledOnce();
    });

    it('should update scrollStopDelay when WHOLE_PAGE_SCROLL_STOP_DELAY changes', () => {
      const callback = storageManager.on.mock.calls.find(c => c[0] === 'change:WHOLE_PAGE_SCROLL_STOP_DELAY')[1];
      callback({ newValue: 1000 });
      expect(mockManager.settings.scrollStopDelay).toBe(1000);
      expect(mockManager.scrollTracker.updateDelay).toHaveBeenCalledWith(1000);
    });
  });

  describe('PageEventBus Listeners', () => {
    it('should register event bus listeners', () => {
      expect(mockBus.on).not.toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE, expect.any(Function));
      expect(mockBus.on).not.toHaveBeenCalledWith(MessageActions.PAGE_RESTORE, expect.any(Function));
      expect(mockBus.on).not.toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE_STOP_AUTO, expect.any(Function));
      expect(mockBus.on).not.toHaveBeenCalledWith(MessageActions.PAGE_TRANSLATE_CANCELLED, expect.any(Function));
    });

    it('does not register state-changing command listeners', () => {
      expect(mockManager.translatePage).not.toHaveBeenCalled();
      expect(mockManager.restorePage).not.toHaveBeenCalled();
      expect(mockManager.stopAutoTranslation).not.toHaveBeenCalled();
      expect(mockManager.cancelTranslation).not.toHaveBeenCalled();
    });

    it('ignores page-visible command CustomEvents', () => {
      delete window._translateItPageTranslationListenersSet;
      window.pageEventBus = pageEventBus;

      new PageTranslationEventManager(mockManager);

      for (const action of [
        MessageActions.PAGE_TRANSLATE,
        MessageActions.PAGE_RESTORE,
        MessageActions.PAGE_TRANSLATE_STOP_AUTO,
        MessageActions.PAGE_TRANSLATE_CANCELLED,
      ]) {
        window.dispatchEvent(new CustomEvent(action, { detail: {} }));
      }

      expect(mockManager.translatePage).not.toHaveBeenCalled();
      expect(mockManager.restorePage).not.toHaveBeenCalled();
      expect(mockManager.stopAutoTranslation).not.toHaveBeenCalled();
      expect(mockManager.cancelTranslation).not.toHaveBeenCalled();
    });

    it('does not install a PageEventBus-to-background lifecycle forwarder', () => {
      expect(mockBus.on).not.toHaveBeenCalledWith(
        MessageActions.PAGE_TRANSLATE_PROGRESS,
        expect.any(Function)
      );
    });

    it('keeps manager lifecycle state unchanged for forged COMPLETE and IDLE DOM events', () => {
      delete window._translateItPageTranslationListenersSet;
      window.pageEventBus = pageEventBus;
      mockManager.isTranslating = true;
      mockManager.isTranslated = false;

      new PageTranslationEventManager(mockManager);
      window.dispatchEvent(new CustomEvent(MessageActions.PAGE_TRANSLATE_COMPLETE, {
        detail: { translatedCount: 100, totalCount: 100 },
      }));
      window.dispatchEvent(new CustomEvent(MessageActions.PAGE_TRANSLATE_IDLE, {
        detail: { translatedCount: 100, totalCount: 100 },
      }));

      expect(mockManager.isTranslating).toBe(true);
      expect(mockManager.isTranslated).toBe(false);
    });

    it('keeps top manager eligible to stop after trusted child aggregate completion', () => {
      const callback = mockBus.on.mock.calls.find(c => c[0] === MessageActions.PAGE_TRANSLATE_COMPLETE)[1];
      mockManager.isTranslating = true;
      mockManager.isTranslated = false;

      callback({
        isAggregated: true,
        isTranslating: false,
        isAutoTranslating: false,
        translatedCount: 3,
        totalCount: 3,
        failedCount: 0,
      });

      expect(mockManager.isTranslating).toBe(true);
      expect(mockManager.isTranslated).toBe(false);
    });

    it('does not register an IDLE lifecycle state listener', () => {
      expect(mockBus.on).not.toHaveBeenCalledWith(
        MessageActions.PAGE_TRANSLATE_IDLE,
        expect.any(Function)
      );
    });

    it('does not register a fatal-error listener', () => {
      expect(mockBus.on).not.toHaveBeenCalledWith('page-translation-fatal-error', expect.any(Function));
    });

    it('ignores forged DOM fatal events', () => {
      delete window._translateItPageTranslationListenersSet;
      window.pageEventBus = pageEventBus;
      mockManager.isTranslating = true;
      mockManager.isAutoTranslating = true;

      new PageTranslationEventManager(mockManager);
      window.dispatchEvent(new CustomEvent('page-translation-fatal-error', {
        detail: {
          error: 'fake fatal',
          errorType: 'SERVER_ERROR',
        },
      }));

      expect(mockManager._handleFatalError).not.toHaveBeenCalled();
      expect(mockManager.stopAutoTranslation).not.toHaveBeenCalled();
      expect(mockManager.isTranslating).toBe(true);
      expect(mockManager.isAutoTranslating).toBe(true);
    });

    it('keeps non-fatal provider failures presentation-only at PageEventBus boundary', async () => {
      const callback = mockBus.on.mock.calls.find(c => c[0] === 'page-translation-internal-error')[1];
      const error = Object.assign(new Error('raw provider diagnostic'), {
        type: ErrorTypes.MODEL_MISSING,
        providerName: 'Provider',
      });

      await callback({ error, errorType: error.type, isFatal: false, context: 'page-translation-batch' });

      expect(mockManager._broadcastEvent).not.toHaveBeenCalled();
      expect(ErrorHandler.getInstance().handle).not.toHaveBeenCalled();
    });

    it('keeps legacy non-fatal failures silent', async () => {
      const callback = mockBus.on.mock.calls.find(c => c[0] === 'page-translation-internal-error')[1];

      await callback({
        error: 'legacy provider diagnostic',
        errorType: ErrorTypes.MODEL_MISSING,
        isFatal: false,
      });

      expect(ErrorHandler.getInstance().handle).not.toHaveBeenCalled();
    });

    it('keeps multiple non-fatal batch failures silent', async () => {
      const callback = mockBus.on.mock.calls.find(c => c[0] === 'page-translation-internal-error')[1];

      await Promise.all([
        callback({ error: 'batch 1', errorType: ErrorTypes.MODEL_MISSING, isFatal: false }),
        callback({ error: 'batch 2', errorType: ErrorTypes.MODEL_MISSING, isFatal: false }),
        callback({ error: 'batch 3', errorType: ErrorTypes.MODEL_MISSING, isFatal: false }),
      ]);

      expect(mockManager._broadcastEvent).not.toHaveBeenCalled();
      expect(ErrorHandler.getInstance().handle).not.toHaveBeenCalled();
    });

    it('presents one terminal aggregate error after all frames settle with zero useful results', async () => {
      const callback = mockBus.on.mock.calls.find(c => c[0] === MessageActions.PAGE_TRANSLATE_COMPLETE)[1];

      callback({ translatedCount: 0, failedCount: 3, totalCount: 3 });
      callback({
        isAggregated: true,
        isTranslating: true,
        isAutoTranslating: false,
        translatedCount: 0,
        failedCount: 3,
        totalCount: 3,
      });
      callback({
        isAggregated: true,
        isTranslating: false,
        isAutoTranslating: false,
        translatedCount: 0,
        failedCount: 3,
        totalCount: 3,
      });
      await vi.waitFor(() => expect(ErrorHandler.getInstance().handle).toHaveBeenCalledTimes(1));

      expect(ErrorHandler.getInstance().handle.mock.calls[0][1]).toMatchObject({
        type: ErrorTypes.TRANSLATION_FAILED,
        context: 'page-translation-zero-result',
        showToast: true,
      });
    });

    it('presents structured terminal cause instead of generic zero-result error', async () => {
      const callback = mockBus.on.mock.calls.find(c => c[0] === MessageActions.PAGE_TRANSLATE_COMPLETE)[1];
      const errorDetails = {
        message: 'Too Many Requests',
        type: ErrorTypes.RATE_LIMIT_REACHED,
        statusCode: 429,
      };

      callback({
        isAggregated: true,
        isTranslating: false,
        isAutoTranslating: false,
        translatedCount: 0,
        failedCount: 3,
        totalCount: 3,
        errorDetails,
      });
      await vi.waitFor(() => expect(ErrorHandler.getInstance().handle).toHaveBeenCalledTimes(1));

      expect(ErrorHandler.getInstance().handle.mock.calls[0][0]).toMatchObject({
        type: ErrorTypes.RATE_LIMIT_REACHED,
      });
      expect(ErrorHandler.getInstance().handle.mock.calls[0][1]).toMatchObject({
        type: ErrorTypes.RATE_LIMIT_REACHED,
        context: 'page-translation-zero-result',
        showToast: true,
      });
    });

    it.each([ErrorTypes.USER_CANCELLED, ErrorTypes.TRANSLATION_CANCELLED, ErrorTypes.CONTEXT, ErrorTypes.EXTENSION_CONTEXT_INVALIDATED])(
      'does not present silent translation error %s', async (type) => {
        const callback = mockBus.on.mock.calls.find(c => c[0] === 'page-translation-internal-error')[1];

        await callback({ error: Object.assign(new Error('silent failure'), { type }), isFatal: false });

        expect(ErrorHandler.getInstance().handle).not.toHaveBeenCalled();
      }
    );

    it('does not register a DOM conflict command listener', () => {
      expect(mockBus.on).not.toHaveBeenCalledWith('STOP_CONFLICTING_FEATURES', expect.any(Function));
    });

    it('ignores forged DOM conflict events', () => {
      delete window._translateItPageTranslationListenersSet;
      window.pageEventBus = pageEventBus;
      mockManager.isTranslating = true;

      new PageTranslationEventManager(mockManager);
      window.dispatchEvent(new CustomEvent('STOP_CONFLICTING_FEATURES', {
        detail: { source: 'malicious-page' },
      }));

      expect(mockManager.restorePage).not.toHaveBeenCalled();
    });
  });
});
