/**
 * Mastered-words service
 * Manages mastered state of words: marking, unmarking, state synchronization, etc.
 */

import { Notice } from 'obsidian';
import { VocabularyManager } from './vocabulary-manager';
import { t } from '../i18n';
import HiWordsPlugin from '../../main';
import type { WordDefinition } from '../utils';

export class MasteredService {
    private plugin: HiWordsPlugin;
    private vocabularyManager: VocabularyManager;

    constructor(plugin: HiWordsPlugin, vocabularyManager: VocabularyManager) {
        this.plugin = plugin;
        this.vocabularyManager = vocabularyManager;
    }

    updateSettings() {}

    /**
     * Check whether the mastered feature is enabled
     */
    get isEnabled(): boolean {
        return this.plugin.settings.enableMasteredFeature;
    }

    /**
     * Mark a word as mastered
     * @param bookPath the word book path
     * @param nodeId the node ID
     * @param word the word text
     * @returns whether the operation succeeded
     */
    async markWordAsMastered(bookPath: string, nodeId: string, word: string): Promise<boolean> {
        if (!this.isEnabled) {
            new Notice(t('notices.mastered_feature_disabled'));
            return false;
        }

        try {
            const wordDef = await this.vocabularyManager.getWordDefinitionByNodeId(bookPath, nodeId);
            if (!wordDef?.studyKey) {
                new Notice(t('notices.update_word_status_failed'));
                return false;
            }

            await this.saveStudyProgress(wordDef, true);
            this.vocabularyManager.updateStudyKeyMasteredStatus(wordDef.studyKey, true);
            this.plugin.refreshHighlighter();
            this.plugin.app.workspace.trigger('hi-words:mastered-changed');
            new Notice(t('notices.word_marked_as_mastered').replace('{0}', word));

            return true;
        } catch (error) {
            console.error('Failed to mark as mastered:', error);
            new Notice(t('notices.mark_mastered_failed'));
            return false;
        }
    }

    /**
     * Unmark a word as mastered
     * @param bookPath the word book path
     * @param nodeId the node ID
     * @param word the word text
     * @returns whether the operation succeeded
     */
    async unmarkWordAsMastered(bookPath: string, nodeId: string, word: string): Promise<boolean> {
        if (!this.isEnabled) {
            new Notice(t('notices.mastered_feature_disabled'));
            return false;
        }

        try {
            const wordDef = await this.vocabularyManager.getWordDefinitionByNodeId(bookPath, nodeId);
            if (!wordDef?.studyKey) {
                new Notice(t('notices.update_word_status_failed'));
                return false;
            }

            await this.saveStudyProgress(wordDef, false);
            this.vocabularyManager.updateStudyKeyMasteredStatus(wordDef.studyKey, false);
            this.plugin.refreshHighlighter();
            this.plugin.app.workspace.trigger('hi-words:mastered-changed');
            new Notice(t('notices.word_unmarked_as_mastered').replace('{0}', word));

            return true;
        } catch (error) {
            console.error('Failed to unmark as mastered:', error);
            new Notice(t('notices.unmark_mastered_failed'));
            return false;
        }
    }

    /**
     * Check whether a word is mastered
     * @param bookPath the word book path
     * @param nodeId the node ID
     * @returns whether it is mastered
     */
    async isWordMastered(bookPath: string, nodeId: string): Promise<boolean> {
        if (!this.isEnabled) return false;

        try {
            const wordDef = await this.vocabularyManager.getWordDefinitionByNodeId(bookPath, nodeId);
            return wordDef?.mastered === true;
        } catch (error) {
            console.error('Failed to check word mastered state:', error);
            return false;
        }
    }

    /**
     * Get the list of mastered words
     * @param bookPath optional word book path; if omitted, returns mastered words from all books
     * @returns array of mastered word definitions
     */
    async getMasteredWords(bookPath?: string) {
        if (!this.isEnabled) return [];

        try {
            const allWords = await this.vocabularyManager.getAllWordDefinitions();
            
            return allWords.filter(wordDef => {
                // Filter mastered words
                if (!wordDef.mastered) return false;
                
                // If a book path is given, return only that book's words
                if (bookPath && wordDef.source !== bookPath) return false;
                
                return true;
            });
        } catch (error) {
            console.error('Failed to get mastered word list:', error);
            return [];
        }
    }

    /**
     * Get mastered-word statistics
     * @returns the statistics object
     */
    async getMasteredStats() {
        if (!this.isEnabled) {
            return {
                totalMastered: 0,
                totalWords: 0,
                masteredPercentage: 0,
                byBook: {}
            };
        }

        try {
            const allWords = await this.vocabularyManager.getAllWordDefinitions();
            const masteredWords = allWords.filter(w => w.mastered);
            
            // Group statistics by word book
            const byBook: { [bookPath: string]: { mastered: number, total: number } } = {};
            
            allWords.forEach(word => {
                if (!byBook[word.source]) {
                    byBook[word.source] = { mastered: 0, total: 0 };
                }
                byBook[word.source].total++;
                if (word.mastered) {
                    byBook[word.source].mastered++;
                }
            });

            return {
                totalMastered: masteredWords.length,
                totalWords: allWords.length,
                masteredPercentage: allWords.length > 0 ? (masteredWords.length / allWords.length) * 100 : 0,
                byBook
            };
        } catch (error) {
            console.error('Failed to get mastered statistics:', error);
            return {
                totalMastered: 0,
                totalWords: 0,
                masteredPercentage: 0,
                byBook: {}
            };
        }
    }

    /**
     * Batch-mark multiple words as mastered
     * @param operations array of operations, each with bookPath, nodeId, word
     * @returns the number of successful operations
     */
    async batchMarkAsMastered(operations: Array<{ bookPath: string, nodeId: string, word: string }>): Promise<number> {
        if (!this.isEnabled) return 0;

        let successCount = 0;
        
        for (const op of operations) {
            const success = await this.markWordAsMastered(op.bookPath, op.nodeId, op.word);
            if (success) successCount++;
        }

        if (successCount > 0) {
            new Notice(t('notices.batch_marked_success').replace('{0}', successCount.toString()));
        }

        return successCount;
    }

    private async saveStudyProgress(wordDef: WordDefinition | null, mastered: boolean): Promise<void> {
        if (!wordDef?.studyKey) return;

        if (!this.plugin.settings.studyProgress) {
            this.plugin.settings.studyProgress = {};
        }

        if (!mastered) {
            delete this.plugin.settings.studyProgress[wordDef.studyKey];
            await this.plugin.saveSettings();
            return;
        }

        const now = new Date().toISOString();
        this.plugin.settings.studyProgress[wordDef.studyKey] = {
            status: 'mastered',
            masteredAt: this.plugin.settings.studyProgress[wordDef.studyKey]?.masteredAt || now,
            updatedAt: now,
        };
        await this.plugin.saveSettings();
    }

}
