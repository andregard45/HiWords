import { 
    RangeSetBuilder, 
    Extension,
    StateField,
    StateEffect
} from '@codemirror/state';
import { 
    EditorView, 
    Decoration, 
    DecorationSet, 
    ViewUpdate,
    ViewPlugin,
    PluginSpec,
    PluginValue
} from '@codemirror/view';
import { editorInfoField } from 'obsidian';
import { VocabularyManager } from './vocabulary-manager';
import { WordMatch, WordDefinition, mapCanvasColorToCSSVar, Trie } from '../utils';
import { findPatternMatches } from '../utils/pattern-matcher';

// Debounce delay (milliseconds)
const DEBOUNCE_DELAY = 300;

// State effect: force-update highlights
const forceUpdateEffect = StateEffect.define<boolean>();

// Global highlighter manager
class HighlighterManager {
    private static instance: HighlighterManager;
    private highlighters: Set<WordHighlighter> = new Set();
    
    static getInstance(): HighlighterManager {
        if (!HighlighterManager.instance) {
            HighlighterManager.instance = new HighlighterManager();
        }
        return HighlighterManager.instance;
    }
    
    register(highlighter: WordHighlighter): void {
        this.highlighters.add(highlighter);
    }
    
    unregister(highlighter: WordHighlighter): void {
        this.highlighters.delete(highlighter);
    }
    
    refreshAll(): void {

        this.highlighters.forEach(highlighter => {
            try {
                highlighter.forceUpdate();
            } catch (error) {
                console.error('Failed to refresh highlighters:', error);
            }
        });
    }
    
    clear(): void {
        this.highlighters.clear();
    }
}

// Export the global instance
export const highlighterManager = HighlighterManager.getInstance();

// State field: stores currently highlighted vocabulary
const highlightState = StateField.define<DecorationSet>({
    create() {
        return Decoration.none;
    },
    update(decorations, tr) {
        // Do not use map to auto-adjust positions, as that causes wrong highlight positions
        // Instead rely on the ViewPlugin rescanning the document to update highlights
        // Problem with map: it mechanically shifts positions without re-matching words
        
        for (const effect of tr.effects) {
            if (effect.is(forceUpdateEffect)) {
                // Force decorators to be rebuilt
                return Decoration.none;
            }
        }
        
        // Keep current decorators and wait for the ViewPlugin to update
        return decorations;
    },
    provide: f => EditorView.decorations.from(f)
});

// Vocabulary highlight plugin
export class WordHighlighter implements PluginValue {
    decorations: DecorationSet;
    private vocabularyManager: VocabularyManager;
    private editorView: EditorView;
    private wordTrie: Trie;
    private patternDefinitions: WordDefinition[] = []; // Cached pattern-phrase list
    private debounceTimer: number | null = null;
    private lastRanges: {from: number, to: number}[] = [];
    private cachedMatches: Map<string, WordMatch[]> = new Map();
    protected shouldHighlightFile?: (filePath: string) => boolean;

    constructor(view: EditorView, vocabularyManager: VocabularyManager, shouldHighlightFile?: (filePath: string) => boolean) {
        this.editorView = view;
        this.vocabularyManager = vocabularyManager;
        this.shouldHighlightFile = shouldHighlightFile;
        this.wordTrie = new Trie();
        this.buildWordTrie();
        this.decorations = this.buildDecorations(view);
        
        // Register with the global manager
        highlighterManager.register(this);
    }

    /**
     * Build the word trie and cache the pattern-phrase list at the same time
     * Only plain words go into the Trie; pattern phrases are cached in patternDefinitions
     */
    private buildWordTrie() {
        this.wordTrie.clear();
        this.patternDefinitions = []; // Clear the pattern-phrase cache
        
        // Get deduplicated unmastered study objects (mastered ones are not highlighted)
        const definitions = this.vocabularyManager.getStudyDefinitionsForHighlight();
        
        // Add headwords and aliases to the trie while caching pattern phrases
        for (const definition of definitions) {
            if (definition.isPattern) {
                this.patternDefinitions.push(definition);
                continue;
            }

            this.wordTrie.addWord(definition.word, definition);
            if (definition.aliases) {
                definition.aliases.forEach(alias => {
                    if (alias) this.wordTrie.addWord(alias, definition);
                });
            }
        }
    }

