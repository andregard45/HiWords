import type { HiWordsSettings, WordDefinition } from './index';
import { Trie } from './trie';
import type { VocabularyManager } from '../core';

// ==================== File highlight decision ====================

/**
 * Check whether a file should be highlighted
 * @param filePath the file path
 * @param settings the plugin settings
 * @returns whether the file should be highlighted
 */
export function shouldHighlightFile(filePath: string, settings: HiWordsSettings): boolean {
    const mode = settings.highlightMode || 'all';
    
    // Mode 1: highlight everything
    if (mode === 'all') {
        return true;
    }
    
    // Parse the path list (comma-separated, trimmed)
    const pathsStr = settings.highlightPaths || '';
    const paths = pathsStr
        .split(',')
        .map(p => p.trim())
        .filter(p => p.length > 0);
    
    // If the path list is empty
    if (paths.length === 0) {
        // In exclude mode an empty list = highlight all; in include mode an empty list = highlight none
        return mode === 'exclude';
    }
    
    // Normalize the current file path
    const normalizedFile = filePath.replace(/^\/+|\/+$/g, '');
    
    // Check whether the file path matches any rule
    const isMatched = paths.some(path => {
        const normalizedPath = path.replace(/^\/+|\/+$/g, '');
        return normalizedFile === normalizedPath || 
               normalizedFile.startsWith(normalizedPath + '/');
    });
    
    // Mode 2: exclude mode - matched paths are not highlighted
    if (mode === 'exclude') {
        return !isMatched;
    }
    
    // Mode 3: include mode - only matched paths are highlighted
    if (mode === 'include') {
        return isMatched;
    }
    
    return true;
}

// ==================== DOM operations and viewport detection ====================

/**
 * Check whether an element is visible in the viewport
 */
export function isElementVisible(element: HTMLElement): boolean {
    const rect = element.getBoundingClientRect();
    const windowHeight = window.innerHeight || activeDocument.documentElement.clientHeight;
    const windowWidth = window.innerWidth || activeDocument.documentElement.clientWidth;
    
    // The element is at least partially within the viewport
    return (
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < windowHeight &&
        rect.left < windowWidth
    );
}

/**
 * Check whether the container is in the main editor (excludes sidebars, popovers, etc.)
 */
export function isInMainEditor(element: HTMLElement): boolean {
    return !element.closest('.workspace-leaf-content[data-type="hover-editor"]') &&
           !element.closest('.workspace-leaf-content[data-type="file-explorer"]') &&
           !element.closest('.workspace-leaf-content[data-type="outline"]') &&
           !element.closest('.workspace-leaf-content[data-type="backlink"]') &&
           !element.closest('.workspace-leaf-content[data-type="tag"]') &&
           !element.closest('.workspace-leaf-content[data-type="search"]') &&
           !element.closest('.hover-popover') &&
           !element.closest('.popover') &&
           !element.closest('.suggestion-container') &&
           !element.closest('.modal') &&
           !element.closest('.workspace-split.mod-right-split') &&
           !element.closest('.workspace-split.mod-left-split');
}

/**
 * Remove all highlight marks inside the element
 */
export function clearHighlights(element: HTMLElement): void {
    const highlights = element.querySelectorAll('.hi-words-highlight');
    highlights.forEach(highlight => {
        // Replace highlighted elements with plain text
        const textNode = activeDocument.createTextNode(highlight.textContent || '');
        highlight.parentNode?.replaceChild(textNode, highlight);
    });
    
    // Merge adjacent text nodes
    element.normalize();
}

// ==================== Trie construction ====================

/**
 * Build a Trie containing all words
 */
export function buildTrieFromVocabulary(vocabularyManager: VocabularyManager): Trie<WordDefinition> {
    const trie = new Trie<WordDefinition>();
    const definitions = vocabularyManager.getStudyDefinitionsForHighlight();
    for (const def of definitions) {
        trie.addWord(def.word, def);
        def.aliases?.forEach(alias => {
            if (alias) trie.addWord(alias, def);
        });
    }
    return trie;
}
