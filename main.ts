import { Plugin, WorkspaceLeaf } from 'obsidian';
import { Extension } from '@codemirror/state';
// Use the new modular imports
import { HiWordsSettings, VocabularyBookDisplaySettings, WordDefinition } from './src/utils';
import { DEFAULT_SETTINGS } from './src/settings';
import { registerReadingModeHighlighter } from './src/ui/reading-mode-highlighter';
import { registerPDFHighlighter, cleanupPDFHighlighter } from './src/ui/pdf-highlighter';
import { VocabularyManager, MasteredService, createWordHighlighterExtension, highlighterManager } from './src/core';
import { DefinitionPopover, HiWordsLibraryView, HiWordsSettingTab, HiWordsSidebarView, LIBRARY_VIEW_TYPE, SIDEBAR_VIEW_TYPE, AddWordModal } from './src/ui';
import { i18n } from './src/i18n';
import { registerCommands } from './src/commands';
import { registerEvents } from './src/events';
import { shouldHighlightFile } from './src/utils/highlight-utils';

interface HiWordsRefreshHooks {
    _refreshReadingModeHighlighter?: () => void;
    _refreshPDFHighlighter?: () => void;
}

export default class HiWordsPlugin extends Plugin {
    settings!: HiWordsSettings;
    vocabularyManager!: VocabularyManager;
    definitionPopover!: DefinitionPopover;
    masteredService!: MasteredService;
    editorExtensions: Extension[] = [];
    private isSidebarInitialized = false;

    async onload() {
        // Load settings (quick)
        await this.loadSettings();
        
        // Initialize the i18n module
        i18n.setApp(this.app);
        
        // Initialize managers (without loading data)
        this.vocabularyManager = new VocabularyManager(this.app, this.settings);
        
        // Initialize the mastered service
        this.masteredService = new MasteredService(this, this.vocabularyManager);
        
        // Initialize the definition popover (must be loaded as a Component)
        this.definitionPopover = new DefinitionPopover(this);
        this.addChild(this.definitionPopover);
        this.definitionPopover.setVocabularyManager(this.vocabularyManager);
        this.definitionPopover.setMasteredService(this.masteredService);
        
        // Register the sidebar view
        this.registerView(
            SIDEBAR_VIEW_TYPE,
            (leaf) => new HiWordsSidebarView(leaf, this)
        );

        this.registerView(
            LIBRARY_VIEW_TYPE,
            (leaf) => new HiWordsLibraryView(leaf, this)
        );
        
        // Register editor extensions
        this.setupEditorExtensions();
        
        // Register commands
        this.registerCommands();
        
        // Register events
        this.registerEvents();

        // Register the reading-mode (Markdown) postprocessor for reading-mode highlighting
        registerReadingModeHighlighter(this);
        
        // Register the PDF highlighting feature
        registerPDFHighlighter(this);
        
        // Add the settings page
        this.addSettingTab(new HiWordsSettingTab(this.app, this));
        
        // Initialize the sidebar
        this.initializeSidebar();
        
        // Lazy-load word books (after layout is ready)
        // This speeds up plugin startup and avoids blocking Obsidian launch
        this.app.workspace.onLayoutReady(() => {
            void (async () => {
                const needsMasteredMigration = (this.settings.masteredMigrationVersion ?? 0) < 1;
                const migratedCount = await this.vocabularyManager.migrateLegacyMasteredStatusIfNeeded();
                if (needsMasteredMigration || migratedCount > 0) {
                    await this.saveSettings();
                }
                await this.vocabularyManager.loadAllVocabularyBooks();
                this.refreshHighlighter();
            })().catch(error => {
                console.error('HiWords failed to load vocabulary books:', error);
            });
        });
    }

    /**
     * Set up editor extensions
     * Note: the extension is always registered, but WordHighlighter checks the enableAutoHighlight setting internally
     */
    private setupEditorExtensions() {
        // Always register the extension; WordHighlighter decides whether to highlight based on settings
        const extension = createWordHighlighterExtension(
            this.vocabularyManager,
            (filePath) => shouldHighlightFile(filePath, this.settings)
        );
        this.editorExtensions = [extension];
        this.registerEditorExtension(this.editorExtensions);
    }

    /**
     * Register commands (delegated to the command manager)
     */
    private registerCommands() {
        registerCommands(this);
    }

    /**
     * Register events (delegated to the event manager)
     */
    private registerEvents() {
        registerEvents(this);
    }

    /**
     * Check whether a file should be highlighted (wrapper method)
     */
    shouldHighlightFile(filePath: string): boolean {
        return shouldHighlightFile(filePath, this.settings);
    }

    /**
     * Refresh highlighters
     */
    refreshHighlighter() {
        // Always refresh highlighters; WordHighlighter decides whether to highlight based on settings
        highlighterManager.refreshAll();
        
        // Refresh reading mode (updates only visible areas)
        const hooks = this as HiWordsPlugin & HiWordsRefreshHooks;
        if (hooks._refreshReadingModeHighlighter) {
            hooks._refreshReadingModeHighlighter();
        }
        
        // Refresh PDF mode (updates only visible areas)
        if (hooks._refreshPDFHighlighter) {
            hooks._refreshPDFHighlighter();
        }
        
        // Refresh the sidebar view (obtained via API)
        const leaves = this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE);
        leaves.forEach(leaf => {
            if (leaf.view instanceof HiWordsSidebarView) {
                leaf.view.refresh();
            }
        });

