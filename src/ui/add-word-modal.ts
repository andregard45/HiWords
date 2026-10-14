import { App, Modal, Notice, setIcon } from 'obsidian';
import type { WordDefinition } from '../utils';
import HiWordsPlugin from '../../main';
import { t } from '../i18n';

/**
 * Modal for adding or editing vocabulary
 */
export class AddWordModal extends Modal {
    private plugin: HiWordsPlugin;
    private word: string;
    private sentence: string;
    private isEditMode: boolean;
    private definition: WordDefinition | null;
    private prefilledDefinition: string;

    // Static variable remembering the user's last chosen word book (lost on restart)
    private static lastSelectedBookPath: string | null = null;
    // Static variable remembering the user's last chosen color (lost on restart)
    private static lastSelectedColorValue: string | null = null;

    /**
     * Constructor
     * @param app the Obsidian App instance
     * @param plugin the plugin instance
     * @param word the word to add or edit
     * @param sentence the sentence containing the word (optional)
     * @param isEditMode whether this is edit mode
     */
    constructor(app: App, plugin: HiWordsPlugin, word: string, sentence = '', isEditMode = false, prefilledDefinition = '', definition?: WordDefinition) {
        super(app);
        this.plugin = plugin;
        this.word = word;
        this.sentence = sentence;
        this.isEditMode = isEditMode;

        this.prefilledDefinition = prefilledDefinition;

        // In edit mode, fetch the word's definition
        if (isEditMode) {
            this.definition = definition || this.plugin.vocabularyManager.getDefinition(word);
        } else {
            this.definition = null;
        }
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        if (this.isEditMode && this.definition?.source.endsWith('.hiwords')) {
            contentEl.createEl('p', {
                text: t('notices.readonly_hiwords_book'),
                cls: 'setting-item-description'
            });

            const buttonContainer = contentEl.createDiv({ cls: 'hiwords-button-container' });
            const closeButton = buttonContainer.createEl('button', { text: t('modals.cancel_button') });
            closeButton.onclick = () => this.close();
            return;
        }

        // Word input (shown only in add mode)
        let wordInput: HTMLInputElement | null = null;
        if (!this.isEditMode) {
            const wordContainer = contentEl.createDiv({ cls: 'hiwords-form-item' });
            wordContainer.createEl('label', { text: t('modals.word_label'), cls: 'hiwords-form-item-label' });

            wordInput = wordContainer.createEl('input', {
                type: 'text',
                placeholder: t('modals.word_placeholder'),
                cls: 'setting-item-input'
            });
            wordInput.value = this.word;

            // If no word is prefilled, autofocus the word input
            if (!this.word) {
                window.setTimeout(() => wordInput?.focus(), 50);
            }
        }

        // Word book selection
        const bookSelectContainer = contentEl.createDiv({ cls: 'hiwords-form-item' });
        bookSelectContainer.createEl('label', { text: t('modals.book_label'), cls: 'hiwords-form-item-label' });

        const bookSelect = bookSelectContainer.createEl('select', { cls: 'dropdown' });
        bookSelect.createEl('option', { text: t('modals.select_book'), value: '' });

        const enabledBooks = this.plugin.settings.vocabularyBooks
            .filter(book => book.enabled && book.path.endsWith('.canvas'));
        let defaultBookSelected = false;
        enabledBooks.forEach((book, index) => {
            const option = bookSelect.createEl('option', { text: book.name, value: book.path });

            // In edit mode, select this option if the word comes from this book
            if (this.isEditMode && this.definition && this.definition.source === book.path) {
                option.selected = true;
                defaultBookSelected = true;
            }
            // In add mode, prefer the last used word book
            else if (!this.isEditMode && !defaultBookSelected) {
                // Prefer the last used word book
                if (AddWordModal.lastSelectedBookPath && book.path === AddWordModal.lastSelectedBookPath) {
                    option.selected = true;
                    defaultBookSelected = true;
                }
                // If there is no cache or the cached book is unavailable, pick the first one
                else if (!AddWordModal.lastSelectedBookPath && index === 0) {
                    option.selected = true;
                    defaultBookSelected = true;
                }
            }
        });

        // In edit mode, disable the book selector (moving entries across books is not allowed)
        if (this.isEditMode && this.definition) {
            bookSelect.disabled = true;
        }

        // Color selection
        const colorSelectContainer = contentEl.createDiv({ cls: 'hiwords-form-item' });
        colorSelectContainer.createEl('label', { text: t('modals.color_label'), cls: 'hiwords-form-item-label' });

        const colorSelect = colorSelectContainer.createEl('select', { cls: 'dropdown setting-item-select' });
        const grayOption = colorSelect.createEl('option', { text: t('modals.color_gray'), value: '' });
        if (!this.isEditMode && AddWordModal.lastSelectedColorValue === '') {
            grayOption.selected = true;
        }

        // Colors supported by Canvas
        const colors = [
            { name: t('modals.color_red'), value: '1' },
            { name: t('modals.color_orange'), value: '2' },
            { name: t('modals.color_yellow'), value: '3' },
            { name: t('modals.color_green'), value: '4' },
            { name: t('modals.color_blue'), value: '5' },
            { name: t('modals.color_purple'), value: '6' }
        ];

        colors.forEach(color => {
            const option = colorSelect.createEl('option', { text: color.name, value: color.value });

            // In edit mode, select this option if the word uses this color
            if (this.isEditMode && this.definition && this.definition.color === color.value) {
                option.selected = true;
            }
            // In add mode, prefer the last used color
            else if (!this.isEditMode && AddWordModal.lastSelectedColorValue === color.value) {
                option.selected = true;
            }
        });

        // Alias input
        const aliasesContainer = contentEl.createDiv({ cls: 'hiwords-form-item' });
        aliasesContainer.createEl('label', { text: t('modals.aliases_label'), cls: 'hiwords-form-item-label' });

        const aliasesInput = aliasesContainer.createEl('input', {
            type: 'text',
            placeholder: t('modals.aliases_placeholder'),
            cls: 'setting-item-input word-aliases-input'
        });

        // In edit mode, prefill aliases if the word has them
        if (this.isEditMode && this.definition && this.definition.aliases && this.definition.aliases.length > 0) {
            aliasesInput.value = this.definition.aliases.join(', ');
        }

        // Description input (renamed from "Definition" for consistency)
        const definitionContainer = contentEl.createDiv({ cls: 'hiwords-form-item' });
        definitionContainer.createEl('label', { text: t('modals.definition_label'), cls: 'hiwords-form-item-label' });

        const definitionInput = definitionContainer.createEl('textarea', {
            placeholder: t('modals.definition_placeholder'),
            cls: 'setting-item-input hiwords-word-definition-input'
        });
        definitionInput.rows = 5;

        // In edit mode, prefill the definition if present
        if (this.isEditMode && this.definition) {
            definitionInput.value = this.definition.rawDefinition || this.definition.definition;
        }
        else if (this.prefilledDefinition) {
            definitionInput.value = this.prefilledDefinition;
        }
        else if (!this.isEditMode) {
            // Add mode: prefill the customizable description template from settings
            definitionInput.value = this.buildDescriptionTemplate();
        }

        // Smart focus logic
        window.setTimeout(() => {
            if (!this.isEditMode && this.word) {
                // Add mode with a prefilled word: focus the definition input
                definitionInput.focus();
            } else if (this.isEditMode && this.definition) {
                // Edit mode: focus the definition input (easier to edit definitions)
                definitionInput.focus();
            }
            // Note: in add mode without a prefilled word, focus was already set to the word input earlier (line 64)
        }, 50);

        // Buttons
        const buttonContainer = contentEl.createDiv({ cls: 'hiwords-modal-button-container' });

        // Create the left container (delete button or spacer)
        const leftButtonGroup = buttonContainer.createDiv({ cls: 'hiwords-button-group-left' });

        // In edit mode, add the delete button (left side)
        // The delete button targets the user's own Canvas node. When a word card
        // from a read-only .hiwords dictionary is merged with a user note stored
        // in a Canvas book, `definition.source` points at the .hiwords package,
        // so we must prefer `userNoteSource` instead.
        const deletableSource = this.isEditMode
            ? (this.definition?.userNoteSource ??
                (this.definition && !this.definition.source.endsWith('.hiwords') ? this.definition : null))
            : null;

        if (deletableSource) {
            const deleteButton = leftButtonGroup.createEl('button', {
                cls: 'delete-word-button',
                attr: { title: t('modals.delete_button'), 'aria-label': t('modals.delete_button') },
            });
            // Use Obsidian's setIcon
            setIcon(deleteButton, 'trash');

            // Two-step confirmation directly on the button. We intentionally do
            // NOT open a nested Modal here: opening a second modal on top of an
            // existing one steals focus and swallows keyboard/ESC events, which
            // previously made the delete flow appear to "do nothing".
            let confirmArmed = false;
            let confirmTimer: number | undefined;

            const disarm = () => {
                confirmArmed = false;
                if (confirmTimer !== undefined) {
                    window.clearTimeout(confirmTimer);
                    confirmTimer = undefined;
                }
                deleteButton.removeClass('is-confirming');
                deleteButton.empty();
                setIcon(deleteButton, 'trash');
                deleteButton.setAttribute('title', t('modals.delete_button'));
                deleteButton.setAttribute('aria-label', t('modals.delete_button'));
            };

            deleteButton.onclick = () => {
                if (!confirmArmed) {
                    // First click: arm the button and ask for confirmation inline
                    confirmArmed = true;
                    deleteButton.addClass('is-confirming');
                    deleteButton.empty();
                    deleteButton.setText(t('modals.confirm_delete_button'));
                    deleteButton.setAttribute('title', t('modals.delete_confirmation').replace('{0}', this.definition?.word || this.word).split('\n')[0]);
                    deleteButton.setAttribute('aria-label', t('modals.confirm_delete_button'));
                    confirmTimer = window.setTimeout(disarm, 3000);
                    return;
                }

                // Second click within the time window: perform the deletion
                disarm();

                void (async () => {
                    // Show the deleting notice
                    const loadingNotice = new Notice(t('notices.deleting_word'), 0);
                    const source = deletableSource;

                    try {
                        const success = await this.plugin.vocabularyManager.deleteWordFromCanvas(
                            source.source,
                            source.nodeId
                        );

                        loadingNotice.hide();

                        if (success) {
                            new Notice(t('notices.word_deleted'));
                            // Refresh highlights
                            this.plugin.refreshHighlighter();
                            this.close();
                        } else {
                            new Notice(t('notices.delete_word_failed'));
                        }
                    } catch (error) {
                        loadingNotice.hide();
                        console.error('Error while deleting word:', error);
                        new Notice(t('notices.error_deleting_word'));
                    }
                })();
            };
        }

        // Create the right button group
        const rightButtonGroup = buttonContainer.createDiv({ cls: 'hiwords-button-group-right' });

        const cancelButton = rightButtonGroup.createEl('button', { text: t('modals.cancel_button') });
        cancelButton.onclick = () => this.close();

        // Show different button text depending on mode
        const buttonTextKey = this.isEditMode ? 'modals.save_button' : 'modals.add_button';
        const actionButton = rightButtonGroup.createEl('button', { text: t(buttonTextKey), cls: 'mod-cta' });
        actionButton.onclick = () => {
            void (async () => {
                // In add mode, read the word from the input
                let finalWord = this.word;
                if (!this.isEditMode && wordInput) {
                    finalWord = wordInput.value.trim();
                    if (!finalWord) {
                        new Notice(t('notices.word_required'));
                        wordInput.focus();
                        return;
                    }
                }

                const selectedBook = bookSelect.value;
                const definition = definitionInput.value;
                const colorValue = colorSelect.value ? parseInt(colorSelect.value) : undefined;
                const aliasesText = aliasesInput.value.trim();

                // Process aliases
                let aliases: string[] | undefined = undefined;
                if (aliasesText) {
                    aliases = aliasesText.split(',').map(alias => alias.trim().toLowerCase());
                    // Drop empty aliases
                    aliases = aliases.filter(alias => alias.length > 0);
                    if (aliases.length === 0) {
                        aliases = undefined;
                    }
                }

                if (!selectedBook) {
                    new Notice(t('notices.select_book_required'));
                    return;
                }

                // Show the loading notice
                const loadingNotice = this.isEditMode ?
                    new Notice(t('notices.updating_word'), 0) :
                    new Notice(t('notices.adding_word'), 0);

                try {
                    let success = false;

                    if (this.isEditMode && this.definition) {
                        // Edit mode: call the update-word method

                        success = await this.plugin.vocabularyManager.updateWordInCanvas(
                            this.definition.source,
                            this.definition.nodeId,
                            finalWord,
                            definition,
                            colorValue,
                            aliases
                        );

                        // Dismiss the loading notice
                        loadingNotice.hide();

                        if (success) {
                            // Use format-string replacement
                            const successMessage = t('notices.word_updated_success').replace('{0}', finalWord);
                            new Notice(successMessage);
                            // Refresh highlighters
                            this.plugin.refreshHighlighter();
                            this.close();
                        } else {
                            new Notice(t('notices.update_word_failed'));
                        }
                    } else {
                        // Add mode: call the add-word-to-Canvas method
                        success = await this.plugin.vocabularyManager.addWordToCanvas(
                            selectedBook,
                            finalWord,
                            definition,
                            colorValue,
                            aliases
                        );

                        // Dismiss the loading notice
                        loadingNotice.hide();

                        if (success) {
                            // Cache the word book chosen by the user
                            AddWordModal.lastSelectedBookPath = selectedBook;
                            // Cache the color chosen by the user (empty means default gray)
                            AddWordModal.lastSelectedColorValue = colorSelect.value || '';
                            // Use format-string replacement
                            const successMessage = t('notices.word_added_success').replace('{0}', finalWord);
                            new Notice(successMessage);
                            // Refresh highlighters
                            this.plugin.refreshHighlighter();
                            this.close();
                        } else {
                            new Notice(t('notices.add_word_failed'));
                        }
                    }
                } catch (error) {
                    loadingNotice.hide();
                    console.error('Failed to add/update word:', error);
                    new Notice(t('notices.error_processing_word'));
                }
            })();
        };
    }

    /**
     * Build the prefilled description from the user's template setting.
     * Supported placeholders: {word}, {sentence}
     */
    private buildDescriptionTemplate(): string {
        const template = this.plugin.settings.addWordDescriptionTemplate ?? '';
        if (!template.trim()) return '';

        return template
            .replace(/\{word\}/gi, this.word)
            .replace(/\{sentence\}/gi, this.sentence);
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
