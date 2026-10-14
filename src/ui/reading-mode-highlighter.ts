import type { MarkdownPostProcessorContext } from 'obsidian';
import type { HiWordsSettings, WordDefinition } from '../utils';
import { Trie, mapCanvasColorToCSSVar } from '../utils';
import type { VocabularyManager } from '../core';
import { isElementVisible, buildTrieFromVocabulary, clearHighlights, isInMainEditor } from '../utils/highlight-utils';

/**
 * Register a Markdown postprocessor in reading mode to highlight matched vocabulary.
 * It builds a Trie from VocabularyManager, walks rendered DOM text nodes and wraps them in span.hi-words-highlight.
 */
export function registerReadingModeHighlighter(plugin: {
  settings: HiWordsSettings;
  vocabularyManager: VocabularyManager;
  shouldHighlightFile: (filePath: string) => boolean;
  registerMarkdownPostProcessor: (
    processor: (el: HTMLElement, ctx: MarkdownPostProcessorContext) => void
  ) => void;
  _refreshReadingModeHighlighter?: () => void;
}): void {
  // Store a reference to the processing function for external calls
  let processorFn: ((el: HTMLElement, trie: Trie<WordDefinition>) => void) | null = null;

  const EXCLUDE_SELECTOR = [
    'pre',
    'code',
    'a',
    'button',
    'input',
    'textarea',
    'select',
    '.math',
    '.cm-inline-code',
    '.internal-embed',
    '.file-embed',
    '.hi-words-tooltip', // Exclude tooltip content
  ].join(',');

  const processElement = (root: HTMLElement, trie: Trie<WordDefinition>) => {
    const walker = activeDocument.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node: Node) => {
          // Process only visible text nodes; skip excluded elements and already-highlighted areas
          const parent = node.parentNode?.nodeType === Node.ELEMENT_NODE
            ? node.parentNode as HTMLElement
            : null;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (parent.closest(EXCLUDE_SELECTOR)) return NodeFilter.FILTER_REJECT;
          if (parent.closest('.hi-words-highlight')) return NodeFilter.FILTER_REJECT;
          if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );

    const highlightStyle = plugin.settings.highlightStyle || 'underline';

    const textNodes: Text[] = [];
    let current: Node | null = walker.nextNode();
    while (current) {
      textNodes.push(current as Text);
      current = walker.nextNode();
    }

    for (const textNode of textNodes) {
      const text = textNode.nodeValue || '';
      if (!text) continue;

      const matches = trie.findAllMatches(text);
      if (!matches || matches.length === 0) continue;

      // Left-to-right, preferring longer non-overlapping matches
      matches.sort((a, b) => a.from - b.from || (b.to - b.from) - (a.to - a.from));
      const filtered: typeof matches = [];
      let end = 0;
      for (const m of matches) {
        if (m.from >= end) {
          filtered.push(m);
          end = m.to;
        }
      }
      if (filtered.length === 0) continue;

      const frag = activeDocument.createDocumentFragment();
      let last = 0;
      for (const m of filtered) {
        if (m.from > last) frag.appendChild(activeDocument.createTextNode(text.slice(last, m.from)));
        const def = m.payload;
        const color = mapCanvasColorToCSSVar(def?.color, 'var(--color-base-60)');
        const span = activeDocument.createElement('span');
        span.className = 'hi-words-highlight';
        span.setAttribute('data-word', m.word);
        if (def?.definition) span.setAttribute('data-definition', def.definition);
        if (color) span.setAttribute('data-color', color);
        span.setAttribute('data-style', highlightStyle);
        if (color) span.setAttribute('style', `--word-highlight-color: ${color}`);
        span.textContent = text.slice(m.from, m.to);
        frag.appendChild(span);
        last = m.to;
      }
      if (last < text.length) frag.appendChild(activeDocument.createTextNode(text.slice(last)));

      if (textNode.parentNode) textNode.parentNode.replaceChild(frag, textNode);
    }
  };

  plugin.registerMarkdownPostProcessor((el, ctx) => {
    try {
      if (!plugin.settings.enableAutoHighlight) return;
      
      // Check whether the current file should be highlighted
      const filePath = ctx.sourcePath;
      if (filePath && !plugin.shouldHighlightFile(filePath)) {
        return;
      }
      
      // Check whether we are in the main editor's reading mode (excludes sidebars, hover previews, other containers)
      if (!isInMainEditor(el)) return;
      
      const trie = buildTrieFromVocabulary(plugin.vocabularyManager);
      // Save the processing function reference
      processorFn = processElement;
      processElement(el, trie);
    } catch (e) {
      console.error('Reading mode highlight processing failed:', e);
    }
  });

  // Export the refresh function onto the plugin instance
  plugin._refreshReadingModeHighlighter = () => {
    refreshVisibleReadingMode(plugin, processorFn);
  };
}

/**
 * Refresh reading-mode highlights in the visible area
 */
function refreshVisibleReadingMode(
  plugin: {
    settings: HiWordsSettings;
    vocabularyManager: VocabularyManager;
    shouldHighlightFile: (filePath: string) => boolean;
  },
  processElement: ((el: HTMLElement, trie: Trie<WordDefinition>) => void) | null
): void {
  if (!plugin.settings.enableAutoHighlight || !processElement) return;
  
  try {
    // Rebuild the Trie
    const trie = buildTrieFromVocabulary(plugin.vocabularyManager);
    
    // Find all reading-mode containers
    const readingContainers = activeDocument.querySelectorAll('.markdown-preview-view .markdown-preview-sizer');
    
    readingContainers.forEach(container => {
      const htmlContainer = container as HTMLElement;
      
      // Check whether the container is in the main editor (excludes sidebars, etc.)
      if (!isInMainEditor(htmlContainer)) return;
      
      // Process only visible containers
      if (!isElementVisible(htmlContainer)) return;
      
      // Clear existing highlights
      clearHighlights(htmlContainer);
      
      // Re-highlight
      processElement(htmlContainer, trie);
    });
  } catch (error) {
    console.error('Failed to refresh reading mode highlights:', error);
  }
}
