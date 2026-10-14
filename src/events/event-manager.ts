import { Editor, Notice, TAbstractFile, TFile } from 'obsidian';
import type HiWordsPlugin from '../../main';
import { t } from '../i18n';
import { extractSentenceFromEditorMultiline } from '../utils/sentence-extractor';

/**
 * Register all plugin event listeners
 * @param plugin the HiWords plugin instance
 */
export function registerEvents(plugin: HiWordsPlugin) {
    // Track the Canvas file currently being edited
    const modifiedCanvasFiles = new Set<string>();
    // Track the currently active Canvas file
    let activeCanvasFile: string | null = null;
    
    // Listen for file changes
    plugin.registerEvent(
        plugin.app.vault.on('modify', (file) => {
            if (file instanceof TFile && file.extension === 'canvas') {
                // Check whether it is a word book file
                const isVocabBook = plugin.settings.vocabularyBooks.some(book => book.path === file.path);
                if (isVocabBook) {
                    // Only record the file path; do not parse immediately
                    modifiedCanvasFiles.add(file.path);
                }
            }
        })
    );

    // Listen for active-file changes
    const handleActiveLeafChange = async () => {
            // Get the current active file
            const activeFile = plugin.app.workspace.getActiveFile();
            
            // If there was an active Canvas file that changed and focus has now moved to another file
            // the user has finished editing and switched focus; parse that file now
            if (activeCanvasFile && 
                modifiedCanvasFiles.has(activeCanvasFile) && 
                (!activeFile || activeFile.path !== activeCanvasFile)) {
                
                await plugin.vocabularyManager.reloadVocabularyBook(activeCanvasFile);
                plugin.refreshHighlighter();
                
                // Remove it from the pending-parse list
                modifiedCanvasFiles.delete(activeCanvasFile);
            }
            
            // Update the currently active Canvas file
            if (activeFile && activeFile.extension === 'canvas') {
                activeCanvasFile = activeFile.path;
            } else {
                activeCanvasFile = null;
                
                // If switching to a non-Canvas file, process all pending files
                if (modifiedCanvasFiles.size > 0) {
                    // Create a copy and clear the original set
                    const filesToProcess = Array.from(modifiedCanvasFiles);
                    modifiedCanvasFiles.clear();
                    
                    // Process all pending files
                    for (const filePath of filesToProcess) {
                        await plugin.vocabularyManager.reloadVocabularyBook(filePath);
                    }
                    
                    // Refresh highlights
                    plugin.refreshHighlighter();
                } else {
                    // Highlights may need updating when switching files
                    window.setTimeout(() => plugin.refreshHighlighter(), 100);
                }
            }
    };

    plugin.registerEvent(
        plugin.app.workspace.on('active-leaf-change', () => {
            void handleActiveLeafChange().catch(error => {
                console.error('HiWords failed to handle active file change:', error);
            });
        })
    );
    
    // Listen for file rename/move
    const handleRename = async (file: TAbstractFile, oldPath: string) => {
            if (file instanceof TFile && (file.extension === 'canvas' || file.extension === 'hiwords')) {
                // Check whether the old path is in the word book list
                const bookIndex = plugin.settings.vocabularyBooks.findIndex(book => book.path === oldPath);
                if (bookIndex !== -1) {
                    // Update to the new path
                    plugin.settings.vocabularyBooks[bookIndex].path = file.path;
                    // Update the name (using the new file name)
                    plugin.settings.vocabularyBooks[bookIndex].name = file.basename;
                    await plugin.saveSettings();
                    
                    // Delete data under the old path to avoid double counting
                    plugin.vocabularyManager.removeBookData(oldPath);
                    
                    // Reload this word book (using the new path)
                    await plugin.vocabularyManager.reloadVocabularyBook(file.path);
                    plugin.refreshHighlighter();
                    
                    new Notice(t('notices.book_path_updated').replace('{0}', file.basename));
                }
            }
    };

    plugin.registerEvent(
        plugin.app.vault.on('rename', (file, oldPath) => {
            void handleRename(file, oldPath).catch(error => {
                console.error('HiWords failed to handle file rename:', error);
            });
        })
    );
    
    // Register the editor context menu
    plugin.registerEvent(
        plugin.app.workspace.on('editor-menu', (menu, editor: Editor) => {
            const selection = editor.getSelection();
            if (selection && selection.trim()) {
                const word = selection.trim();
                const existingDefinition = plugin.vocabularyManager.getDefinition(word);
                
                menu.addItem((item) => {
                    const canEdit = existingDefinition && !existingDefinition.source.endsWith('.hiwords');
                    const titleKey = canEdit ? 'commands.edit_word' : 'commands.add_word';
                    
                    item
                        .setTitle(t(titleKey))
                        .onClick(() => {
                            // Extract the sentence (multi-line supported)
                            const sentence = extractSentenceFromEditorMultiline(editor);
                            plugin.addOrEditWord(word, sentence);
                        });
                });
            }
        })
    );
}
