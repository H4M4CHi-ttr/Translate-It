import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import browser from 'webextension-polyfill';

vi.mock('@/shared/storage/core/StorageCore.js', () => ({
  storageManager: { on: vi.fn(), off: vi.fn() },
}));

vi.mock('@/config.js', () => ({
  getTranslationApiAsync: vi.fn(async () => 'google'),
  getTargetLanguageAsync: vi.fn(async () => 'fa'),
  TranslationMode: { Page: 'Page' },
}));

vi.mock('@/shared/logging/logger.js', () => ({
  getScopedLogger: vi.fn(() => ({
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  })),
}));

vi.mock('@/core/PageEventBus.js', () => ({
  pageEventBus: { emit: vi.fn() },
}));

vi.mock('@/shared/messaging/core/UnifiedMessaging.js', () => ({
  sendRegularMessage: vi.fn(() => Promise.resolve({ success: true })),
}));

vi.mock('@/shared/messaging/core/ContentScriptIntegration.js', () => ({
  registerTranslation: vi.fn(),
  contentScriptIntegration: {},
}));

vi.mock('@/shared/error-management/ErrorHandler.js', () => ({
  ErrorHandler: { getInstance: vi.fn(() => ({ handle: vi.fn() })) },
}));

vi.mock('@/core/extensionContext.js', () => ({
  default: { isValidSync: vi.fn(() => true) },
}));

vi.mock('@/features/shared/hover-preview/HoverPreviewLookup.js', () => ({
  hoverPreviewLookup: {
    add: vi.fn(),
    clear: vi.fn(),
  },
}));

vi.mock('@/utils/dom/DomDirectionManager.js', () => ({
  applyNodeDirection: vi.fn(),
  isRTL: vi.fn((language) => language === 'fa'),
  restoreElementDirection: vi.fn(),
  BIDI_MARKS: { RLM: '\u200f', LRM: '\u200e' },
}));

import { PageTranslationBridge } from './PageTranslationBridge.js';
import { PageTranslationEventManager } from './utils/PageTranslationEventManager.js';
import { MessageActions } from '@/shared/messaging/core/MessageActions.js';
import { applyNodeDirection } from '@/utils/dom/DomDirectionManager.js';
import { hoverPreviewLookup } from '@/features/shared/hover-preview/HoverPreviewLookup.js';

const settlement = (text, onSettle = vi.fn()) => {
  let state = 'pending';
  return {
    __pageTranslationSettlement: true,
    text,
    get state() {
      return state;
    },
    settle(outcome) {
      if (state !== 'pending') return false;
      state = outcome;
      onSettle(outcome);
      return true;
    },
  };
};

const terminalSettlement = (text, state, settle = vi.fn()) => ({
  __pageTranslationSettlement: true,
  text,
  state,
  settle,
});

const settings = {
  targetLanguage: 'fa',
  lazyLoading: false,
  showOriginalOnHover: false,
  autoTranslateOnDOMChanges: false,
  attributesToTranslate: ['title'],
};

