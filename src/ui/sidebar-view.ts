import { EventRef, ItemView, WorkspaceLeaf, TFile, MarkdownView, MarkdownRenderer, setIcon, Notice } from 'obsidian';
import HiWordsPlugin from '../../main';
import { WordDefinition, mapCanvasColorToCSSVar, getColorWithOpacity, playWordTTS, Trie } from '../utils';
import { t } from '../i18n';
import { findPatternMatches } from '../utils/pattern-matcher';
import { renderWordCard } from './word-card-renderer';
import { WordNoteModal } from './word-note-modal';

export const SIDEBAR_VIEW_TYPE = 'hi-words-sidebar';

type HiWordsWorkspaceEventName = 'hi-words:mastered-changed' | 'hi-words:settings-changed';

interface HiWordsWorkspaceEvents {
    on(name: HiWordsWorkspaceEventName, callback: () => void): EventRef;
}

interface HoverLinkWorkspace {
    trigger(name: 'hover-link', payload: {
        event: Event;
        source: string;
        hoverParent: HTMLElement;
        target: HTMLElement;
        linktext: string;
        sourcePath: string;
    }): void;
}

interface SearchViewLike {
    setQuery?: (query: string) => void;
}

export class HiWordsSidebarView extends ItemView {
    private plugin: HiWordsPlugin;
    private currentWords: WordDefinition[] = [];
    private activeTab: 'learning' | 'mastered' = 'learning';
    private currentFile: TFile | null = null;
    private firstLoadForFile = false; // Applies only to the first render after switching to a new file
    private updateTimer: number | null = null; // Coalesce/debounce updates
    private delegatedBound = false; // Whether root-level event delegation is bound
    private lastInteractionTime = 0; // Timestamp of the last interaction
    private patternDefinitionsCache: WordDefinition[] = []; // Cached pattern-phrase list
    private normalDefinitionsCache: WordDefinition[] = []; // Cached plain-word list
    private sectionTabStates: Map<string, number> = new Map(); // Track the currently active section tab per word
    private expandedWordStates: Map<string, boolean> = new Map(); // Track word cards manually expanded/collapsed by the user
    private manualDetailMode = false; // When the word-management page opens details, do not follow the current document scan results

