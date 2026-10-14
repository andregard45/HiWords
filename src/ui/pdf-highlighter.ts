import type { App, EventRef, TFile, WorkspaceLeaf } from 'obsidian';
import type { HiWordsSettings } from '../utils';
import type { WordDefinition } from '../utils';
import { Trie, mapCanvasColorToCSSVar } from '../utils';
import type { VocabularyManager } from '../core';
import { isElementVisible, buildTrieFromVocabulary } from '../utils/highlight-utils';

interface PDFHighlighterPlugin {
  settings: HiWordsSettings;
  vocabularyManager: VocabularyManager;
  shouldHighlightFile: (filePath: string) => boolean;
  app: App;
  registerEvent: (eventRef: EventRef) => void;
  _pdfHighlighterCleanup?: () => void;
  _refreshPDFHighlighter?: () => void;
}

interface ObsidianInstanceOf {
  instanceOf: (type: typeof HTMLElement) => boolean;
}

function isHTMLElement(value: unknown): value is HTMLElement {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ObsidianInstanceOf>;
  return typeof candidate.instanceOf === 'function' && candidate.instanceOf(HTMLElement);
}

/**
 * Register word highlighting in PDF views
 * Highlights words in PDF content by observing text-layer rendering
 */
export function registerPDFHighlighter(plugin: PDFHighlighterPlugin): void {
  const processedTextLayers = new WeakSet<HTMLElement>();
  let debounceTimer: number | null = null;
  let refreshTimer: number | null = null;
  let refreshBurstTimers: number[] = [];
  const observedTextLayers = new WeakSet<HTMLElement>();

  const clearRefreshBurstTimers = () => {
    refreshBurstTimers.forEach(timer => window.clearTimeout(timer));
    refreshBurstTimers = [];
  };

  const debouncedRefreshPDF = (delay = 150) => {
    if (refreshTimer) {
      window.clearTimeout(refreshTimer);
    }

    refreshTimer = window.setTimeout(() => {
      refreshVisiblePDFPages(plugin, processedTextLayers);
      refreshTimer = null;
    }, delay);
  };

  const refreshPDFSoon = () => {
    clearRefreshBurstTimers();
    [0, 80, 200, 500, 1000].forEach((delay) => {
      const timer = window.setTimeout(() => {
        refreshVisiblePDFPages(plugin, processedTextLayers);
        refreshBurstTimers = refreshBurstTimers.filter(activeTimer => activeTimer !== timer);
      }, delay);
      refreshBurstTimers.push(timer);
    });
  };

  const handleWindowResize = () => refreshPDFSoon();
  const handleWindowScroll = () => debouncedRefreshPDF(120);

  const resizeObserver = new ResizeObserver((entries) => {
    let shouldRefresh = false;

    entries.forEach((entry) => {
      const target = entry.target as HTMLElement;
      if (target.closest('.pdf-container, .mod-pdf')) {
        shouldRefresh = true;
      }
    });

    if (shouldRefresh) {
      refreshPDFSoon();
    }
  });

  /**
   * Handle PDF text-layer highlighting
   */
  const processPDFTextLayer = (textLayer: HTMLElement, trie: Trie<WordDefinition>) => {
    // Avoid processing the same text layer twice
    if (processedTextLayers.has(textLayer)) {
      return;
    }
    processedTextLayers.add(textLayer);

    try {
      observePDFTextLayer(textLayer);
      highlightPDFTextSpans(textLayer, trie, plugin.settings.highlightStyle || 'underline');
    } catch (error) {
      console.error('PDF text layer highlight processing failed:', error);
    }
  };

  const observePDFTextLayer = (textLayer: HTMLElement) => {
    if (observedTextLayers.has(textLayer)) return;
    observedTextLayers.add(textLayer);
    resizeObserver.observe(textLayer);

    const page = textLayer.closest('.page');
    if (isHTMLElement(page)) {
      resizeObserver.observe(page);
    }
  };

  /**
   * Debounce PDF highlight updates
   */
  const debouncedProcessPDF = () => {
    if (debounceTimer) {
      window.clearTimeout(debounceTimer);
    }
    
    debounceTimer = window.setTimeout(() => {
      if (!plugin.settings.enableAutoHighlight) return;
      
      // Get the current active file
      const activeFile = plugin.app.workspace.getActiveFile();
      if (activeFile && !plugin.shouldHighlightFile(activeFile.path)) {
        return;
      }
      
      const trie = buildTrieFromVocabulary(plugin.vocabularyManager);
      
      // Find all PDF text layers
      const textLayers = activeDocument.querySelectorAll('.textLayer');
      textLayers.forEach((textLayer) => {
        // Check whether we are in a PDF view
        const pdfContainer = textLayer.closest('.pdf-container, .mod-pdf');
        if (pdfContainer) {
          processPDFTextLayer(textLayer as HTMLElement, trie);
        }
      });
      
      debounceTimer = null;
    }, 300);
  };

  /**
   * Listen for PDF view changes
   */
  const setupPDFObserver = () => {
    const observer = new MutationObserver((mutations) => {
      let shouldProcess = false;
      let shouldRefresh = false;
      
      mutations.forEach((mutation) => {
        if (
          mutation.type === 'attributes' &&
          isHTMLElement(mutation.target) &&
          (mutation.target.classList.contains('textLayer') || mutation.target.classList.contains('page')) &&
          mutation.target.closest('.pdf-container, .mod-pdf')
        ) {
          shouldRefresh = true;
        }

        // Inspect newly added nodes
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const element = node as HTMLElement;
            
            // Detect PDF text layers
            if (element.classList.contains('textLayer') || 
                element.querySelector('.textLayer')) {
              shouldProcess = true;
            }
            
            // Detect PDF page containers
            if (element.classList.contains('page') && 
                element.closest('.pdf-container, .mod-pdf')) {
              shouldProcess = true;
            }
          }
        });
      });
      
      if (shouldRefresh) {
        refreshPDFSoon();
      }

      if (shouldProcess) {
        debouncedProcessPDF();
      }
    });

    observer.observe(activeDocument.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'data-main-rotation'],
      characterData: false
    });

    return observer;
  };

  /**
   * Listen for workspace layout changes
   */
  plugin.registerEvent(
    plugin.app.workspace.on('layout-change', () => {
      // Process with a delay so the PDF view finishes loading
      window.setTimeout(() => {
        refreshPDFSoon();
      }, 500);
    })
  );

  window.addEventListener('resize', handleWindowResize);
  window.addEventListener('scroll', handleWindowScroll, true);

  /**
   * Listen for active-leaf changes
   */
  plugin.registerEvent(
    plugin.app.workspace.on('active-leaf-change', (leaf: WorkspaceLeaf | null) => {
      if (leaf?.view?.getViewType() === 'pdf') {
        // When switching to a PDF view, process highlights with a delay
        window.setTimeout(() => {
          debouncedProcessPDF();
        }, 1000);
      }
    })
  );

  /**
   * Listen for file-open events
   */
  plugin.registerEvent(
    plugin.app.workspace.on('file-open', (file: TFile | null) => {
      if (file?.extension === 'pdf') {
        window.setTimeout(() => {
          debouncedProcessPDF();
        }, 1500);
      }
    })
  );

  // Set up the DOM observer
  const observer = setupPDFObserver();

  // Initially process existing PDF views
  window.setTimeout(() => {
    debouncedProcessPDF();
  }, 1000);

  // Cleanup function (if needed)
  const cleanup = () => {
    if (debounceTimer) {
      window.clearTimeout(debounceTimer);
    }
    if (refreshTimer) {
      window.clearTimeout(refreshTimer);
    }
    clearRefreshBurstTimers();
    observer.disconnect();
    resizeObserver.disconnect();
    window.removeEventListener('resize', handleWindowResize);
    window.removeEventListener('scroll', handleWindowScroll, true);
    clearAllPDFHighlights();
  };

  // Store the cleanup function on the plugin instance (optional)
  plugin._pdfHighlighterCleanup = cleanup;
  
  // Export the refresh function onto the plugin instance
  plugin._refreshPDFHighlighter = () => {
    refreshVisiblePDFPages(plugin, processedTextLayers);
  };
}