    update(update: ViewUpdate) {
        // If document content changed, update highlights immediately (no debounce)
        if (update.docChanged) {
            // Clear caches to ensure re-matching
            this.cachedMatches.clear();
            // Rebuild decorators immediately
            this.decorations = this.buildDecorations(update.view);
        }
        // For viewport or focus-only changes, use debouncing
        else if (update.viewportChanged || update.focusChanged) {
            this.debouncedUpdate(update.view);
        }
    }

    /**
     * Force-update highlights
     */
    forceUpdate() {
        // Rebuild the trie
        this.buildWordTrie();
        
        // Clear caches
        this.cachedMatches.clear();
        
        // Rebuild decorators
        this.decorations = this.buildDecorations(this.editorView);
        this.editorView.dispatch({
            effects: forceUpdateEffect.of(true)
        });
    }
    
    /**
     * Debounced update handler
     */
    private debouncedUpdate(view: EditorView) {
        if (this.debounceTimer) {
            window.clearTimeout(this.debounceTimer);
        }
        
        this.debounceTimer = window.setTimeout(() => {
            this.decorations = this.buildDecorations(view);
            this.debounceTimer = null;
        }, DEBOUNCE_DELAY);
    }

    /**
     * Build decorators
     */
    private buildDecorations(view: EditorView): DecorationSet {
        // Check whether auto-highlight is enabled
        const settings = this.vocabularyManager.getSettings();
        if (!settings.enableAutoHighlight) {
            // If highlighting is disabled, return empty decorations
            return Decoration.none;
        }
        
        // Check whether the current file should be highlighted
        if (this.shouldHighlightFile) {
            const file = view.state.field(editorInfoField);
            if (file?.file?.path && !this.shouldHighlightFile(file.file.path)) {
                // If the file should not be highlighted, return empty decorations
                return Decoration.none;
            }
        }
        
        const builder = new RangeSetBuilder<Decoration>();
        const matches: WordMatch[] = [];
        
        // Check whether the visible range changed
        const currentRanges = view.visibleRanges;
        const rangesChanged = this.haveRangesChanged(currentRanges);
        
        // If the visible range is unchanged and cached, reuse cached matches
        const cacheKey = currentRanges.map(r => `${r.from}-${r.to}`).join(',');
        const cachedMatches = this.cachedMatches.get(cacheKey);
        if (!rangesChanged && cachedMatches) {
            this.applyDecorations(builder, cachedMatches);
            return builder.finish();
        }
        
        // Update the last processed range
        this.lastRanges = currentRanges.map(range => ({from: range.from, to: range.to}));
        
        // Scan text within the visible range
        for (const { from, to } of view.visibleRanges) {
            const text = view.state.sliceDoc(from, to);
            matches.push(...this.findWordMatches(text, from));
        }

        // Sort by position
        matches.sort((a, b) => a.from - b.from);
        
        // Handle overlapping matches
        const filteredMatches = this.removeOverlaps(matches);
        
        // Cache the result
        this.cachedMatches.set(cacheKey, filteredMatches);
        
        // Apply decorations
        this.applyDecorations(builder, filteredMatches);
        
        return builder.finish();
    }
    
    /**
     * Apply decorations to the builder
     * Supports segmented highlighting for pattern phrases
     */
    private applyDecorations(builder: RangeSetBuilder<Decoration>, matches: WordMatch[]) {
        // Get the current highlight style setting
        const highlightStyle = this.vocabularyManager.getSettings().highlightStyle || 'underline';
        
        matches.forEach(match => {
            // Use the same default gray as the sidebar view
            const highlightColor = mapCanvasColorToCSSVar(match.definition.color, 'var(--color-base-60)');
            
            // For pattern phrases with segment info, highlight each segment
            if (match.segments && match.segments.length > 0) {
                match.segments.forEach(segment => {
                    builder.add(
                        segment.from, 
                        segment.to, 
                        Decoration.mark({
                            class: `hi-words-highlight`,
                            attributes: {
                                'data-word': match.word,
                                'data-definition': match.definition.definition,
                                'data-color': highlightColor,
                                'data-style': highlightStyle,
                                'style': `--word-highlight-color: ${highlightColor};`
                            }
                        })
                    );
                });
            } else {
                // Plain word: highlight as a whole
                builder.add(
                    match.from, 
                    match.to, 
                    Decoration.mark({
                        class: `hi-words-highlight`,
                        attributes: {
                            'data-word': match.word,
                            'data-definition': match.definition.definition,
                            'data-color': highlightColor,
                            'data-style': highlightStyle,
                            'style': `--word-highlight-color: ${highlightColor};`
                        }
                    })
                );
            }
        });
    }
    