    constructor(leaf: WorkspaceLeaf, plugin: HiWordsPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string {
        return SIDEBAR_VIEW_TYPE;
    }

    getDisplayText(): string {
        return t('sidebar.title');
    }

    getIcon(): string {
        return 'book-open';
    }

    async onOpen() {
        const container = this.containerEl.children[1];
        container.empty();
        container.addClass('hi-words-sidebar');
        this.bindDelegatedHandlers(container as HTMLElement);
        
        // Initial display
        this.scheduleUpdate(0);

        // Listen for file-open (instead of active-leaf-change) so activating the sidebar does not trigger updates
        this.registerEvent(
            this.app.workspace.on('file-open', (file: TFile | null) => {
                if (this.isSupportedDocumentFile(file)) {
                    this.manualDetailMode = false;
                }
                this.scheduleUpdate(120);
            })
        );

        // Switching back from the word-management page to an already-open document tab does not necessarily fire file-open in Obsidian.
        // Here we only respond to real Markdown/PDF document leaves to avoid spurious refreshes when activating the sidebar itself.
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', (leaf: WorkspaceLeaf | null) => {
                const file = this.getSupportedDocumentFileFromLeaf(leaf);
                if (!file) return;

                this.manualDetailMode = false;
                this.lastInteractionTime = 0;
                this.scheduleUpdate(0);
            })
        );

        // Listen for file content changes
        this.registerEvent(
            this.app.workspace.on('editor-change', () => {
                // Defer updates to avoid frequent refreshes
                this.scheduleUpdate(500);
            })
        );
        
        // Listen for file modifications (Canvas files and referenced Markdown files)
        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                if (file instanceof TFile) {
                    if (file.extension === 'canvas' || file.extension === 'md') {
                        this.scheduleUpdate(250);
                    }
                }
            })
        );
        
        // Listen for mastered-feature state changes
        this.registerEvent(
            (this.app.workspace as unknown as HiWordsWorkspaceEvents).on('hi-words:mastered-changed', () => {
                this.scheduleUpdate(100);
            })
        );
        
        // Listen for setting changes (e.g. the blur toggle)
        this.registerEvent(
            (this.app.workspace as unknown as HiWordsWorkspaceEvents).on('hi-words:settings-changed', () => {
                this.scheduleUpdate(100);
            })
        );
    }

    async onClose() {
        // Clean up resources
    }

    async focusWord(wordDef: WordDefinition, origin: 'document' | 'library' = 'document') {
        if (this.updateTimer !== null) {
            window.clearTimeout(this.updateTimer);
            this.updateTimer = null;
        }

        const key = this.getWordStateKey(wordDef);

        if (origin === 'library') {
            this.manualDetailMode = true;
            this.currentFile = null;
            this.currentWords = [wordDef];
            this.activeTab = wordDef.mastered ? 'mastered' : 'learning';
            this.expandedWordStates.set(key, true);
            this.firstLoadForFile = false;
            this.lastInteractionTime = Date.now();
            await this.renderWordList();
            this.scrollWordCardIntoView(key);
            return;
        }

        this.manualDetailMode = false;
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile && (activeFile.extension === 'md' || activeFile.extension === 'pdf') && (activeFile !== this.currentFile || this.currentWords.length === 0)) {
            this.currentFile = activeFile;
            this.firstLoadForFile = true;
            await this.scanCurrentDocument();
        }

        const existingIndex = this.currentWords.findIndex(item => this.getWordStateKey(item) === key);
        if (existingIndex < 0) {
            this.currentWords.unshift(wordDef);
        }
        this.activeTab = wordDef.mastered ? 'mastered' : 'learning';
        this.expandedWordStates.set(key, true);
        this.firstLoadForFile = false;
        this.lastInteractionTime = Date.now();
        await this.renderWordList();
        this.scrollWordCardIntoView(key);
    }

    public applyDefaultDisplayMode() {
        this.expandedWordStates.clear();
        void this.renderWordList();
    }

    private scrollWordCardIntoView(wordKey: string) {
        window.requestAnimationFrame(() => {
            const cards = this.containerEl.querySelectorAll('.hi-words-word-card');
            for (const card of Array.from(cards)) {
                if ((card as HTMLElement).getAttr('data-word-key') === wordKey) {
                    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                    return;
                }
            }
        });
    }

    /**
     * Update the sidebar view
     */
    private async updateView() {
        if (this.manualDetailMode) {
            return;
        }

        const activeFile = this.app.workspace.getActiveFile();
        
        if (!activeFile || (activeFile.extension !== 'md' && activeFile.extension !== 'pdf')) {
            this.showEmptyState('Open a Markdown document or PDF file first');
            return;
        }

        if (activeFile === this.currentFile && this.currentWords.length > 0) {
            // File unchanged and data already present; no rescan needed
            return;
        }

        // Record whether this is a switch to a new file
        const isFileChanged = activeFile !== this.currentFile;
        this.currentFile = activeFile;
        if (isFileChanged) {
            this.firstLoadForFile = true;
        }
        await this.scanCurrentDocument();
        await this.renderWordList();
    }

    /**
     * Coalesced updates: avoid queueing many setTimeouts when events fire densely
     */
    private scheduleUpdate(delay: number) {
        // If the user interacted recently (within 500ms), cancel the update
        const timeSinceInteraction = Date.now() - this.lastInteractionTime;
        if (timeSinceInteraction < 500) {
            return;
        }
        
        if (this.updateTimer !== null) {
            window.clearTimeout(this.updateTimer);
            this.updateTimer = null;
        }
        this.updateTimer = window.setTimeout(() => {
            this.updateTimer = null;
            void this.updateView();
        }, Math.max(0, delay));
    }

    private isSupportedDocumentFile(file: TFile | null | undefined): file is TFile {
        return !!file && (file.extension === 'md' || file.extension === 'pdf');
    }

    private getSupportedDocumentFileFromLeaf(leaf: WorkspaceLeaf | null): TFile | null {
        const view = leaf?.view;
        if (!view) return null;

        const file = (view as { file?: unknown }).file;
        if (!(file instanceof TFile) || !this.isSupportedDocumentFile(file)) {
            return null;
        }

        if (view instanceof MarkdownView && file.extension === 'md') {
            return file;
        }

        if (view.getViewType() === 'pdf' && file.extension === 'pdf') {
            return file;
        }

        return null;
    }

    /**
     * Scan the current document for known words
     * Optimization: use cached word lists to avoid repeated classification
     */
    private async scanCurrentDocument() {
        if (!this.currentFile) return;

        try {
            let content: string;
            
            // Extract content based on file type
            if (this.currentFile.extension === 'pdf') {
                content = await this.extractPDFText();
            } else {
                // Use cachedRead since we only read, never modify
                content = await this.app.vault.cachedRead(this.currentFile);
            }

            // Optimization: fetch and cache classified word lists
            await this.updateDefinitionsCache();

            const foundWordsByKey = new Map<string, { wordDef: WordDefinition, position: number }>();
            
            // Use a Trie to scan plain words and aliases in one pass, avoiding per-word regex scans on large dictionaries
            const trie = new Trie();
            for (const wordDef of this.normalDefinitionsCache) {
                trie.addWord(wordDef.word, wordDef);
                wordDef.aliases?.forEach(alias => {
                    if (alias) trie.addWord(alias, wordDef);
                });
            }

            for (const match of trie.findAllMatches(content)) {
                const wordDef = match.payload as WordDefinition;
                const key = this.getWordStateKey(wordDef);
                const existing = foundWordsByKey.get(key);
                if (!existing || match.from < existing.position) {
                    foundWordsByKey.set(key, {
                        wordDef,
                        position: match.from
                    });
                }
            }
            
            // Scan pattern phrases
            for (const wordDef of this.patternDefinitionsCache) {
                if (wordDef.patternParts && wordDef.patternParts.length > 0) {
                    // Use pattern matching
                    const matches = findPatternMatches(content, wordDef.patternParts, 0);
                    if (matches.length > 0) {
                        const position = matches[0].from;
                        const key = this.getWordStateKey(wordDef);
                        const existing = foundWordsByKey.get(key);
                        if (!existing || position < existing.position) {
                            foundWordsByKey.set(key, {
                                wordDef: wordDef,
                                position: position
                            });
                        }
                    }
                }
            }

            // Sort by each word's first occurrence position in the document
            const foundWordsWithPosition = [...foundWordsByKey.values()];
            foundWordsWithPosition.sort((a, b) => a.position - b.position);
            this.currentWords = foundWordsWithPosition.map(item => item.wordDef);
        } catch (error) {
            console.error('Failed to scan document:', error);
            this.currentWords = [];
        }
    }
    
    /**
     * Update the word-definition cache
     * Classify words into plain words and pattern phrases to avoid repeated checks
     */
    private async updateDefinitionsCache(): Promise<void> {
        const allWordDefinitions = this.plugin.vocabularyManager.getStudyDefinitions();
        
        this.normalDefinitionsCache = [];
        this.patternDefinitionsCache = [];
        
        for (const wordDef of allWordDefinitions) {
            if (wordDef.isPattern && wordDef.patternParts && wordDef.patternParts.length > 0) {
                this.patternDefinitionsCache.push(wordDef);
            } else {
                this.normalDefinitionsCache.push(wordDef);
            }
        }
    }

    /**
     * Render the word list
     */
    private async renderWordList() {
        const container = this.containerEl.querySelector('.hi-words-sidebar');
        if (!container) return;

        container.empty();
        // Ensure event delegation is bound (persists on the same root after the container is cleared)
        this.bindDelegatedHandlers(container as HTMLElement);

        if (this.currentWords.length === 0) {
            this.showEmptyState(t('sidebar.empty_state'));
            return;
        }

        // Group words: unmastered and mastered
        const unmasteredWords = this.currentWords.filter(word => !word.mastered);
        const masteredWords = this.currentWords.filter(word => word.mastered);
        

        // Smart initial tab selection: only on the first load after switching to a new file
        if (this.firstLoadForFile && this.activeTab === 'learning' && unmasteredWords.length === 0 && masteredWords.length > 0) {
            this.activeTab = 'mastered';
        }
        // After the first render, reset the flag so user clicks are not forced back
        this.firstLoadForFile = false;
        
        // Create the tab navigation
        this.createTabNavigation(container as HTMLElement, unmasteredWords.length, masteredWords.length);
        
        // Create the tab content
        await this.createTabContent(container as HTMLElement, unmasteredWords, masteredWords);
    }

    /**
     * Create the tab navigation
     */
    private createTabNavigation(container: HTMLElement, learningCount: number, masteredCount: number) {
        const tabNav = container.createEl('div', { cls: 'hi-words-tab-nav' });
        
        // To-learn tab
        const learningTab = tabNav.createEl('div', { 
            cls: `hi-words-tab ${this.activeTab === 'learning' ? 'active' : ''}`,
            attr: { 'data-tab': 'learning' }
        });
        learningTab.createEl('span', { text: `${t('sidebar.vocabulary_book')} (${learningCount})` });
        
        // Mastered tab (shown only when the feature is enabled)
        if (this.plugin.settings.enableMasteredFeature) {
            const masteredTab = tabNav.createEl('div', { 
                cls: `hi-words-tab ${this.activeTab === 'mastered' ? 'active' : ''}`,
                attr: { 'data-tab': 'mastered' }
            });
            masteredTab.createEl('span', { text: `${t('sidebar.mastered')} (${masteredCount})` });
        }
        
        // Note: tab clicks are handled centrally by delegation in bindDelegatedHandlers; no listener needed here
    }
    
    /**
     * Create the tab content
     */
    private async createTabContent(container: HTMLElement, unmasteredWords: WordDefinition[], masteredWords: WordDefinition[]) {
        if (this.activeTab === 'learning') {
            if (unmasteredWords.length > 0) {
                await this.createWordList(container, unmasteredWords, false);
            } else {
                this.createEmptyState(container, t('sidebar.no_learning_words'));
            }
        } else if (this.activeTab === 'mastered') {
            if (masteredWords.length > 0) {
                await this.createWordList(container, masteredWords, true);
            } else {
                this.createEmptyState(container, t('sidebar.no_mastered_words'));
            }
        }
    }
    
    /**
     * Switch tab
     */
    private switchTab(tab: 'learning' | 'mastered') {
        if (this.activeTab === tab) return;
        
        this.activeTab = tab;
        void this.renderWordList().catch(error => {
            console.error('HiWords failed to re-render sidebar:', error);
        });
    }
    
    /**
     * Create the word list
     */
    private async createWordList(container: HTMLElement, words: WordDefinition[], isMastered: boolean) {
        const wordList = container.createEl('div', { cls: 'hi-words-word-list' });
        
        for (const wordDef of words) {
            await this.createWordCard(wordList, wordDef, isMastered);
        }
    }

    /**
     * Create a word card
     * @param container the container element
     * @param wordDef the word definition
     * @param isMastered whether the word is mastered
     */
    private async createWordCard(container: HTMLElement, wordDef: WordDefinition, isMastered = false) {
        const wordKey = this.getWordStateKey(wordDef);
        const isExpanded = this.getWordExpandedState(wordDef);
        const card = container.createEl('div', {
            cls: `hi-words-word-card ${isExpanded ? 'is-expanded' : 'is-collapsed'}`,
            attr: { 'data-word-key': wordKey }
        });
        
        // Set CSS custom properties and let CSS apply the actual styles
        if (wordDef.color) {
            const borderColor = mapCanvasColorToCSSVar(wordDef.color, 'var(--color-base-60)');
            card.style.setProperty('--word-card-accent-color', borderColor);
            // Set a more vivid colored background
            const bgColor = getColorWithOpacity(borderColor, 0.1);
            card.style.setProperty('--word-card-bg-color', bgColor);
        }

        // Word title
        const wordTitle = card.createEl('div', { cls: 'hi-words-word-title' });
        const wordTextEl = wordTitle.createEl('span', {
            text: wordDef.word,
            cls: 'hi-words-word-text'
        });

        // Click the headword to pronounce
        wordTextEl.addEventListener('click', (e) => {
            e.stopPropagation();
            void playWordTTS(this.plugin, wordDef.word, wordDef).catch(error => {
                console.error('HiWords failed to play pronunciation:', error);
            });
        });

        wordTitle.createEl('div', {
            cls: 'hi-words-card-toggle-spacer',
            attr: {
                'aria-label': isExpanded ? t('actions.collapse') : t('actions.expand'),
                'data-word-key': wordKey
            }
        });
        
        // Mastered button (if the feature is enabled)
        if (this.plugin.settings.enableMasteredFeature && this.plugin.masteredService) {
            const buttonContainer = wordTitle.createEl('div', { 
                cls: 'hi-words-title-mastered-button',
                attr: {
                    'aria-label': isMastered ? t('actions.unmark_mastered') : t('actions.mark_mastered')
                }
            });
            
            // Set the icon (unmastered shows smile to mark as mastered; mastered shows frown to undo)
            setIcon(buttonContainer, isMastered ? 'frown' : 'smile');
            
            // Note: clicks are handled by delegation (bindDelegatedHandlers); no listener needed here
        }

        const enableSectionTabs = this.plugin.settings.enableSectionTabs ?? true;
        const sections = wordDef.sections;
        const savedSectionIndex = this.sectionTabStates.get(wordDef.word) ?? 0;
        const activeSectionIndex = sections && sections.length > savedSectionIndex ? savedSectionIndex : 0;

        if (isExpanded && !wordDef.card && sections && sections.length > 1 && enableSectionTabs) {
            const tabsContainer = card.createEl('div', { cls: 'hi-words-card-tabs' });

            sections.forEach((section, index) => {
                tabsContainer.createEl('div', {
                    cls: `hi-words-card-tab ${index === activeSectionIndex ? 'active' : ''}`,
                    text: section.title,
                    attr: { 'data-section-index': index.toString() }
                });
            });
        }

        const contentToRender = sections && sections.length > 0 && enableSectionTabs
            ? sections[activeSectionIndex].content
            : wordDef.definition;
        
        // Definition content
        if (isExpanded && wordDef.card) {
            const definition = card.createEl('div', { cls: 'hi-words-word-definition hi-words-word-definition-structured' });
            const defContainer = definition.createEl('div', {
                cls: this.plugin.settings.blurDefinitions ? 'hi-words-definition blur-enabled' : 'hi-words-definition'
            });
            renderWordCard(defContainer, wordDef, {
                mode: 'sidebar',
                app: this.app,
                pronunciationVariant: this.plugin.settings.pronunciationVariant || 'us',
                onPronunciationClick: (variant) => playWordTTS(this.plugin, wordDef.word, wordDef, variant),
                display: this.plugin.getVocabularyBookDisplaySettings(wordDef.source),
                onNoteClick: wordDef.source.endsWith('.hiwords') || wordDef.userNoteSource
                    ? () => this.openNoteModal(wordDef)
                    : undefined,
                noteActionLabel: wordDef.userNote ? t('sidebar.edit_note') : t('sidebar.add_note'),
            });
        } else if (isExpanded && contentToRender && contentToRender.trim()) {
            const definition = card.createEl('div', { cls: 'hi-words-word-definition' });

            // The real Markdown content container
            const defContainer = definition.createEl('div', {
                cls: this.plugin.settings.blurDefinitions ? 'hi-words-definition blur-enabled' : 'hi-words-definition'
            });

            // Render Markdown content
            await this.renderSectionContent(defContainer, contentToRender);
        }

        // Source information
        if (isExpanded && !wordDef.source.endsWith('.hiwords')) {
            const source = card.createEl('div', { cls: 'hi-words-word-source' });
            const bookName = this.getBookNameFromPath(wordDef.source);
            source.createEl('span', { text: `${t('sidebar.source_prefix')}${bookName}`, cls: 'hi-words-source-text' });

            // Add a click handler on the source info: navigate to the source file
            source.addEventListener('click', (e) => {
                e.stopPropagation(); // Stop event propagation
                void this.navigateToSource(wordDef).catch(error => {
                    console.error('HiWords failed to navigate to source:', error);
                });
            });
        }
        
        // Add the mastered-state style
        if (isMastered) {
            card.addClass('hi-words-word-card-mastered');
        }
    }

    private openNoteModal(wordDef: WordDefinition): void {
        new WordNoteModal(this.plugin, wordDef, async () => {
            await this.updateView();
        }).open();
    }

    private getDefaultExpandedState(): boolean {
        return (this.plugin.settings.sidebarDefaultDisplayMode || 'detail') === 'detail';
    }

    private getWordStateKey(wordDef: WordDefinition): string {
        return `${wordDef.source}::${wordDef.nodeId}::${wordDef.word}`;
    }

    private getWordExpandedState(wordDef: WordDefinition): boolean {
        const wordKey = this.getWordStateKey(wordDef);
        return this.expandedWordStates.get(wordKey) ?? this.getDefaultExpandedState();
    }

    private async renderSectionContent(container: HTMLElement, content: string): Promise<void> {
        container.empty();

        if (!content || content.trim() === '') {
            container.textContent = t('sidebar.no_definition');
            return;
        }

        try {
            const leaf = this.app.workspace.getMostRecentLeaf();
            const activeView = leaf?.view instanceof MarkdownView ? leaf.view : null;
            const sourcePath = (activeView && activeView.file?.path) || this.app.workspace.getActiveFile()?.path || '';

            await MarkdownRenderer.render(
                this.plugin.app,
                content,
                container,
                sourcePath,
                this
            );

            window.requestAnimationFrame(() => this.bindInternalLinksAndTags(container, sourcePath, container));
        } catch (error) {
            console.error('Markdown rendering failed:', error);
            container.textContent = content;
        }
    }

    /**
     * Create an empty state inside the container (keeps tab navigation)
     */
    private createEmptyState(container: HTMLElement, message: string) {
        const emptyState = container.createEl('div', { cls: 'hi-words-empty-state' });
        emptyState.createEl('div', { text: message, cls: 'hi-words-empty-text' });
    }

    /**
     * Show the empty state (global empty state; clears the whole container)
     */
    private showEmptyState(message: string) {
        const container = this.containerEl.querySelector('.hi-words-sidebar');
        if (!container) return;

        container.empty();
        const emptyState = container.createEl('div', { cls: 'hi-words-empty-state' });
        emptyState.createEl('div', { text: message, cls: 'hi-words-empty-text' });
    }

    /**
     * Root-level delegation: capture-phase mousedown fixes lost first clicks
     */
    private bindDelegatedHandlers(root: HTMLElement) {
        if (this.delegatedBound) return;
        root.addEventListener(
            'mousedown',
            (e) => {
                const target = e.target instanceof Node && e.target.nodeType === Node.ELEMENT_NODE
                    ? e.target as HTMLElement
                    : null;
                if (!target) return;

                // Tab switching
                const tabEl = target.closest<HTMLElement>('.hi-words-tab');
                if (tabEl && root.contains(tabEl)) {
                    e.preventDefault();
                    e.stopPropagation();
                    const tab = (tabEl.getAttr('data-tab') as 'learning' | 'mastered') || 'learning';
                    if (tab !== this.activeTab) this.switchTab(tab);
                    return;
                }

                const cardTabEl = target.closest<HTMLElement>('.hi-words-card-tab');
                if (cardTabEl && root.contains(cardTabEl)) {
                    e.preventDefault();
                    e.stopPropagation();

                    this.lastInteractionTime = Date.now();
                    if (this.updateTimer !== null) {
                        window.clearTimeout(this.updateTimer);
                        this.updateTimer = null;
                    }

                    const sectionIndex = parseInt(cardTabEl.getAttr('data-section-index') || '0', 10);
                    const card = cardTabEl.closest<HTMLElement>('.hi-words-word-card');
                    const wordText = card?.querySelector<HTMLElement>('.hi-words-word-text');
                    const word = wordText?.textContent?.trim();
                    if (!card || !word) return;

                    const wordDef = this.currentWords.find(w => w.word === word);
                    if (!wordDef?.sections || sectionIndex >= wordDef.sections.length) return;

                    this.sectionTabStates.set(word, sectionIndex);
                    card.querySelectorAll('.hi-words-card-tab').forEach(tab => tab.removeClass('active'));
                    cardTabEl.addClass('active');

                    const defContainer = card.querySelector<HTMLElement>('.hi-words-definition');
                    if (defContainer) {
                        void this.renderSectionContent(defContainer, wordDef.sections[sectionIndex].content);
                    }
                    return;
                }

                // Expand/collapse word cards
                const toggleEl = target.closest<HTMLElement>('.hi-words-card-toggle-spacer');
                if (toggleEl && root.contains(toggleEl)) {
                    e.preventDefault();
                    e.stopPropagation();
                    
                    // Record interaction time and cancel pending updates
                    this.lastInteractionTime = Date.now();
                    if (this.updateTimer !== null) {
                        window.clearTimeout(this.updateTimer);
                        this.updateTimer = null;
                    }

                    const card = toggleEl.closest<HTMLElement>('.hi-words-word-card');
                    const wordKey = toggleEl.getAttr('data-word-key') || card?.getAttr('data-word-key');
                    if (wordKey) {
                        const currentState = this.expandedWordStates.get(wordKey);
                        const isCurrentlyExpanded = currentState ?? this.getDefaultExpandedState();
                        this.expandedWordStates.set(wordKey, !isCurrentlyExpanded);
                        void this.renderWordList();
                    }
                    return;
                }

                // Mastered/undo button
                const masteredBtn = target.closest<HTMLElement>('.hi-words-title-mastered-button');
                if (masteredBtn && root.contains(masteredBtn)) {
                    e.preventDefault();
                    e.stopPropagation();
                    const card = masteredBtn.closest<HTMLElement>('.hi-words-word-card');
                    const isMastered = !!card?.hasClass('hi-words-word-card-mastered');
                    const wordText = card?.querySelector<HTMLElement>('.hi-words-word-text');
                    const word = wordText?.textContent?.trim();
                    if (word && this.plugin.settings.enableMasteredFeature && this.plugin.masteredService) {
                        const detail = this.currentWords.find((w) => w.word === word);
                        if (detail) {
                            void (async () => {
                                try {
                                    const masteredService = this.plugin.masteredService;
                                    if (!masteredService) return;

                                    if (isMastered) {
                                        await masteredService.unmarkWordAsMastered(detail.source, detail.nodeId, detail.word);
                                    } else {
                                        await masteredService.markWordAsMastered(detail.source, detail.nodeId, detail.word);
                                    }
                                    window.setTimeout(() => {
                                        void this.updateView();
                                    }, 100);
                                } catch (err) {
                                    console.error('Failed to toggle mastered state:', err);
                                }
                            })();
                        }
                    }
                    return;
                }

                // Source navigation
                const sourceEl = target.closest<HTMLElement>('.hi-words-word-source');
                if (sourceEl && root.contains(sourceEl)) {
                    e.preventDefault();
                    e.stopPropagation();
                    const card = sourceEl.closest<HTMLElement>('.hi-words-word-card');
                    const wordText = card?.querySelector<HTMLElement>('.hi-words-word-text');
                    const word = wordText?.textContent?.trim();
                    if (word) {
                        const detail = this.currentWords.find((w) => w.word === word);
                        if (detail) {
                            void this.navigateToSource(detail).catch(error => {
                                console.error('HiWords failed to navigate to source:', error);
                            });
                        }
                    }
                    return;
                }
            },
            { capture: true }
        );
        this.delegatedBound = true;
    }

    /**
     * Get the word book name from the path
     */
    private getBookNameFromPath(path: string): string {
        const book = this.plugin.settings.vocabularyBooks.find(b => b.path === path);
        return book ? book.name : path.split('/').pop()?.replace('.canvas', '') || 'Unknown';
    }

    /**
     * Escape regex special characters
     */
    private escapeRegExp(string: string): string {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * Extract text content from a PDF file
     */
    private async extractPDFText(): Promise<string> {
        try {
            // Wait for the PDF view to load and get the text layer content
            await new Promise(resolve => window.setTimeout(resolve, 500));
            
            // Find all PDF text layers
            const textLayers = activeDocument.querySelectorAll('.textLayer');
            let extractedText = '';
            
            textLayers.forEach((textLayer: Element) => {
                // Check whether it belongs to the currently active PDF view
                const pdfContainer = textLayer.closest('.pdf-container, .mod-pdf');
                if (pdfContainer) {
                    // Collect all text inside the text layer
                    const textSpans = textLayer.querySelectorAll('span[role="presentation"]');
                    textSpans.forEach((span: Element) => {
                        const text = span.textContent || '';
                        if (text.trim()) {
                            extractedText += text + ' ';
                        }
                    });
                    extractedText += '\n'; // Append a newline after each text layer
                }
            });
            
            // If no text layer is found, try extracting from the PDF view itself
            if (!extractedText.trim()) {
                const pdfViews = activeDocument.querySelectorAll('.pdf-container, .mod-pdf');
                pdfViews.forEach((pdfView: Element) => {
                    const allText = pdfView.textContent || '';
                    if (allText.trim()) {
                        extractedText += allText + '\n';
                    }
                });
            }
            
            return extractedText.trim();
        } catch (error) {
            console.error('PDF text extraction failed:', error);
            return '';
        }
    }

    /**
     * Build the regex used to scan documents.
     * - For Latin-only words: use \b boundaries to avoid false matches, e.g. "art" must not match "start".
     * - For words containing Japanese/CJK/Korean: skip \b (such text often lacks spaces) and use the Unicode flag.
     */
    private buildSearchRegex(term: string): RegExp {
        const escaped = this.escapeRegExp(term);
        // Detect CJK, Japanese or Korean scripts
        const hasAsianScript = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(term);
        const pattern = hasAsianScript ? `${escaped}` : `\\b${escaped}\\b`;
        const flags = hasAsianScript ? 'giu' : 'gi';
        return new RegExp(pattern, flags);
    }

    /**
     * Bind internal-link and tag interactions for sidebar-rendered content:
     * - internal-link: hover triggers the native hover preview; click navigates
     * - tag: click opens/reuses the search view
     */
    private bindInternalLinksAndTags(root: HTMLElement, sourcePath: string, hoverParent: HTMLElement) {
        // Internal link
        root.querySelectorAll('a.internal-link').forEach((a) => {
            const linkEl = a as HTMLAnchorElement;
            const linktext = (linkEl.getAttribute('href') || linkEl.dataset.href || '').trim();
            if (!linktext) return;

            linkEl.addEventListener('mouseover', (evt) => {
                (this.app.workspace as unknown as HoverLinkWorkspace).trigger('hover-link', {
                    event: evt,
                    source: 'hi-words',
                    hoverParent,
                    target: linkEl,
                    linktext,
                    sourcePath
                });
            });

            linkEl.addEventListener('click', (evt) => {
                evt.preventDefault();
                evt.stopPropagation();
                void this.app.workspace.openLinkText(linktext, sourcePath).catch(error => {
                    console.error('HiWords failed to open internal link:', error);
                });
            });
        });

        // Tag
        root.querySelectorAll('a.tag').forEach((a) => {
            const tagEl = a as HTMLAnchorElement;
            const query = (tagEl.getAttribute('href') || tagEl.textContent || '').trim();
            if (!query) return;
            tagEl.addEventListener('click', (evt) => {
                evt.preventDefault();
                evt.stopPropagation();
                this.openOrUpdateSearch(query.startsWith('#') ? query : `#${query}`);
            });
        });
    }

    /** Open or reuse the global search view and set the query */
    private openOrUpdateSearch(query: string) {
        try {
            const leaves = this.app.workspace.getLeavesOfType('search');
            if (leaves.length > 0) {
                const view = leaves[0].view as SearchViewLike;
                view.setQuery?.(query);
                void this.app.workspace.revealLeaf(leaves[0]).catch(error => {
                    console.error('HiWords failed to open search view:', error);
                });
                return;
            }

            // If the search view does not exist, prompt the user to enable the Search core plugin
            new Notice(t('notices.enable_search_plugin') || 'Please enable the core Search plugin first');
        } catch (e) {
            console.error('Failed to open search:', e);
        }
    }

    /**
     * Navigate to the word's source file
     */
    private async navigateToSource(wordDef: WordDefinition) {
        try {
            const file = this.app.vault.getAbstractFileByPath(wordDef.source);
            if (file instanceof TFile) {
                // If it is a Canvas file, open it directly
                if (file.extension === 'canvas') {
                    await this.app.workspace.openLinkText(file.path, '');
                } else {
                    // If it is a Markdown file, open it and try to locate the word
                    await this.app.workspace.openLinkText(file.path, '');
                    // Wait briefly for the file to load
                    window.setTimeout(() => {
                        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
                        if (activeView && activeView.file?.path === file.path) {
                            // Try to find the word in the file
                            const editor = activeView.editor;
                            const content = editor.getValue();
                            const wordIndex = content.toLowerCase().indexOf(wordDef.word.toLowerCase());
                            if (wordIndex !== -1) {
                                const pos = editor.offsetToPos(wordIndex);
                                editor.setCursor(pos);
                                editor.scrollIntoView({ from: pos, to: pos }, true);
                            }
                        }
                    }, 100);
                }
            }
        } catch (error) {
            console.error('Failed to navigate to source file:', error);
        }
    }


    /**
     * Force-refresh the view
     */
    public refresh() {
        this.currentFile = null; // Force a rescan
        this.scheduleUpdate(0);
    }
}
