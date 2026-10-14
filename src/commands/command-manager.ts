import { Notice, MarkdownView } from 'obsidian';
import type HiWordsPlugin from '../../main';
import { t } from '../i18n';
import { extractSentenceFromEditorMultiline, extractSentenceFromSelection } from '../utils/sentence-extractor';

/**
 * Register all plugin commands
 * @param plugin the HiWords plugin instance
 */
export function registerCommands(plugin: HiWordsPlugin) {
    // Refresh word books command
    plugin.addCommand({
        id: 'refresh-vocabulary',
        name: t('commands.refresh_vocabulary'),
        callback: async () => {
            await plugin.vocabularyManager.loadAllVocabularyBooks();
            plugin.refreshHighlighter();
            new Notice(t('notices.vocabulary_refreshed'));
        }
    });

    // Open word-list sidebar command
    plugin.addCommand({
        id: 'open-vocabulary-sidebar',
        name: t('commands.show_sidebar'),
        callback: () => {
            void plugin.activateSidebarView().catch(error => {
                console.error('Failed to open HiWords sidebar:', error);
            });
        }
    });

    plugin.addCommand({
        id: 'open-vocabulary-library',
        name: t('commands.open_library'),
        callback: () => {
            void plugin.activateLibraryView().catch(error => {
                console.error('Failed to open HiWords word manager:', error);
            });
        }
    });

    plugin.addCommand({
        id: 'toggle-sidebar-default-display',
        name: t('commands.toggle_sidebar_default_display'),
        callback: async () => {
            const nextMode = (plugin.settings.sidebarDefaultDisplayMode || 'detail') === 'detail' ? 'word' : 'detail';
            plugin.settings.sidebarDefaultDisplayMode = nextMode;
            await plugin.saveSettings();

            const leaves = plugin.app.workspace.getLeavesOfType('hi-words-sidebar');
            leaves.forEach((leaf) => {
                const view = leaf.view as { applyDefaultDisplayMode?: () => void };
                if (typeof view.applyDefaultDisplayMode === 'function') {
                    view.applyDefaultDisplayMode();
                }
            });

            plugin.app.workspace.trigger('hi-words:settings-changed');
            const label = nextMode === 'detail'
                ? t('settings.sidebar_display_detail')
                : t('settings.sidebar_display_word');
            new Notice(`${t('settings.sidebar_default_display_mode')}: ${label}`);
        }
    });

    // Add selected word to word book command (adapts to all view modes)
    plugin.addCommand({
        id: 'add-selected-word',
        name: t('commands.add_selected_word'),
        callback: () => {
            let word = '';
            let sentence = '';
            
            // Try to get the current active editor
            const activeView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
            const editor = activeView?.editor;
            const viewMode = activeView?.getMode();
            
            // Check whether we are in edit mode (Live Preview or Source Mode)
            // Both Live Preview and Source Mode return 'source'; reading mode returns 'preview'
            const isEditMode = editor && viewMode === 'source';
            
            if (isEditMode) {
                // Edit mode: use the Editor API for more accurate sentence extraction (multi-line supported)
                word = editor.getSelection().trim();
                sentence = extractSentenceFromEditorMultiline(editor);
            } else {
                // Reading mode/PDF view: use window.getSelection()
                const selection = window.getSelection();
                word = selection?.toString().trim() || '';
                
                // Fallback: if selection.toString() is empty, try reading from the range
                if (!word && selection && selection.rangeCount > 0) {
                    word = selection.getRangeAt(0).toString().trim();
                }
                
                sentence = extractSentenceFromSelection(selection);
            }
            
            // Open the modal (prefilled when text is selected; manual input otherwise)
            plugin.addOrEditWord(word, sentence);
        }
    });
}