    /**
     * Check whether the visible range changed
     */
    private haveRangesChanged(currentRanges: readonly {from: number, to: number}[]): boolean {
        if (this.lastRanges.length !== currentRanges.length) {
            return true;
        }
        
        for (let i = 0; i < currentRanges.length; i++) {
            if (currentRanges[i].from !== this.lastRanges[i].from || 
                currentRanges[i].to !== this.lastRanges[i].to) {
                return true;
            }
        }
        
        return false;
    }

    /**
     * Find vocabulary matches in the text
     * Use the trie for efficient plain-word matching and pattern matching for phrases
     * Optimization: use the cached pattern-phrase list to avoid repeated lookups
     */
    private findWordMatches(text: string, offset: number): WordMatch[] {
        const matches: WordMatch[] = [];
        
        try {
            // Use the trie to find all plain-word matches
            const trieMatches = this.wordTrie.findAllMatches(text);
            
            // Convert into WordMatch objects
            for (const match of trieMatches) {
                const definition = match.payload as WordDefinition;
                if (definition) {
                    matches.push({
                        word: match.word,
                        definition,
                        from: offset + match.from,
                        to: offset + match.to,
                        color: mapCanvasColorToCSSVar(definition.color, 'var(--color-accent)')
                    });
                }
            }
            
            // Find pattern-phrase matches (optimized: uses the cached list)
            for (const definition of this.patternDefinitions) {
                if (definition.patternParts && definition.patternParts.length > 0) {
                    const patternMatches = findPatternMatches(text, definition.patternParts, offset);
                    for (const patternMatch of patternMatches) {
                        matches.push({
                            word: definition.word,
                            definition,
                            from: patternMatch.from,
                            to: patternMatch.to,
                            color: mapCanvasColorToCSSVar(definition.color, 'var(--color-accent)'),
                            matchedText: patternMatch.matchedText,
                            segments: patternMatch.segments
                        });
                    }
                }
            }
        } catch (e) {
            console.error('Error in findWordMatches:', e);
        }
        
        return matches;
    }

    /**
     * Remove overlapping matches efficiently with a cursor algorithm
     * Note: the current implementation allows overlapping highlights, which is more sensible for nested words (e.g. "art" and "start")
     */
    private removeOverlaps(matches: WordMatch[]): WordMatch[] {
        // Return all matches directly, allowing overlapping highlights
        // This correctly handles nested words, e.g. "art" appearing inside "start"
        return matches;
    }

    destroy() {
        // Clean up resources
        if (this.debounceTimer) {
            window.clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        
        this.cachedMatches.clear();
        this.wordTrie.clear();
        
        // Unregister from the global manager
        highlighterManager.unregister(this);
    }
}

// Create editor extensions
export function createWordHighlighterExtension(
    vocabularyManager: VocabularyManager,
    shouldHighlightFile?: (filePath: string) => boolean
): Extension {
    const pluginSpec: PluginSpec<WordHighlighter> = {
        decorations: (value: WordHighlighter) => value.decorations,
    };

    // Create a factory function passing vocabularyManager and the file-check function
    class WordHighlighterWithManager extends WordHighlighter {
        constructor(view: EditorView) {
            super(view, vocabularyManager, shouldHighlightFile);
        }
    }

    return [
        highlightState,
        ViewPlugin.fromClass(WordHighlighterWithManager, pluginSpec)
    ];
}

// Get the word under the cursor
export function getWordUnderCursor(view: EditorView): string | null {
    const cursor = view.state.selection.main.head;
    const line = view.state.doc.lineAt(cursor);
    const lineText = line.text;
    const relativePos = cursor - line.from;
    
    // Find word boundaries
    let start = relativePos;
    let end = relativePos;
    
    const wordRegex = /[a-zA-Z]/;
    
    // Search backwards for the word start
    while (start > 0 && wordRegex.test(lineText[start - 1])) {
        start--;
    }
    
    // Search forwards for the word end
    while (end < lineText.length && wordRegex.test(lineText[end])) {
        end++;
    }
    
    if (start === end) return null;
    
    return lineText.slice(start, end);
}