/**
 * Remove all highlight marks in the PDF text layer
 */
function clearPDFHighlights(textLayer: HTMLElement): void {
  textLayer.querySelectorAll('.hi-words-pdf-highlight').forEach(highlight => highlight.remove());
}

function clearAllPDFHighlights(): void {
  activeDocument.querySelectorAll('.pdf-container .hi-words-pdf-highlight, .mod-pdf .hi-words-pdf-highlight')
    .forEach(highlight => highlight.remove());
}

/**
 * Highlight all text spans in the PDF text layer
 */
function highlightPDFTextSpans(textLayer: HTMLElement, trie: Trie<WordDefinition>, highlightStyle: string): void {
  bindPDFOverlayHover(textLayer);

  const overlayFragment = activeDocument.createDocumentFragment();
  let hasHighlights = false;
  const textSpans = textLayer.querySelectorAll('span[role="presentation"]');
  
  textSpans.forEach(span => {
    if (span.closest('.hi-words-tooltip')) {
      return;
    }

    const text = span.textContent || '';
    if (!text.trim()) return;

    const matches = trie.findAllMatches(text);

    if (!matches || matches.length === 0) return;

    // Process matches to avoid overlaps
    matches.sort((a, b) => a.from - b.from || (b.to - b.from) - (a.to - a.from));
    const filtered: typeof matches = [];
    let end = 0;
    for (const m of matches) {
      if (m.from >= end) {
        filtered.push(m);
        end = m.to;
      }
    }

    if (filtered.length === 0) return;

    for (const match of filtered) {
      const def = match.payload;
      const color = mapCanvasColorToCSSVar(def?.color, 'var(--color-base-60)');
      const created = createPDFHighlightOverlay(textLayer, span as HTMLElement, match.from, match.to, {
        word: match.word,
        definition: def?.definition,
        color,
        style: highlightStyle
      }, overlayFragment);
      hasHighlights = hasHighlights || created;
    }
  });

  clearPDFHighlights(textLayer);
  if (hasHighlights) {
    textLayer.appendChild(overlayFragment);
  }
}

