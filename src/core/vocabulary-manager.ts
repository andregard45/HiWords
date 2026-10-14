import { App, TFile } from 'obsidian';
import { CanvasData, StudyItem, WordDefinition, VocabularyBook, HiWordsSettings, StudyProgressItem, buildStudyKey, inferLearningItemType } from '../utils';
import { CanvasParser, CanvasEditor } from '../canvas';
import { HiWordsParser } from '../card';

export class VocabularyManager {
    private app: App;
    private canvasParser: CanvasParser;
    private hiWordsParser: HiWordsParser;
    private canvasEditor: CanvasEditor;
    private definitions: Map<string, WordDefinition[]> = new Map();
    private settings: HiWordsSettings;
    
    // Cache optimization
    private wordDefinitionCache: Map<string, WordDefinition> = new Map(); // word -> definition map
    private allWordsCache: string[] = []; // Cache of all words
    private bookWordsCache: Map<string, string[]> = new Map(); // book path -> word list map
    private studyItemCache: Map<string, StudyItem> = new Map(); // Global study-object map
    private cacheValid = false; // Whether the cache is valid
    
    // Incremental-update optimization
    private memoryOnlyWords: Map<string, WordDefinition[]> = new Map(); // New words kept in memory only
    private pendingSyncWords: Map<string, WordDefinition[]> = new Map(); // Words pending sync
    private syncTimeouts: Map<string, number> = new Map(); // Sync timer
    private tempNodeIdCounter = 0; // Temporary node-ID counter

    constructor(app: App, settings: HiWordsSettings) {
        this.app = app;
        this.canvasParser = new CanvasParser(app, settings);
        this.hiWordsParser = new HiWordsParser(app);
        this.canvasEditor = new CanvasEditor(app, settings);
        this.settings = settings;
    }

    /**
     * Load all enabled word books
     */
    async loadAllVocabularyBooks(): Promise<void> {
        this.definitions.clear();
        this.invalidateCache();
        
        const loadPromises = this.settings.vocabularyBooks
            .filter(book => book.enabled)
            .map(book => this.loadVocabularyBook(book));
            
        await Promise.all(loadPromises);
        
        // Rebuild the cache
        this.rebuildCache();
    }

    async migrateLegacyMasteredStatusIfNeeded(): Promise<number> {
        if ((this.settings.masteredMigrationVersion ?? 0) >= 1) {
            return 0;
        }

        const legacySettings = this.settings as HiWordsSettings & { masteredDetection?: 'group' | 'color' };
        const legacyDetection = legacySettings.masteredDetection ?? 'group';
        let migratedCount = 0;

        if (!this.settings.studyProgress) {
            this.settings.studyProgress = {};
        }

        for (const book of this.settings.vocabularyBooks) {
            const file = this.app.vault.getAbstractFileByPath(book.path);
            if (!(file instanceof TFile) || !CanvasParser.isCanvasFile(file)) continue;

            const definitions = await this.canvasParser.parseCanvasFile(file, {
                legacyMasteredDetection: legacyDetection,
            });

            for (const definition of definitions) {
                if (!definition.mastered || !definition.studyKey) continue;
                const existing = this.settings.studyProgress[definition.studyKey];
                if (!existing || existing.status !== 'mastered') {
                    const now = new Date().toISOString();
                    const progress: StudyProgressItem = {
                        status: 'mastered',
                        masteredAt: existing?.masteredAt || now,
                        updatedAt: now,
                    };
                    this.settings.studyProgress[definition.studyKey] = progress;
                    migratedCount++;
                }
            }
        }

        this.settings.masteredMigrationVersion = 1;
        return migratedCount;
    }

    /**
     * Load a single word book
     */
    async loadVocabularyBook(book: VocabularyBook): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(book.path);
        
        if (!file || !(file instanceof TFile)) {
            console.warn(`Canvas file not found: ${book.path}`);
            return;
        }

        if (!CanvasParser.isCanvasFile(file) && !HiWordsParser.isHiWordsFile(file)) {
            console.warn(`File is not a supported vocabulary book: ${book.path}`);
            return;
        }