        const libraryLeaves = this.app.workspace.getLeavesOfType(LIBRARY_VIEW_TYPE);
        libraryLeaves.forEach(leaf => {
            if (leaf.view instanceof HiWordsLibraryView) {
                void leaf.view.refresh().catch(error => {
                    console.error('HiWords failed to refresh library view:', error);
                });
            }
        });
    }

    /**
     * Initialize the sidebar
     */
    private initializeSidebar() {
        if (this.isSidebarInitialized) return;
        
        // Only register the view; do not open it automatically
        this.app.workspace.onLayoutReady(() => {
            this.isSidebarInitialized = true;
        });
    }

    /**
     * Activate the sidebar view
     */
    async activateSidebarView() {
        const { workspace } = this.app;
        
        let leaf: WorkspaceLeaf | null = null;
        const leaves = workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE);
        
        if (leaves.length > 0) {
            // If it already exists, activate it
            leaf = leaves[0];
        } else {
            // Otherwise create a new sidebar view
            leaf = workspace.getRightLeaf(false);
            if (leaf) {
                await leaf.setViewState({ type: SIDEBAR_VIEW_TYPE, active: true });
            }
        }
        
        if (leaf) {
            await workspace.revealLeaf(leaf);
        }
    }

    async showWordInSidebar(wordDef: WordDefinition, origin: 'document' | 'library' = 'document') {
        await this.activateSidebarView();
        const leaves = this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE);
        const view = leaves[0]?.view;
        if (view instanceof HiWordsSidebarView) {
            await view.focusWord(wordDef, origin);
        }
    }

    getVocabularyBookDisplaySettings(sourcePath: string): VocabularyBookDisplaySettings | undefined {
        return this.settings.vocabularyBooks.find(book => book.path === sourcePath)?.display;
    }

    async activateLibraryView() {
        const { workspace } = this.app;

        let leaf: WorkspaceLeaf | null = null;
        const leaves = workspace.getLeavesOfType(LIBRARY_VIEW_TYPE);

        if (leaves.length > 0) {
            leaf = leaves[0];
        } else {
            leaf = workspace.getLeaf(false);
            if (leaf) {
                await leaf.setViewState({ type: LIBRARY_VIEW_TYPE, active: true });
            }
        }

        if (leaf) {
            await workspace.revealLeaf(leaf);
        }
    }

    /**
     * Load settings
     */
    async loadSettings() {
        const loaded = (await this.loadData()) as Partial<HiWordsSettings> | null;

        // Migration: fully remove deprecated AI-related settings (this plugin is now 100% offline)
        if (loaded) {
            let removed = false;
            const deprecatedKeys = [
                'aiService', 'aiDefinition', 'selectionTranslate',
                'enableAiDefinition', 'enableSelectionTranslate',
                'aiApiUrl', 'aiApiKey', 'aiModel', 'aiPrompt', 'aiExtraParams',
                'aiProvider', 'translateTargetLang', 'translatePrompt',
                // Deprecated Youdao TTS feature (this plugin is now 100% offline)
                'ttsTemplate', 'pronunciationVariant',
            ];
            const loadedRecord = loaded as Record<string, unknown>;
            for (const key of deprecatedKeys) {
                if (key in loadedRecord) {
                    delete loadedRecord[key];
                    removed = true;
                }
            }
            if (removed) {
                void this.saveData(loadedRecord).catch(error => {
                    console.error('HiWords failed to persist settings migration:', error);
                });
            }
        }

        this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
    }

    /**
     * Save settings
     */
    async saveSettings() {
        await this.saveData(this.settings);
        this.vocabularyManager.updateSettings(this.settings);
        this.masteredService.updateSettings();
    }

    /**
     * Add or edit a word
     * Check whether the word already exists; if so open edit mode, otherwise open add mode
     * @param word the word to add or edit
     * @param sentence the sentence containing the word (optional)
     */
    addOrEditWord(word: string, sentence = '', prefilledDefinition = '') {
        // Check whether the word already exists
        const existingDefinition = this.vocabularyManager.getDefinition(word);
        
        if (existingDefinition && !existingDefinition.source.endsWith('.hiwords')) {
            // Entries in user Canvas word books can be edited directly
            new AddWordModal(this.app, this, word, sentence, true).open();
        } else {
            // Official .hiwords dictionaries stay read-only; right-click add prefills the official definition into the Canvas add form
            const definition = prefilledDefinition || this.getPrefilledDefinition(existingDefinition);
            new AddWordModal(this.app, this, word, sentence, false, definition).open();
        }
    }

    private getPrefilledDefinition(wordDef: WordDefinition | null): string {
        if (!wordDef?.source.endsWith('.hiwords')) return '';
        if (wordDef.sections?.length) {
            return wordDef.sections
                .map(section => `**${section.title}**\n${section.content}`)
                .join('\n\n---\n\n');
        }
        return wordDef.rawDefinition || wordDef.definition || '';
    }

    /**
     * Unload the plugin
     */
    onunload() {
        // definitionPopover is unloaded automatically as a child component
        this.vocabularyManager.clear();
        // Clean up incremental-update resources
        if (this.vocabularyManager.destroy) {
            this.vocabularyManager.destroy();
        }
        // Clean up the global highlighter manager
        highlighterManager.clear();
        // Clean up PDF highlighter resources
        cleanupPDFHighlighter(this);
    }
}