describe('PageTranslationBridge stale settlement integration', () => {
  let bridge;
  let originalUrl;

  beforeEach(() => {
    originalUrl = window.location.href;
    document.body.innerHTML = '';
    document.body.removeAttribute('data-page-translated');
    document.body.removeAttribute('data-has-original');
    bridge = new PageTranslationBridge();
  });

  afterEach(() => {
    bridge.cleanup();
    window.history.replaceState(null, '', originalUrl);
  });

  const startDeferredTranslation = async (options = {}) => {
    const pending = [];
    const onTranslate = vi.fn((text, context, score, node) => new Promise(resolve => {
      pending.push({ text, node, resolve });
    }));

    await bridge.initialize({ ...settings, ...options }, onTranslate);
    bridge.translate(document.body);
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
    return { pending, onTranslate };
  };

  it('applies fresh text and leaves settlement accepted', async () => {
    const node = document.createTextNode('Original');
    document.body.appendChild(node);
    const { pending } = await startDeferredTranslation();
    const accepted = vi.fn();
    pending[0].resolve(settlement('Translated', accepted));

    await vi.waitFor(() => expect(node.nodeValue).toContain('Translated'));
    expect(accepted).toHaveBeenCalledWith('accepted');
    expect(applyNodeDirection).toHaveBeenCalled();
  });

  it('settles same-node duplicate updates once and applies only the newest generation', async () => {
    const node = document.createTextNode('Original');
    document.body.appendChild(node);
    const { pending, onTranslate } = await startDeferredTranslation();
    bridge.session.nodesTranslator.update(node);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(onTranslate.mock.calls.every(call => call[3] === node)).toBe(true);
    const obsoleteSettled = vi.fn();
    const freshSettled = vi.fn();
    const obsolete = settlement('Obsolete duplicate', obsoleteSettled);
    const fresh = settlement('Newest translation', freshSettled);
    const writes = [];
    const observer = new MutationObserver(records => writes.push(...records));
    observer.observe(node, { characterData: true });
    try {
      pending[1].resolve(fresh);
      await vi.waitFor(() => expect(fresh.state).toBe('accepted'));
      pending[0].resolve(obsolete);
      await vi.waitFor(() => expect(obsolete.state).toBe('stale'));

      expect(node.nodeValue).toContain('Newest translation');
      expect(node.nodeValue).not.toContain('Obsolete duplicate');
      expect(obsoleteSettled).toHaveBeenCalledExactlyOnceWith('stale');
      expect(freshSettled).toHaveBeenCalledExactlyOnceWith('accepted');
      expect(writes).toHaveLength(1);
      expect(onTranslate).toHaveBeenCalledTimes(2);
    } finally {
      observer.disconnect();
    }
  });

  it('does not invalidate pending output when the same node is translated twice', async () => {
    const node = document.createTextNode('Original');
    document.body.appendChild(node);
    const { pending, onTranslate } = await startDeferredTranslation();
    bridge.translate(document.body);
    expect(onTranslate).toHaveBeenCalledOnce();
    const accepted = vi.fn();
    const result = settlement('Translated once', accepted);
    pending[0].resolve(result);

    await vi.waitFor(() => expect(result.state).toBe('accepted'));
    expect(node.nodeValue).toContain('Translated once');
    expect(accepted).toHaveBeenCalledExactlyOnceWith('accepted');
    expect(pending).toHaveLength(1);
  });

  it.each([
    ['edited text', (node) => { node.nodeValue = 'Edited'; }],
    ['detached text', (node) => { node.remove(); }],
    ['replaced text', (node) => { node.replaceWith(document.createTextNode('Replacement')); }],
  ])('rejects stale %s without applying provider output', async (_name, mutate) => {
    const node = document.createTextNode('Original');
    document.body.appendChild(node);
    const { pending } = await startDeferredTranslation();
    const stale = vi.fn();
    mutate(node);
    pending[0].resolve(settlement('Translated', stale));

    await Promise.resolve();
    await Promise.resolve();
    expect(document.body.textContent).not.toContain('Translated');
    expect(stale).toHaveBeenCalledWith('stale');
  });

  it('rejects changed and recreated attributes by identity', async () => {
    const element = document.createElement('div');
    element.setAttribute('title', 'Original');
    document.body.appendChild(element);
    const { pending } = await startDeferredTranslation();
    const stale = vi.fn();

    element.removeAttribute('title');
    element.setAttribute('title', 'Replacement');
    pending[0].resolve(settlement('Translated', stale));

    await Promise.resolve();
    await Promise.resolve();
    expect(element.getAttribute('title')).toBe('Replacement');
    expect(stale).toHaveBeenCalledWith('stale');
  });

  it('cleans storage for stale initial work and allows later translation', async () => {
    const node = document.createTextNode('Original');
    document.body.appendChild(node);
    const { pending } = await startDeferredTranslation();
    const stale = vi.fn();

    node.nodeValue = 'Edited';
    pending[0].resolve(settlement('Translated', stale));
    await vi.waitFor(() => expect(bridge.session.nodesTranslator.has(node)).toBe(false));
    expect(stale).toHaveBeenCalledWith('stale');

    bridge.session.domTranslator.translate(node);
    await vi.waitFor(() => expect(pending.length).toBe(2));
    const accepted = vi.fn();
    pending[1].resolve(settlement('Fresh', accepted));

    await vi.waitFor(() => expect(node.nodeValue).toContain('Fresh'));
    expect(accepted).toHaveBeenCalledWith('accepted');
  });

  it('preserves newer storage when superseded task becomes stale', async () => {
    const node = document.createTextNode('one');
    document.body.appendChild(node);
    const { pending } = await startDeferredTranslation({ autoTranslateOnDOMChanges: true });

    node.nodeValue = 'two';
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(1));
    const stale = vi.fn();
    pending[0].resolve(settlement('old', stale));
    await Promise.resolve();
    await Promise.resolve();

    expect(stale).toHaveBeenCalledWith('stale');
    expect(bridge.session.nodesTranslator.has(node)).toBe(true);

    const accepted = vi.fn();
    pending[1].resolve(settlement('new', accepted));
    await vi.waitFor(() => expect(node.nodeValue).toContain('new'));
    expect(accepted).toHaveBeenCalledWith('accepted');
  });

  it('closes settlement when storage is removed before writer continuation', async () => {
    const node = document.createTextNode('Original');
    document.body.appendChild(node);
    const { pending } = await startDeferredTranslation();
    const stale = vi.fn();

    bridge.session.nodesTranslator.restore(node);
    pending[0].resolve(settlement('Translated', stale));
    await Promise.resolve();
    await Promise.resolve();

    expect(stale).toHaveBeenCalledWith('stale');
    expect(bridge.session.nodesTranslator.has(node)).toBe(false);
  });

  it('preserves active provider-failure storage compatibility', async () => {
    const node = document.createTextNode('Original');
    document.body.appendChild(node);
    const { pending } = await startDeferredTranslation();
    const failed = vi.fn();

    pending[0].resolve(terminalSettlement('Original', 'failed', failed));
    await vi.waitFor(() => expect(bridge.session.nodesTranslator.has(node)).toBe(true));

    expect(node.nodeValue).toBe('Original');
    expect(failed).not.toHaveBeenCalled();
  });

  it('preserves user edit after stale update and restore', async () => {
    const node = document.createTextNode('Original');
    document.body.appendChild(node);
    const { pending } = await startDeferredTranslation();

    pending[0].resolve(settlement('Translated'));
    await vi.waitFor(() => expect(node.nodeValue).toContain('Translated'));

    node.nodeValue = 'Edited';
    bridge.session.nodesTranslator.update(node);
    await vi.waitFor(() => expect(pending.length).toBe(2));
    node.nodeValue = 'Edited again';
    const stale = vi.fn();
    pending[1].resolve(settlement('Stale update', stale));
    await vi.waitFor(() => expect(stale).toHaveBeenCalledWith('stale'));

    bridge.restore(document.body);
    expect(node.nodeValue).toBe('Edited again');
  });

  it.each(['a-first', 'b-first'])('preserves Task B restore baseline when %s settles', async (order) => {
    const node = document.createTextNode('Original');
    document.body.appendChild(node);
    const { pending } = await startDeferredTranslation({ autoTranslateOnDOMChanges: true });

    pending[0].resolve(settlement('Initial'));
    await vi.waitFor(() => expect(node.nodeValue).toContain('Initial'));
    node.nodeValue = 'A';
    await vi.waitFor(() => expect(pending.length).toBe(2));
    node.nodeValue = 'B';
    await vi.waitFor(() => expect(pending.length).toBe(3));

    const stale = vi.fn();
    const accepted = vi.fn();
    if (order === 'a-first') {
      pending[1].resolve(settlement('A translation', stale));
      await vi.waitFor(() => expect(stale).toHaveBeenCalledWith('stale'));
      pending[2].resolve(settlement('B translation', accepted));
    } else {
      pending[2].resolve(settlement('B translation', accepted));
      await vi.waitFor(() => expect(accepted).toHaveBeenCalledWith('accepted'));
      pending[1].resolve(settlement('A translation', stale));
    }

    await vi.waitFor(() => expect(accepted).toHaveBeenCalledWith('accepted'));
    await vi.waitFor(() => expect(node.nodeValue).toContain('B translation'));
    bridge.restore(document.body);
    expect(node.nodeValue).toBe('B');
    expect(stale).toHaveBeenCalledWith('stale');
  });

  it('preserves changed attribute after stale update and restore', async () => {
    const element = document.createElement('div');
    element.setAttribute('title', 'Original');
    document.body.appendChild(element);
    const { pending } = await startDeferredTranslation();

    pending[0].resolve(settlement('Translated title'));
    await vi.waitFor(() => expect(element.getAttribute('title')).toContain('Translated title'));

    element.setAttribute('title', 'Edited');
    const attribute = element.getAttributeNode('title');
    bridge.session.nodesTranslator.update(attribute);
    await vi.waitFor(() => expect(pending.length).toBe(2));
    element.setAttribute('title', 'Edited again');
    const stale = vi.fn();
    pending[1].resolve(settlement('Stale title', stale));
    await vi.waitFor(() => expect(stale).toHaveBeenCalledWith('stale'));

    bridge.restore(document.body);
    expect(element.getAttribute('title')).toBe('Edited again');
  });

  it('skips stale post-processing and hover registration', async () => {
    const node = document.createTextNode('Original');
    document.body.appendChild(node);
    const { pending } = await startDeferredTranslation({ showOriginalOnHover: true });
    const stale = vi.fn();
    applyNodeDirection.mockClear();
    hoverPreviewLookup.add.mockClear();

    node.nodeValue = '\u200fEdited';
    pending[0].resolve(settlement('Translated', stale));
    await Promise.resolve();
    await Promise.resolve();

    expect(node.nodeValue).toBe('\u200fEdited');
    expect(applyNodeDirection).not.toHaveBeenCalled();
    expect(hoverPreviewLookup.add).not.toHaveBeenCalled();
    expect(node.parentElement?.getAttribute('data-page-translated')).toBeNull();
    expect(stale).toHaveBeenCalledWith('stale');
  });

  it('rejects settlement after bridge cleanup as cancelled', async () => {
    const node = document.createTextNode('Original');
    document.body.appendChild(node);
    const { pending } = await startDeferredTranslation();
    const cancelled = vi.fn();

    bridge.cleanup();
    pending[0].resolve(settlement('Translated', cancelled));
    await Promise.resolve();
    await Promise.resolve();

    expect(node.nodeValue).toBe('Original');
    expect(cancelled).toHaveBeenCalledWith('cancelled');
  });

  it.each(['pushState', 'replaceState'])('rejects pending output after SPA %s navigation', async (method) => {
    const node = document.createTextNode('Original');
    document.body.appendChild(node);
    const { pending } = await startDeferredTranslation();
    const stale = vi.fn();

    window.history[method](null, '', '/next-page');
    pending[0].resolve(settlement('Old page translation', stale));

    await vi.waitFor(() => expect(stale).toHaveBeenCalledWith('stale'));
    expect(node.nodeValue).toBe('Original');
    expect(bridge.session.nodesTranslator.has(node)).toBe(false);

    const { pending: nextPage } = await startDeferredTranslation();
    const accepted = vi.fn();
    nextPage[0].resolve(settlement('New page translation', accepted));
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledWith('accepted'));
    expect(node.nodeValue).toContain('New page translation');
  });

  it('rejects old output after a trusted same-URL SPA history round trip', async () => {
    const node = document.createTextNode('Original');
    document.body.appendChild(node);
    const { pending } = await startDeferredTranslation();
    browser.runtime.id = 'test-extension';
    const manager = {
      logger: bridge.logger,
      addEventListener: vi.fn((target, _event, handler) => target.addListener(handler)),
      removeEventListener: vi.fn((target, _event, handler) => target.removeListener(handler)),
      stopAutoTranslation: vi.fn(async () => bridge.stopPersistence()),
      resetError: vi.fn(),
    };
    const events = new PageTranslationEventManager(manager);
    try {
      window.history.pushState(null, '', '/other-page');
      window.history.replaceState(null, '', originalUrl);
      events.navigationListener({ action: MessageActions.SPA_NAVIGATION }, { id: browser.runtime.id });
      const cancelled = vi.fn();
      pending[0].resolve(settlement('Old page translation', cancelled));

      await vi.waitFor(() => expect(cancelled).toHaveBeenCalledWith('cancelled'));
      expect(node.nodeValue).toBe('Original');
      expect(manager.stopAutoTranslation).toHaveBeenCalledOnce();
    } finally {
      events.destroy();
    }
  });

  it('cancels stopped output while preserving completed nodes for restore', async () => {
    const completedNode = document.createTextNode('Completed source');
    const pendingElement = document.createElement('p');
    const pendingNode = document.createTextNode('Pending source');
    pendingElement.appendChild(pendingNode);
    document.body.append(completedNode, pendingElement);
    const { pending } = await startDeferredTranslation();
    await vi.waitFor(() => expect(pending.length).toBe(2));
    pending.find(item => item.node === completedNode).resolve(settlement('Completed translation'));
    await vi.waitFor(() => expect(completedNode.nodeValue).toContain('Completed translation'));

    bridge.stopPersistence();
    const cancelled = vi.fn();
    pending.find(item => item.node === pendingNode).resolve(settlement('Stopped translation', cancelled));
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledWith('cancelled'));
    expect(pendingNode.nodeValue).toBe('Pending source');
    expect(completedNode.nodeValue).toContain('Completed translation');
    bridge.translate(document.body);
    expect(pending).toHaveLength(2);
    expect(bridge.session.active).toBe(false);

    bridge.restore(document.body);
    expect(completedNode.nodeValue).toBe('Completed source');
    const { pending: nextSession } = await startDeferredTranslation();
    nextSession.forEach(item => item.resolve(settlement('Retranslated')));
    await vi.waitFor(() => expect(pendingNode.nodeValue).toContain('Retranslated'));
  });

  it('rejects older persistent work after an ABA source change', async () => {
    const node = document.createTextNode('one');
    document.body.appendChild(node);
    const { pending } = await startDeferredTranslation({ autoTranslateOnDOMChanges: true });

    node.nodeValue = 'two';
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(1));
    node.nodeValue = 'one';
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(2));

    const stale = vi.fn();
    pending[0].resolve(settlement('old translation', stale));
    await Promise.resolve();
    await Promise.resolve();

    expect(node.nodeValue).toBe('one');
    expect(stale).toHaveBeenCalledWith('stale');
  });
});