        try {
            const isHiWordsBook = HiWordsParser.isHiWordsFile(file);
            const definitions = isHiWordsBook
                ? await this.hiWordsParser.parseFile(file)
                : await this.canvasParser.parseCanvasFile(file);
            if (isHiWordsBook) {
                this.applyBookColor(book, definitions);
            }
            this.applyStoredProgress(definitions);
            this.definitions.set(book.path, definitions);
            
            // Update the cache incrementally instead of rebuilding it entirely
            this.updateCacheForBook(book.path, definitions);
        } catch (error) {
            console.error(`Failed to load vocabulary book ${book.name}:`, error);
            // On parse failure, make sure this book's data and cache are cleared
            this.definitions.delete(book.path);
            this.updateCacheForBook(book.path, []); // Clear this book's cache
        }
    }

    /**
     * Get a word definition, matching aliases too
     * @param word the word to look up
     * @param visited set of already-visited words to prevent cycles
     * @returns the word definition or null
     */
    getDefinition(word: string, visited: Set<string> = new Set()): WordDefinition | null {
        const normalizedWord = word.toLowerCase().trim();
        
        // Prevent circular references
        if (visited.has(normalizedWord)) {
            return null;
        }
        visited.add(normalizedWord);
        
        // Check the cache
        if (this.cacheValid && this.wordDefinitionCache.has(normalizedWord)) {
            return this.wordDefinitionCache.get(normalizedWord) || null;
        }
        
        // If the cache is invalid, rebuild it
        if (!this.cacheValid) {
            this.rebuildCache();
            if (this.wordDefinitionCache.has(normalizedWord)) {
                return this.wordDefinitionCache.get(normalizedWord) || null;
            }
        }

        // Not found in cache; perform a full search
        for (const definitions of this.definitions.values()) {
            // Check headwords first
            const foundByMainWord = definitions.find(def => def.word === normalizedWord);
            if (foundByMainWord) {
                // Update the cache
                this.wordDefinitionCache.set(normalizedWord, foundByMainWord);
                return foundByMainWord;
            }

            // Then check aliases
            const foundByAlias = definitions.find(def => 
                def.aliases && def.aliases.includes(normalizedWord)
            );
            if (foundByAlias) {
                // Update the cache
                this.wordDefinitionCache.set(normalizedWord, foundByAlias);
                return foundByAlias;
            }
        }

        return null;
    }

    /**
     * Get all vocabulary, including aliases
     */
    getAllWords(): string[] {
        // If the cache is valid, return the cached word list directly
        if (this.cacheValid) {
            return [...this.allWordsCache]; // Return a copy to guard against mutation
        }
        
        // Rebuild the cache and return
        this.rebuildCache();
        return [...this.allWordsCache];
    }

    /**
     * Get unmastered vocabulary (for highlighting)
     * If the mastered feature is off, return all words
     */
    getAllWordsForHighlight(): string[] {
        // If the mastered feature is off, return all words
        if (!this.settings.enableMasteredFeature) {
            return this.getAllWords();
        }
        
        // If the cache is valid, filter unmastered words from it
        if (this.cacheValid) {
            const unmasteredWords: string[] = [];
            for (const word of this.allWordsCache) {
                const wordDef = this.wordDefinitionCache.get(word);
                if (wordDef && !wordDef.mastered) {
                    unmasteredWords.push(word);
                }
            }
            return unmasteredWords;
        }
        
        // Rebuild the cache and filter
        this.rebuildCache();
        const unmasteredWords: string[] = [];
        for (const word of this.allWordsCache) {
            const wordDef = this.wordDefinitionCache.get(word);
            if (wordDef && !wordDef.mastered) {
                unmasteredWords.push(word);
            }
        }
        return unmasteredWords;
    }

    /**
     * Get a specific book's vocabulary, including aliases
     */
    getWordsFromBook(bookPath: string): string[] {
        // If the cache is valid and contains this book's word list, return it directly
        const cachedBookWords = this.bookWordsCache.get(bookPath);
        if (this.cacheValid && cachedBookWords) {
            return [...cachedBookWords]; // Return a copy to guard against mutation
        }
        
        const definitions = this.definitions.get(bookPath);
        if (!definitions) return [];
        
        const words: string[] = [];
        
        // Add the headword
        words.push(...definitions.map(def => def.word));
        
        // Add aliases
        definitions.forEach(def => {
            if (def.aliases && def.aliases.length > 0) {
                words.push(...def.aliases);
            }
        });
        
        const uniqueWords = [...new Set(words)]; // Dedupe
        
        // Update the cache
        this.bookWordsCache.set(bookPath, uniqueWords);
        
        return uniqueWords;
    }

    getStudyItems(): StudyItem[] {
        if (!this.cacheValid) {
            this.rebuildCache();
        }

        return [...this.studyItemCache.values()];
    }

    getStudyDefinitionsForHighlight(): WordDefinition[] {
        return this.getStudyItems()
            .filter(item => !this.settings.enableMasteredFeature || !item.mastered)
            .map(item => item.primary);
    }

    getStudyDefinitions(): WordDefinition[] {
        return this.getStudyItems().map(item => item.primary);
    }

    /**
     * Reload a specific word book
     */
    async reloadVocabularyBook(bookPath: string): Promise<void> {
        const book = this.settings.vocabularyBooks.find(b => b.path === bookPath);
        if (book && book.enabled) {
            await this.loadVocabularyBook(book);
            // Invalidate the cache
            this.invalidateCache();
        }
    }

    /**
     * Delete a specific book's data
     * @param bookPath the word book path
     */
    removeBookData(bookPath: string): void {
        this.definitions.delete(bookPath);
        this.invalidateCache();
    }

    /**
     * Update settings
     */
    updateSettings(settings: HiWordsSettings): void {
        const oldSettings = this.settings;
        this.settings = settings;
        
        // Invalidate the cache only for setting changes that affect vocabulary data
        const shouldInvalidateCache = 
            oldSettings.fileNodeParseMode !== settings.fileNodeParseMode ||
            this.hasVocabularyBooksChanged(oldSettings.vocabularyBooks, settings.vocabularyBooks);
            
        if (shouldInvalidateCache) {
            this.invalidateCache();
        }
        
        // Sync to CanvasEditor
        this.canvasEditor.updateSettings(settings);
        // Sync to CanvasParser (affects mastered detection, etc.)
        this.canvasParser.updateSettings(settings);
    }

    private applyStoredProgress(definitions: WordDefinition[]): void {
        for (const definition of definitions) {
            if (!definition.studyKey) continue;

            const progress = this.settings.studyProgress?.[definition.studyKey];
            if (progress?.status === 'mastered') {
                definition.mastered = true;
            }
        }
    }

    private applyBookColor(book: VocabularyBook, definitions: WordDefinition[]): void {
        if (!book.color) return;

        for (const definition of definitions) {
            if (!definition.color) {
                definition.color = book.color;
            }
            if (definition.card && !definition.card.color) {
                definition.card = { ...definition.card, color: book.color };
            }
        }
    }

    /**
     * Check whether word-book configuration changed
     * @param oldBooks the previous word-book configuration
     * @param newBooks the new word-book configuration
     * @returns whether anything changed
     */
    private hasVocabularyBooksChanged(oldBooks: VocabularyBook[], newBooks: VocabularyBook[]): boolean {
        if (oldBooks.length !== newBooks.length) {
            return true;
        }
        
        // Check key properties of each word book
        for (let i = 0; i < oldBooks.length; i++) {
            const oldBook = oldBooks[i];
            const newBook = newBooks[i];
            
            if (oldBook.path !== newBook.path || 
                oldBook.enabled !== newBook.enabled ||
                oldBook.name !== newBook.name ||
                oldBook.color !== newBook.color) {
                return true;
            }
        }
        
        return false;
    }

    /**
     * Get the current settings
     */
    getSettings(): HiWordsSettings {
        return this.settings;
    }

    /**
     * Get statistics
     */
    getStats(): { totalBooks: number; enabledBooks: number; totalWords: number } {
        const totalBooks = this.settings.vocabularyBooks.length;
        const enabledBooks = this.settings.vocabularyBooks.filter(b => b.enabled).length;
        
        // Count only headwords, excluding aliases
        let totalWords = 0;
        for (const definitions of this.definitions.values()) {
            totalWords += definitions.length;
        }
        
        return { totalBooks, enabledBooks, totalWords };
    }

    /**
     * Check whether a word exists
     */
    hasWord(word: string): boolean {
        const normalizedWord = word.toLowerCase().trim();
        
        // If the cache is valid, check it directly
        if (this.cacheValid) {
            return this.wordDefinitionCache.has(normalizedWord);
        }
        
        return this.getDefinition(word) !== null;
    }

    /**
     * Clear all data
     */
    clear(): void {
        this.definitions.clear();
        this.invalidateCache();
    }
    
    /**
     * Add a word to a Canvas file
     */
    async addWordToCanvas(bookPath: string, word: string, definition: string, color?: number, aliases?: string[]): Promise<boolean> {
        try {
            const language = this.inferWordLanguage(word);
            const type = inferLearningItemType(word, language);
            // 1. Create the word definition (with a temporary node ID)
            const wordDef: WordDefinition = {
                word,
                type,
                language,
                studyKey: buildStudyKey({ word, language, type }),
                definition,
                source: bookPath,
                nodeId: this.generateTempNodeId(),
                color: color ? this.getColorString(color) : undefined,
                aliases: aliases?.filter(alias => alias && alias.trim().length > 0)
            };
            
            // 2. Update the in-memory cache immediately (user sees the result instantly)
            this.addWordToMemoryCache(bookPath, wordDef);
            
            // 3. Rebuild the cache so it takes effect at once
            this.rebuildCache();
            
            // 4. Write to the file asynchronously and update to the real nodeId
            this.scheduleCanvasSync(bookPath, wordDef);
            
            return true;
        } catch (error) {
            console.error('Failed to add word to canvas:', error);
            return false;
        }
    }

    private inferWordLanguage(word: string): string | undefined {
        if (/[\u4e00-\u9fff]/.test(word)) return 'zh';
        if (/[A-Za-z]/.test(word)) return 'en';
        return undefined;
    }
    
    /**
     * Set only the node color and sync the color string in the memory cache
     */
    async setNodeColor(bookPath: string, nodeId: string, color?: number): Promise<boolean> {
        try {
            const ok = await this.canvasEditor.setNodeColor(bookPath, nodeId, color);
            if (!ok) return false;

            // Update this node's color in the memory cache
            const defs = this.definitions.get(bookPath);
            if (defs) {
                const idx = defs.findIndex(d => d.nodeId === nodeId);
                if (idx >= 0) {
                    const def = defs[idx];
                    def.color = color !== undefined ? this.getColorString(color) : undefined;
                    // Update cache mappings
                    this.wordDefinitionCache.set(def.word, def);
                    if (def.aliases) {
                        def.aliases.forEach(alias => this.wordDefinitionCache.set(alias, def));
                    }
                    // Mark the cache for rebuild (color changes may affect filtering)
                    this.cacheValid = false;
                }
            }
            return true;
        } catch (e) {
            console.error('Failed to set node color:', e);
            return false;
        }
    }
    
    /**
     * Invalidate the cache
     * Called when vocabulary data changes
     */
    private invalidateCache(): void {
        this.cacheValid = false;
        this.wordDefinitionCache.clear();
        this.allWordsCache = [];
        this.bookWordsCache.clear();
        this.studyItemCache.clear();
    }
    
    /**
     * Rebuild the cache
     * Build the word->definition map and the full word list
     */
    private rebuildCache(): void {
        // Clear the existing cache
        this.wordDefinitionCache.clear();
        this.allWordsCache = [];
        this.bookWordsCache.clear();
        this.studyItemCache.clear();
        
        const allWords = new Set<string>();
        const mainWords = this.collectMainWords();
        const sourceDefinitions = [
            ...Array.from(this.definitions.values()).flat(),
            ...Array.from(this.memoryOnlyWords.values()).flat(),
        ];
        this.studyItemCache = this.buildStudyItemCache(sourceDefinitions);
        
        for (const item of this.studyItemCache.values()) {
            const normalizedWord = item.word.toLowerCase().trim();
            if (!normalizedWord) continue;

            this.wordDefinitionCache.set(normalizedWord, item.primary);
            allWords.add(normalizedWord);

            for (const alias of item.aliases) {
                const normalizedAlias = alias.toLowerCase().trim();
                if (!normalizedAlias) continue;
                if (mainWords.has(normalizedAlias) || this.wordDefinitionCache.has(normalizedAlias)) {
                    allWords.add(normalizedAlias);
                    continue;
                }
                this.wordDefinitionCache.set(normalizedAlias, item.primary);
                allWords.add(normalizedAlias);
            }
        }

        // Iterate all books and definitions, keeping per-book query caches
        for (const [bookPath, definitions] of this.definitions.entries()) {
            const bookWords = new Set<string>();
            
            for (const def of definitions) {
                const normalizedWord = def.word.toLowerCase().trim();
                if (!normalizedWord) continue;

                bookWords.add(normalizedWord);
            }

            for (const def of definitions) {
                // Add aliases to the cache
                if (def.aliases && def.aliases.length > 0) {
                    for (const alias of def.aliases) {
                        const normalizedAlias = alias.toLowerCase().trim();
                        if (!normalizedAlias) continue;
                        bookWords.add(normalizedAlias);
                    }
                }
            }
            
            // Save this book's word list
            this.bookWordsCache.set(bookPath, [...bookWords]);
        }
        
        // Save the full word list
        this.allWordsCache = [...allWords];
        
        // Mark the cache as valid
        this.cacheValid = true;
    }

    private buildStudyItemCache(definitions: WordDefinition[]): Map<string, StudyItem> {
        const items = new Map<string, StudyItem>();

        for (const definition of definitions) {
            const studyKey = definition.studyKey || `${definition.source}:${definition.nodeId}`;
            const existing = items.get(studyKey);

            if (existing) {
                existing.sources.push(definition);
                existing.aliases = this.mergeAliases(existing.aliases, definition.aliases);
                existing.mastered = existing.mastered || definition.mastered === true;
                continue;
            }

            items.set(studyKey, {
                studyKey,
                word: definition.word,
                type: definition.type,
                language: definition.language,
                aliases: this.mergeAliases([], definition.aliases),
                mastered: definition.mastered === true,
                sources: [definition],
                primary: definition,
            });
        }

        for (const item of items.values()) {
            item.primary = this.selectPrimaryDefinition(item.sources);
            item.word = item.primary.word;
            item.type = item.primary.type;
            item.language = item.primary.language;
            item.sources.forEach((definition) => {
                definition.mastered = item.mastered;
            });
            item.primary.mastered = item.mastered;
        }

        return items;
    }

    private selectPrimaryDefinition(definitions: WordDefinition[]): WordDefinition {
        const sorted = [...definitions].sort((a, b) => this.getBookOrder(a.source) - this.getBookOrder(b.source));
        const fullCanvas = sorted.find(definition => !definition.source.endsWith('.hiwords') && !this.isNoteOnlyDefinition(definition));
        if (fullCanvas) return fullCanvas;

        const hiWords = sorted.find(definition => definition.source.endsWith('.hiwords'));
        const noteOnly = sorted.find(definition => !definition.source.endsWith('.hiwords') && this.isNoteOnlyDefinition(definition));
        if (hiWords && noteOnly) {
            return this.mergeDefinitionWithNote(hiWords, noteOnly);
        }

        return hiWords || noteOnly || sorted[0];
    }

    private isNoteOnlyDefinition(definition: WordDefinition): boolean {
        if (definition.source.endsWith('.hiwords')) return false;

        const sections = definition.sections || [];
        if (sections.length === 1) {
            return this.isNoteSectionTitle(sections[0].title);
        }

        if (sections.length > 1) return false;

        const raw = (definition.rawDefinition || definition.definition || '').trim();
        return /^\*\*(note|notes|备注|我的备注)\*\*/i.test(raw);
    }

    private isNoteSectionTitle(title: string): boolean {
        return ['note', 'notes', '备注', '我的备注'].includes(title.trim().toLowerCase());
    }

    private getNoteContent(definition: WordDefinition): string {
        const noteSection = definition.sections?.find(section => this.isNoteSectionTitle(section.title));
        if (noteSection) return noteSection.content.trim();

        return (definition.rawDefinition || definition.definition || '')
            .replace(/^\*\*(note|notes|备注|我的备注)\*\*/i, '')
            .trim();
    }

    private mergeDefinitionWithNote(base: WordDefinition, noteDefinition: WordDefinition): WordDefinition {
        const noteContent = this.getNoteContent(noteDefinition);
        const baseSections = base.sections ? [...base.sections] : [];
        const sections = noteContent
            ? [...baseSections, { title: 'Note', content: noteContent }]
            : baseSections;
        const rawDefinition = [
            base.rawDefinition || base.definition || '',
            noteContent ? `**Note**\n${noteContent}` : '',
        ].filter(Boolean).join('\n\n---\n\n');

        return {
            ...base,
            sections: sections.length > 0 ? sections : base.sections,
            rawDefinition,
            userNote: noteContent,
            userNoteSource: {
                source: noteDefinition.source,
                nodeId: noteDefinition.nodeId,
            },
        };
    }

    private getBookOrder(source: string): number {
        const index = this.settings.vocabularyBooks.findIndex(book => book.path === source);
        return index === -1 ? Number.MAX_SAFE_INTEGER : index;
    }

    private mergeAliases(base: string[], aliases?: string[]): string[] {
        const merged = new Set(base.map(alias => alias.toLowerCase().trim()).filter(Boolean));
        aliases?.forEach(alias => {
            const normalized = alias.toLowerCase().trim();
            if (normalized) merged.add(normalized);
        });
        return [...merged];
    }
    
    /**
     * Incrementally update a specific book's cache
     * @param bookPath the word book path
     * @param definitions the book's word definitions
     */
    private updateCacheForBook(bookPath: string, definitions: WordDefinition[]): void {
        this.rebuildCache();
    }

    private collectMainWords(): Set<string> {
        const mainWords = new Set<string>();

        for (const definitions of this.definitions.values()) {
            for (const def of definitions) {
                const normalizedWord = def.word.toLowerCase().trim();
                if (normalizedWord) {
                    mainWords.add(normalizedWord);
                }
            }
        }

        return mainWords;
    }
    
    /**
     * Update a word in a Canvas file - incremental-update optimized version
     */
    async updateWordInCanvas(bookPath: string, nodeId: string, word: string, definition: string, color?: number, aliases?: string[]): Promise<boolean> {
        try {
            // 1. Update the Canvas file first
            const success = await this.canvasEditor.updateWordInCanvas(bookPath, nodeId, word, definition, color, aliases);
            
            if (success) {
                const language = this.inferWordLanguage(word);
                const type = inferLearningItemType(word, language);
                // 2. Create the updated word definition
                const updatedWordDef: WordDefinition = {
                    word,
                    type,
                    language,
                    studyKey: buildStudyKey({ word, language, type }),
                    definition,
                    source: bookPath,
                    nodeId, // Reusing the original nodeId
                    color: color ? this.getColorString(color) : undefined,
                    aliases: aliases?.filter(alias => alias && alias.trim().length > 0)
                };
                
                // 3. Update the memory cache immediately
                this.updateWordInMemoryCache(bookPath, nodeId, updatedWordDef);
                
                // 4. Rebuild the cache so it takes effect at once
                this.rebuildCache();
                
                return true;
            }
            
            return false;
        } catch (error) {
            console.error('Failed to update word in canvas:', error);
            return false;
        }
    }
    
    // ==================== Incremental-update optimizations ====================
    
    /**
     * Generate a temporary node ID
     */
    private generateTempNodeId(): string {
        return `temp_${Date.now()}_${++this.tempNodeIdCounter}`;
    }
    
    /**
     * Get the color string
     * Canvas uses numeric strings as color identifiers, not concrete color values
     */
    private getColorString(color: number): string | undefined {
        // Colors in Canvas are numeric strings like "1", "2", "3", etc.
        // Actual color mapping is handled by mapCanvasColorToCSSVar in color-utils.ts
        return (color >= 1 && color <= 6) ? color.toString() : undefined;
    }
    
    /**
     * Add the word to the memory cache
     */
    private addWordToMemoryCache(bookPath: string, wordDef: WordDefinition): void {
        // Get the book's existing words
        let bookWords = this.definitions.get(bookPath);
        if (!bookWords) {
            bookWords = [];
            this.definitions.set(bookPath, bookWords);
        }
        
        // Check for duplicates
        const existingIndex = bookWords.findIndex(w => w.word === wordDef.word);
        if (existingIndex >= 0) {
            bookWords[existingIndex] = wordDef; // Update
        } else {
            bookWords.push(wordDef); // Insert
        }
        
        // Update the word cache
        this.wordDefinitionCache.set(wordDef.word, wordDef);
        if (wordDef.aliases) {
            wordDef.aliases.forEach(alias => {
                this.wordDefinitionCache.set(alias, wordDef);
            });
        }
        
        // Mark the cache for rebuild
        this.cacheValid = false;
    }
    
    /**
     * Update a word in the memory cache (for editing)
     */
    private updateWordInMemoryCache(bookPath: string, nodeId: string, updatedWordDef: WordDefinition): void {
        // Get the book's existing words
        const bookWords = this.definitions.get(bookPath);
        if (!bookWords) {
            console.warn(`Book not found: ${bookPath}`);
            return;
        }
        
        // Find the word to update by nodeId
        const existingIndex = bookWords.findIndex(w => w.nodeId === nodeId);
        if (existingIndex >= 0) {
            const oldWordDef = bookWords[existingIndex];
            
            // Clear old cache mappings
            this.wordDefinitionCache.delete(oldWordDef.word);
            if (oldWordDef.aliases) {
                oldWordDef.aliases.forEach(alias => {
                    this.wordDefinitionCache.delete(alias);
                });
            }
            
            // Update the word
            bookWords[existingIndex] = updatedWordDef;
            
            // Update the new cache mappings
            this.wordDefinitionCache.set(updatedWordDef.word, updatedWordDef);
            if (updatedWordDef.aliases) {
                updatedWordDef.aliases.forEach(alias => {
                    this.wordDefinitionCache.set(alias, updatedWordDef);
                });
            }
            
            // Mark the cache for rebuild
            this.cacheValid = false;
        } else {
            console.warn(`Node ID not found: ${nodeId}`);
        }
    }
    
    /**
     * Schedule Canvas file sync
     */
    private scheduleCanvasSync(bookPath: string, wordDef: WordDefinition): void {
        // Clear the previous timer
        const existingTimeout = this.syncTimeouts.get(bookPath);
        if (existingTimeout) {
            window.clearTimeout(existingTimeout);
        }
        
        // Add to the pending-sync queue
        if (!this.pendingSyncWords.has(bookPath)) {
            this.pendingSyncWords.set(bookPath, []);
        }
        const pendingWords = this.pendingSyncWords.get(bookPath);
        if (!pendingWords) return;
        pendingWords.push(wordDef);
        
        // Set a new timer (batch sync after 1 second)
        const timeout = window.setTimeout(() => {
            void this.syncPendingWords(bookPath).catch(error => {
                console.error('HiWords failed to sync pending words:', error);
            });
        }, 1000);
        
        this.syncTimeouts.set(bookPath, timeout);
    }
    
    /**
     * Sync pending words to the Canvas file
     */
    private async syncPendingWords(bookPath: string): Promise<void> {
        const pendingWords = this.pendingSyncWords.get(bookPath);
        if (!pendingWords || pendingWords.length === 0) return;
        
        try {
            // Batch-write to Canvas
            for (const wordDef of pendingWords) {
                const generatedNodeId = await this.canvasEditor.addWordToCanvas(
                    bookPath,
                    wordDef.word,
                    wordDef.definition,
                    wordDef.color ? this.getColorNumber(wordDef.color) : undefined,
                    wordDef.aliases
                );
                
                if (generatedNodeId) {
                    // Written successfully; update to the nodeId actually created in the Canvas file
                    wordDef.nodeId = generatedNodeId;
                }
            }
            
            // Clear the pending-sync queue and timer
            this.pendingSyncWords.delete(bookPath);
            this.syncTimeouts.delete(bookPath);
            

            
        } catch (error) {
            console.error('Failed to sync words to canvas:', error);
            // A retry mechanism or user notification could be considered
        }
    }
    
    /**
     * Convert the color string to a number
     * Canvas uses numeric strings as color identifiers, not concrete color values
     */
    private getColorNumber(colorString: string): number {
        // Convert the string to a number directly
        const colorNum = parseInt(colorString, 10);
        // Validate it is a Canvas color number (1-6)
        return (colorNum >= 1 && colorNum <= 6) ? colorNum : 0;
    }

    /**
     * Delete a word from the Canvas file
     * @param bookPath the word book path
     * @param nodeId the node ID to delete
     * @returns whether the operation succeeded
     */
    async deleteWordFromCanvas(bookPath: string, nodeId: string): Promise<boolean> {
        try {
            // If the node has not been written to the Canvas file yet (temporary node ID),
            // remove it from memory and cancel any pending sync that would re-create it.
            // Otherwise the deferred sync would add the "deleted" word back to the file.
            if (nodeId.startsWith('temp_')) {
                this.cancelPendingSyncForNode(bookPath, nodeId);
                this.deleteWordFromMemoryCache(bookPath, nodeId);
                this.rebuildCache();
                return true;
            }

            // 1. Delete from the Canvas file first
            const success = await this.canvasEditor.deleteWordFromCanvas(bookPath, nodeId);
            
            if (success) {
                // 2. Delete from the memory cache
                this.deleteWordFromMemoryCache(bookPath, nodeId);
                
                // 3. Rebuild the cache so it takes effect at once
                this.rebuildCache();
                
                return true;
            }
            
            return false;
        } catch (error) {
            console.error('Failed to delete word from canvas:', error);
            return false;
        }
    }

    /**
     * Remove a not-yet-synced (temporary node ID) word from the pending Canvas sync queue
     */
    private cancelPendingSyncForNode(bookPath: string, nodeId: string): void {
        const pendingWords = this.pendingSyncWords.get(bookPath);
        if (!pendingWords) return;

        const index = pendingWords.findIndex(w => w.nodeId === nodeId);
        if (index >= 0) {
            pendingWords.splice(index, 1);
        }

        // If nothing is left to sync, clear the timer and the queue entirely
        if (pendingWords.length === 0) {
            const timeout = this.syncTimeouts.get(bookPath);
            if (timeout) {
                window.clearTimeout(timeout);
            }
            this.pendingSyncWords.delete(bookPath);
            this.syncTimeouts.delete(bookPath);
        }
    }

    /**
     * Remove a word from the memory cache (for deletion)
     */
    private deleteWordFromMemoryCache(bookPath: string, nodeId: string): void {
        // Get the book's existing words
        const bookWords = this.definitions.get(bookPath);
        if (!bookWords) {
            console.warn(`Book not found: ${bookPath}`);
            return;
        }
        
        // Find the word to delete by nodeId
        const existingIndex = bookWords.findIndex(w => w.nodeId === nodeId);
        if (existingIndex >= 0) {
            const wordDefToDelete = bookWords[existingIndex];
            
            // Clear cache mappings
            this.wordDefinitionCache.delete(wordDefToDelete.word);
            if (wordDefToDelete.aliases) {
                wordDefToDelete.aliases.forEach(alias => {
                    this.wordDefinitionCache.delete(alias);
                });
            }
            
            // Remove the word from the array
            bookWords.splice(existingIndex, 1);
            
            // Remove from memory-only words (if present)
            const memoryWords = this.memoryOnlyWords.get(bookPath);
            if (memoryWords) {
                const memoryIndex = memoryWords.findIndex(w => w.nodeId === nodeId);
                if (memoryIndex >= 0) {
                    memoryWords.splice(memoryIndex, 1);
                    if (memoryWords.length === 0) {
                        this.memoryOnlyWords.delete(bookPath);
                    }
                }
            }
            
            // Mark the cache for rebuild
            this.cacheValid = false;
        } else {
            console.warn(`Node ID not found: ${nodeId}`);
        }
    }
    
    /**
     * Clean up resources
     */
    destroy(): void {
        // Clear all timers
        this.syncTimeouts.forEach(timeout => window.clearTimeout(timeout));
        this.syncTimeouts.clear();
        
        // Clear the cache
        this.definitions.clear();
        this.wordDefinitionCache.clear();
        this.allWordsCache = [];
        this.bookWordsCache.clear();
        this.memoryOnlyWords.clear();
        this.pendingSyncWords.clear();
    }

    // ==================== Mastered-feature support methods ====================

    /**
     * Get a word definition by node ID
     * @param bookPath the word book path
     * @param nodeId the node ID
     * @returns the word definition or null
     */
    async getWordDefinitionByNodeId(bookPath: string, nodeId: string): Promise<WordDefinition | null> {
        const bookWords = this.definitions.get(bookPath);
        if (!bookWords) return null;

        const wordDef = bookWords.find(w => w.nodeId === nodeId);
        return wordDef || null;
    }

    /**
     * Update a word definition
     * @param bookPath the word book path
     * @param nodeId the node ID
     * @param updatedDef the updated definition
     * @returns whether the operation succeeded
     */
    async updateWordDefinition(bookPath: string, nodeId: string, updatedDef: WordDefinition): Promise<boolean> {
        const bookWords = this.definitions.get(bookPath);
        if (!bookWords) return false;

        const index = bookWords.findIndex(w => w.nodeId === nodeId);
        if (index === -1) return false;

        const oldDef = bookWords[index];
        
        // Update the definition
        bookWords[index] = updatedDef;

        // Update the cache
        this.wordDefinitionCache.delete(oldDef.word);
        if (oldDef.aliases) {
            oldDef.aliases.forEach(alias => this.wordDefinitionCache.delete(alias));
        }
        
        this.wordDefinitionCache.set(updatedDef.word, updatedDef);
        if (updatedDef.aliases) {
            updatedDef.aliases.forEach(alias => this.wordDefinitionCache.set(alias, updatedDef));
        }

        // Mark the cache for rebuild
        this.cacheValid = false;

        if (!bookPath.endsWith('.hiwords')) {
            try {
                await this.saveWordDefinitionToCanvas(bookPath, nodeId, updatedDef);
            } catch (error) {
                console.error('Failed to save word definition to Canvas:', error);
                // Do not return false since the in-memory update succeeded
            }
        }

        return true;
    }

    updateStudyKeyMasteredStatus(studyKey: string, mastered: boolean): void {
        for (const definitions of this.definitions.values()) {
            definitions.forEach((definition) => {
                if (definition.studyKey === studyKey) {
                    definition.mastered = mastered;
                }
            });
        }

        for (const definitions of this.memoryOnlyWords.values()) {
            definitions.forEach((definition) => {
                if (definition.studyKey === studyKey) {
                    definition.mastered = mastered;
                }
            });
        }

        this.cacheValid = false;
    }

    /**
     * Save the word definition to the Canvas file
     * @param bookPath the word book path
     * @param nodeId the node ID
     * @param wordDef the word definition
     */
    private async saveWordDefinitionToCanvas(bookPath: string, nodeId: string, wordDef: WordDefinition): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(bookPath);
        if (!(file instanceof TFile)) {
            throw new Error(`Canvas file does not exist: ${bookPath}`);
        }

        try {
            // Use Vault.process to modify the file
            await this.app.vault.process(file, (content) => {
                const canvasData = JSON.parse(content) as CanvasData;
                
                // Find the node to update
                const node = canvasData.nodes.find((n) => n.id === wordDef.nodeId);
                if (!node) {
                    throw new Error(`Node ID not found: ${wordDef.nodeId}`);
                }
                
                // Build plain-text content without frontmatter
                let textContent = wordDef.word;
                
                // Add aliases (if any) in italic form
                if (wordDef.aliases && wordDef.aliases.length > 0) {
                    textContent += `\n*${wordDef.aliases.join(', ')}*`;
                }
                
                // Add the definition
                if (wordDef.definition) {
                    textContent += '\n' + wordDef.definition;
                }
                
                // Update the node content
                node.text = textContent;
                
                // Return the updated content
                return JSON.stringify(canvasData);
            });
        } catch (error) {
            console.error('Failed to save Canvas file:', error);
            throw error;
        }
    }

    /**
     * Get all word definitions
     * @returns headword definitions deduplicated by StudyKey
     */
    async getAllWordDefinitions(): Promise<WordDefinition[]> {
        return this.getStudyDefinitions();
    }

    /**
     * Get all word definitions of a specific book
     * @param bookPath the word book path
     * @returns all word definitions in this book
     */
    async getWordDefinitionsByBook(bookPath: string): Promise<WordDefinition[]> {
        const bookWords = this.definitions.get(bookPath) || [];
        const memoryWords = this.memoryOnlyWords.get(bookPath) || [];
        
        return [...bookWords, ...memoryWords];
    }

    /**
     * Get the list of unmastered words (for highlight filtering)
     * @returns array of unmastered words
     */
    async getUnmasteredWords(): Promise<string[]> {
        if (!this.cacheValid) {
            this.rebuildCache();
        }
        
        // Filter unmastered words from the cache
        const unmasteredWords: string[] = [];
        
        for (const word of this.allWordsCache) {
            const wordDef = this.wordDefinitionCache.get(word);
            if (wordDef && !wordDef.mastered) {
                unmasteredWords.push(word);
            }
        }
        
        return unmasteredWords;
    }

    /**
     * Get the list of mastered words
     * @returns array of mastered words
     */
    async getMasteredWords(): Promise<string[]> {
        if (!this.cacheValid) {
            this.rebuildCache();
        }
        
        // Filter mastered words from the cache
        const masteredWords: string[] = [];
        
        for (const word of this.allWordsCache) {
            const wordDef = this.wordDefinitionCache.get(word);
            if (wordDef && wordDef.mastered) {
                masteredWords.push(word);
            }
        }
        
        return masteredWords;
    }

    /**
     * Check whether a word is mastered
     * @param word the word
     * @returns whether it is mastered
     */
    isWordMastered(word: string): boolean {
        const wordDef = this.wordDefinitionCache.get(word.toLowerCase());
        return wordDef?.mastered === true;
    }
}