function createPDFHighlightOverlay(
  textLayer: HTMLElement,
  textSpan: HTMLElement,
  from: number,
  to: number,
  data: { word: string; definition?: string; color?: string; style: string },
  target: DocumentFragment
): boolean {
  const textNode = Array.from(textSpan.childNodes).find(node => node.nodeType === Node.TEXT_NODE);
  if (!textNode) return false;

  const range = activeDocument.createRange();
  const textLength = textNode.textContent?.length || 0;
  range.setStart(textNode, Math.min(from, textLength));
  range.setEnd(textNode, Math.min(to, textLength));

  const layerRect = textLayer.getBoundingClientRect();
  const scaleX = layerRect.width && textLayer.offsetWidth ? layerRect.width / textLayer.offsetWidth : 1;
  const scaleY = layerRect.height && textLayer.offsetHeight ? layerRect.height / textLayer.offsetHeight : 1;
  const rects = Array.from(range.getClientRects());
  range.detach();

  let created = false;
  rects.forEach(rect => {
    if (rect.width <= 0 || rect.height <= 0) return;

    const overlay = activeDocument.createElement('span');
    overlay.className = 'hi-words-highlight hi-words-pdf-highlight';
    overlay.setAttribute('data-word', data.word);
    if (data.definition) overlay.setAttribute('data-definition', data.definition);
    if (data.color) overlay.setAttribute('data-color', data.color);
    overlay.setAttribute('data-style', data.style);
    overlay.style.setProperty('--word-highlight-color', data.color || 'var(--color-base-60)');
    overlay.style.left = `${(rect.left - layerRect.left) / scaleX + textLayer.scrollLeft}px`;
    overlay.style.top = `${(rect.top - layerRect.top) / scaleY + textLayer.scrollTop}px`;
    overlay.style.width = `${rect.width / scaleX}px`;
    overlay.style.height = `${rect.height / scaleY}px`;

    target.appendChild(overlay);
    created = true;
  });

  return created;
}

function bindPDFOverlayHover(textLayer: HTMLElement): void {
  if (textLayer.dataset.hiWordsPdfHoverBound === 'true') return;
  textLayer.dataset.hiWordsPdfHoverBound = 'true';

  let activeOverlay: HTMLElement | null = null;

  const clearActive = () => {
    if (!activeOverlay) return;
    activeOverlay.removeClass('is-hovered');
    activeOverlay.dispatchEvent(new MouseEvent('mouseout', {
      bubbles: true,
      relatedTarget: textLayer
    }));
    activeOverlay = null;
  };

  textLayer.addEventListener('mousemove', (event) => {
    if (event.buttons !== 0) {
      clearActive();
      return;
    }

    const overlays = Array.from(textLayer.querySelectorAll<HTMLElement>('.hi-words-pdf-highlight'));
    const nextOverlay = overlays.find(overlay => {
      const rect = overlay.getBoundingClientRect();
      return event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;
    }) || null;

    if (nextOverlay === activeOverlay) return;

    clearActive();
    activeOverlay = nextOverlay;
    if (activeOverlay) {
      activeOverlay.addClass('is-hovered');
      activeOverlay.dispatchEvent(new MouseEvent('mouseover', {
        bubbles: true,
        relatedTarget: textLayer
      }));
    }
  });

  textLayer.addEventListener('mouseleave', clearActive);
  textLayer.addEventListener('mousedown', clearActive);
}

/**
 * Refresh PDF highlights in the visible area
 */
function refreshVisiblePDFPages(
  plugin: PDFHighlighterPlugin,
  processedTextLayers: WeakSet<HTMLElement>
): void {
  if (!plugin.settings.enableAutoHighlight) {
    clearAllPDFHighlights();
    return;
  }
  
  try {
    // Rebuild the Trie
    const trie = buildTrieFromVocabulary(plugin.vocabularyManager);
    
    // Find all PDF text layers
    const textLayers = activeDocument.querySelectorAll('.textLayer');
    
    textLayers.forEach(textLayer => {
      const htmlTextLayer = textLayer as HTMLElement;
      
      // Check whether we are in a PDF view
      const pdfContainer = htmlTextLayer.closest('.pdf-container, .mod-pdf');
      if (!pdfContainer) return;
      
      // Process only visible text layers
      if (!isElementVisible(htmlTextLayer)) return;
      
      // Clear the processed flag on this text layer
      processedTextLayers.delete(htmlTextLayer);
      
      // Re-highlight
      highlightPDFTextSpans(htmlTextLayer, trie, plugin.settings.highlightStyle || 'underline');
      
      // Mark as processed
      processedTextLayers.add(htmlTextLayer);
    });
  } catch (error) {
    console.error('Failed to refresh PDF highlights:', error);
  }
}

/**
 * Clean up PDF highlighter resources
 */
export function cleanupPDFHighlighter(plugin: PDFHighlighterPlugin): void {
  if (plugin._pdfHighlighterCleanup) {
    plugin._pdfHighlighterCleanup();
    delete plugin._pdfHighlighterCleanup;
  }
}
