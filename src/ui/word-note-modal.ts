import { Modal, Notice, setIcon } from 'obsidian';
import HiWordsPlugin from '../../main';
import type { WordDefinition } from '../utils';
import { t } from '../i18n';

export class WordNoteModal extends Modal {
    private plugin: HiWordsPlugin;
    private wordDef: WordDefinition;
    private onSaved: () => void | Promise<void>;

    constructor(plugin: HiWordsPlugin, wordDef: WordDefinition, onSaved: () => void | Promise<void>) {
        super(plugin.app);
        this.plugin = plugin;
        this.wordDef = wordDef;
        this.onSaved = onSaved;
    }

    onOpen() {
        this.titleEl.setText(t('sidebar.note_modal_title').replace('{0}', this.wordDef.word));
        this.contentEl.empty();

        const existingNote = this.wordDef.userNote || this.getNoteFromDefinition(this.wordDef);
        const textarea = this.contentEl.createEl('textarea', {
            cls: 'setting-item-input hiwords-word-definition-input',
            attr: { placeholder: t('sidebar.note_placeholder') },
        });
        textarea.value = existingNote;
        // Default height enlarged by 1.25x (was 8 rows)
        textarea.rows = 10;
        window.setTimeout(() => textarea.focus(), 50);

        const bookSelect = this.createBookSelect();

        const buttons = this.contentEl.createDiv({ cls: 'hiwords-modal-button-container' });
        const leftButtons = buttons.createDiv({ cls: 'hiwords-button-group-left' });
        if (this.wordDef.userNoteSource) {
            const deleteButton = leftButtons.createEl('button', {
                cls: 'mod-warning',
                attr: { title: t('sidebar.delete_note'), 'aria-label': t('sidebar.delete_note') },
            });
            setIcon(deleteButton, 'trash');
            deleteButton.onclick = () => {
                void this.deleteNote().catch(error => {
                    console.error('HiWords failed to delete note:', error);
                    new Notice(t('sidebar.note_delete_failed'));
                });
            };
        }

        const rightButtons = buttons.createDiv({ cls: 'hiwords-button-group-right' });
        const cancel = rightButtons.createEl('button', { text: t('modals.cancel_button') });
        cancel.onclick = () => this.close();

        const save = rightButtons.createEl('button', { text: t('modals.save_button'), cls: 'mod-cta' });
        save.onclick = () => {
            void this.saveNote(textarea.value.trim(), bookSelect?.value).catch(error => {
                console.error('HiWords failed to save note:', error);
                new Notice(t('sidebar.note_save_failed'));
            });
        };
    }

    private createBookSelect(): HTMLSelectElement | null {
        if (this.wordDef.userNoteSource) return null;

        const canvasBooks = this.plugin.settings.vocabularyBooks
            .filter(book => book.enabled && book.path.endsWith('.canvas'));

        const row = this.contentEl.createDiv({ cls: 'hiwords-form-item' });
        row.createEl('label', { text: t('modals.book_label'), cls: 'hiwords-form-item-label' });

        if (canvasBooks.length === 0) {
            row.createDiv({ cls: 'setting-item-description', text: t('notices.no_canvas_files') });
            return null;
        }

        const select = row.createEl('select', { cls: 'dropdown' });
        canvasBooks.forEach(book => select.createEl('option', { text: book.name, value: book.path }));
        return select;
    }

    private async saveNote(note: string, selectedBookPath?: string) {
        if (!note) {
            new Notice(t('sidebar.note_required'));
            return;
        }

        const noteText = `**Note**\n${note}`;
        const noteSource = this.wordDef.userNoteSource;

        if (noteSource) {
            const success = await this.plugin.vocabularyManager.updateWordInCanvas(
                noteSource.source,
                noteSource.nodeId,
                this.wordDef.word,
                noteText
            );
            if (!success) {
                new Notice(t('sidebar.note_save_failed'));
                return;
            }
        } else {
            if (!selectedBookPath) {
                new Notice(t('notices.select_book_required'));
                return;
            }
            const success = await this.plugin.vocabularyManager.addWordToCanvas(
                selectedBookPath,
                this.wordDef.word,
                noteText,
                undefined,
                this.wordDef.aliases
            );
            if (!success) {
                new Notice(t('sidebar.note_save_failed'));
                return;
            }
        }

        await this.plugin.vocabularyManager.loadAllVocabularyBooks();
        this.plugin.refreshHighlighter();
        await this.onSaved();
        this.close();
        new Notice(t('sidebar.note_saved'));
    }

    private async deleteNote() {
        const noteSource = this.wordDef.userNoteSource;
        if (!noteSource) return;

        const success = await this.plugin.vocabularyManager.deleteWordFromCanvas(noteSource.source, noteSource.nodeId);
        if (!success) {
            new Notice(t('sidebar.note_delete_failed'));
            return;
        }

        await this.plugin.vocabularyManager.loadAllVocabularyBooks();
        this.plugin.refreshHighlighter();
        await this.onSaved();
        this.close();
        new Notice(t('sidebar.note_deleted'));
    }

    private getNoteFromDefinition(wordDef: WordDefinition): string {
        const noteSection = wordDef.sections?.find(section => this.isNoteTitle(section.title));
        return noteSection?.content || '';
    }

    private isNoteTitle(title: string): boolean {
        return ['note', 'notes', '备注', '我的备注'].includes(title.trim().toLowerCase());
    }
}
