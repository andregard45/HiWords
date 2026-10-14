import { App, PluginSettingTab, Setting, TFile, Notice, FuzzySuggestModal, Modal, setIcon } from 'obsidian';
import HiWordsPlugin from '../../main';
import { VocabularyBook, HighlightStyle, mapCanvasColorToCSSVar, getColorWithOpacity } from '../utils';
import { CanvasParser } from '../canvas';
import { HiWordsParser } from '../card';
import { t } from '../i18n';
import { renderWordCard } from './word-card-renderer';

export class HiWordsSettingTab extends PluginSettingTab {
    plugin: HiWordsPlugin;

    constructor(app: App, plugin: HiWordsPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    private runAsync(action: () => Promise<void>, context: string): void {
        void action().catch(error => {
            console.error(context, error);
        });
    }

    /**
     * Add highlight-scope settings (as a subsection of highlight settings)
     */
    private addHighlightScopeSettings() {
        const { containerEl } = this;

        // Highlight mode selection
        new Setting(containerEl)
            .setName(t('settings.highlight_mode'))
            .setDesc(t('settings.highlight_mode_desc'))
            .addDropdown(dropdown => dropdown
                .addOption('all', t('settings.mode_all'))
                .addOption('exclude', t('settings.mode_exclude'))
                .addOption('include', t('settings.mode_include'))
                .setValue(this.plugin.settings.highlightMode || 'all')
                .onChange((value) => {
                    this.runAsync(async () => {
                        this.plugin.settings.highlightMode = value as 'all' | 'exclude' | 'include';
                        await this.plugin.saveSettings();
                        this.plugin.refreshHighlighter();
                    }, 'HiWords failed to save highlight mode:');
                }));

        // File path input (stacked layout)
        const pathsSetting = new Setting(containerEl)
            .setName(t('settings.highlight_paths'))
            .setDesc(t('settings.highlight_paths_desc'));

        pathsSetting.settingEl.addClass('hi-words-setting-textarea');
        pathsSetting.controlEl.empty();

        // Create a full-width textarea inside the current setting
        const textAreaContainer = pathsSetting.controlEl.createDiv({ cls: 'hi-words-textarea-container' });
        const textArea = textAreaContainer.createEl('textarea');
        textArea.placeholder = t('settings.highlight_paths_placeholder') || 'e.g.: Archive, Templates, Private/Diary';
        textArea.value = this.plugin.settings.highlightPaths || '';
        textArea.rows = 3;

        // Use the change event instead of input to avoid frequent saves
        textArea.addEventListener('blur', () => {
            void (async () => {
                this.plugin.settings.highlightPaths = textArea.value;
                await this.plugin.saveSettings();
                this.plugin.refreshHighlighter();
            })().catch(error => {
                console.error('HiWords failed to save highlight paths:', error);
            });
        });
    }

    /**
     * Add the file-node parsing mode setting
     */
    private addFileNodeParseModeSettings() {
        const { containerEl } = this;

        new Setting(containerEl)
            .setName(t('settings.file_node_parse_mode'))
            .setDesc(t('settings.file_node_parse_mode_desc'))
            .addDropdown(dropdown => dropdown
                .addOption('filename-with-alias', t('settings.mode_filename_with_alias'))
                .addOption('filename', t('settings.mode_filename'))
                .addOption('content', t('settings.mode_content'))
                .setValue(this.plugin.settings.fileNodeParseMode || 'filename-with-alias')
                .onChange((value) => {
                    this.runAsync(async () => {
                        this.plugin.settings.fileNodeParseMode = value as 'filename' | 'content' | 'filename-with-alias';
                        await this.plugin.saveSettings();
                        // Prompt the user to reload the plugin to apply the new parsing mode
                        new Notice('Reload the plugin to apply the new file node parsing mode');
                    }, 'HiWords failed to save file node parsing mode:');
                }));
    }

    /**
     * Add auto-layout settings
     */
    private addAutoLayoutSettings() {
        const { containerEl } = this;

        new Setting(containerEl)
            .setName(t('settings.auto_layout'))
            .setHeading();

        // Enable auto-layout
        new Setting(containerEl)
            .setName(t('settings.enable_auto_layout'))
            .setDesc(t('settings.enable_auto_layout_desc'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoLayoutEnabled ?? true)
                .onChange((value) => {
                    this.runAsync(async () => {
                        this.plugin.settings.autoLayoutEnabled = value;
                        await this.plugin.saveSettings();
                    }, 'HiWords failed to save auto layout setting:');
                }));

        // Card size settings (width and height on the same row)
        new Setting(containerEl)
            .setName(t('settings.card_size') || 'Card size')
            .setDesc(t('settings.card_size_desc') || 'Default width and height for canvas cards')
            .addText(text => text
                .setPlaceholder('260')
                .setValue(String(this.plugin.settings.cardWidth ?? 260))
                .onChange((value) => {
                    this.runAsync(async () => {
                        const width = parseInt(value);
                        if (!isNaN(width) && width > 0) {
                            this.plugin.settings.cardWidth = width;
                            await this.plugin.saveSettings();
                        }
                    }, 'HiWords failed to save card width:');
                }))
            .addText(text => text
                .setPlaceholder('120')
                .setValue(String(this.plugin.settings.cardHeight ?? 120))
                .onChange((value) => {
                    this.runAsync(async () => {
                        const height = parseInt(value);
                        if (!isNaN(height) && height > 0) {
                            this.plugin.settings.cardHeight = height;
                            await this.plugin.saveSettings();
                        }
                    }, 'HiWords failed to save card height:');
                }));
    }

    /**
     * Add the customizable description-template setting for the "HiWords: Add word" command
     */
    private addAddWordTemplateSettings() {
        const { containerEl } = this;

        const templateSetting = new Setting(containerEl)
            .setName(t('settings.add_word_template') || 'Description template')
            .setDesc(t('settings.add_word_template_desc') || 'Template prefilled into the Description field when running "HiWords: Add word". Placeholders: {word}, {sentence}');

        templateSetting.settingEl.addClass('hi-words-setting-textarea');
        templateSetting.controlEl.empty();

        // Create a full-width textarea inside the current setting (same pattern as highlight paths)
        const textAreaContainer = templateSetting.controlEl.createDiv({ cls: 'hi-words-textarea-container' });
        const textArea = textAreaContainer.createEl('textarea');
        textArea.placeholder = t('settings.add_word_template_placeholder') || 'e.g.: **{word}**\n\nMeaning:\n\nExample: {sentence}';
        textArea.value = this.plugin.settings.addWordDescriptionTemplate || '';
        textArea.rows = 4;

        // Save on blur to avoid frequent writes
        textArea.addEventListener('blur', () => {
            void (async () => {
                this.plugin.settings.addWordDescriptionTemplate = textArea.value;
                await this.plugin.saveSettings();
            })().catch(error => {
                console.error('HiWords failed to save add-word description template:', error);
            });
        });
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        // 1. Word book management
        this.addVocabularyBooksSection();
        this.addFileNodeParseModeSettings();

        // 2. Highlight settings
        this.addHighlightingSection();

        // 3. Learning features
        this.addLearningFeaturesSection();

        // 4. Canvas settings
        this.addAutoLayoutSettings();

        // 5. Add-word description template
        this.addAddWordTemplateSettings();
    }

    /**
     * 2. Add highlight settings
     */
    private addHighlightingSection() {
        const { containerEl } = this;

        new Setting(containerEl)
            .setName(t('settings.enable_auto_highlight') || 'Highlighting')
            .setHeading();

        // Enable auto-highlight
        new Setting(containerEl)
            .setName(t('settings.enable_auto_highlight'))
            .setDesc(t('settings.enable_auto_highlight_desc'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableAutoHighlight)
                .onChange((value) => {
                    this.runAsync(async () => {
                        this.plugin.settings.enableAutoHighlight = value;
                        await this.plugin.saveSettings();
                        // Refresh highlighters and apply settings immediately
                        this.plugin.refreshHighlighter();
                    }, 'HiWords failed to save auto highlight setting:');
                }));

        // Floating definition display
        new Setting(containerEl)
            .setName(t('settings.show_definition_on_hover'))
            .setDesc(t('settings.show_definition_on_hover_desc'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showDefinitionOnHover)
                .onChange((value) => {
                    this.runAsync(async () => {
                        this.plugin.settings.showDefinitionOnHover = value;
                        await this.plugin.saveSettings();
                    }, 'HiWords failed to save hover preview setting:');
                }));

        new Setting(containerEl)
            .setName(t('settings.enable_section_tabs'))
            .setDesc(t('settings.enable_section_tabs_desc'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableSectionTabs ?? true)
                .onChange((value) => {
                    this.runAsync(async () => {
                        this.plugin.settings.enableSectionTabs = value;
                        await this.plugin.saveSettings();
                        this.plugin.app.workspace.trigger('hi-words:settings-changed');
                    }, 'HiWords failed to save section tab setting:');
                }));

        new Setting(containerEl)
            .setName(t('settings.sidebar_default_display_mode') || 'Sidebar default display')
            .setDesc(t('settings.sidebar_default_display_mode_desc') || 'Choose whether sidebar cards open with full details or only the word title')
            .addDropdown(dropdown => dropdown
                .addOption('detail', t('settings.sidebar_display_detail') || 'Show full details')
                .addOption('word', t('settings.sidebar_display_word') || 'Show words only')
                .setValue(this.plugin.settings.sidebarDefaultDisplayMode || 'detail')
                .onChange((value) => {
                    this.runAsync(async () => {
                        this.plugin.settings.sidebarDefaultDisplayMode = value as 'detail' | 'word';
                        await this.plugin.saveSettings();
                        this.plugin.app.workspace.trigger('hi-words:settings-changed');
                    }, 'HiWords failed to save sidebar default display setting:');
                }));

        // Highlight style selection
        new Setting(containerEl)
            .setName(t('settings.highlight_style'))
            .setDesc(t('settings.highlight_style_desc'))
            .addDropdown(dropdown => dropdown
                .addOption('underline', t('settings.style_underline'))
                .addOption('background', t('settings.style_background'))
                .addOption('bold', t('settings.style_bold'))
                .addOption('dotted', t('settings.style_dotted'))
                .addOption('wavy', t('settings.style_wavy'))
                .setValue(this.plugin.settings.highlightStyle)
                .onChange((value) => {
                    this.runAsync(async () => {
                        this.plugin.settings.highlightStyle = value as HighlightStyle;
                        await this.plugin.saveSettings();
                        this.plugin.refreshHighlighter();
                    }, 'HiWords failed to save highlight style:');
                }));

        // Highlight scope settings
        this.addHighlightScopeSettings();
    }


    /**
     * 3. Add learning-feature settings
     */
    private addLearningFeaturesSection() {
        const { containerEl } = this;

        new Setting(containerEl)
            .setName(t('settings.enable_mastered_feature') || 'Learning Features')
            .setHeading();

        // Enable the mastered feature
        new Setting(containerEl)
            .setName(t('settings.enable_mastered_feature'))
            .setDesc(t('settings.enable_mastered_feature_desc'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableMasteredFeature)
                .onChange((value) => {
                    this.runAsync(async () => {
                        this.plugin.settings.enableMasteredFeature = value;
                        // When the mastered feature is enabled, sidebar grouping turns on automatically
                        this.plugin.settings.showMasteredInSidebar = value;
                        await this.plugin.saveSettings();
                        this.plugin.refreshHighlighter();
                        // Trigger a sidebar update
                        this.plugin.app.workspace.trigger('hi-words:mastered-changed');
                        this.display();
                    }, 'HiWords failed to save mastered feature setting:');
                }));

        // Blur definition content
        new Setting(containerEl)
            .setName(t('settings.blur_definitions'))
            .setDesc(t('settings.blur_definitions_desc'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.blurDefinitions)
                .onChange((value) => {
                    this.runAsync(async () => {
                        this.plugin.settings.blurDefinitions = value;
                        await this.plugin.saveSettings();
                        // Trigger a sidebar update to apply the blur effect
                        this.plugin.app.workspace.trigger('hi-words:settings-changed');
                    }, 'HiWords failed to save blurred definition setting:');
                }));

    }

    /**
     * Add the word-book management section
     */
    private addVocabularyBooksSection() {
        const { containerEl } = this;

        // Add word-book icon buttons
        const addBookContainer = containerEl.createDiv({ cls: 'hi-words-add-book-container' });
        addBookContainer.addEventListener('click', () => {
            void this.showVocabularyBookFilePicker().catch(error => {
                console.error('HiWords failed to open dictionary picker:', error);
            });
        });

        addBookContainer.createSpan({
            text: t('settings.add_vocabulary_book'),
            cls: 'hi-words-add-book-label'
        });

        const addBookIcon = addBookContainer.createDiv({ cls: 'clickable-icon hi-words-add-book-icon' });
        setIcon(addBookIcon, 'plus-circle');
        addBookIcon.setAttribute('aria-label', t('settings.add_vocabulary_book'));

        // Show existing word books
        this.displayVocabularyBooks();

        // Statistics
        this.displayStats();
    }

    /**
     * Show the dictionary file picker
     */
    private async showVocabularyBookFilePicker() {
        const vocabularyFiles = this.app.vault.getFiles()
            .filter(file => file.extension === 'canvas' || file.extension === 'hiwords');

        if (vocabularyFiles.length === 0) {
            new Notice(t('notices.no_vocabulary_book_files'));
            return;
        }

        // Create the selection modal
        const modal = new VocabularyBookPickerModal(this.app, vocabularyFiles, (file) => {
            void this.addVocabularyBook(file).catch(error => {
                console.error('HiWords failed to add dictionary:', error);
            });
        });
        modal.open();
    }

    /**
     * Add a word book
     */
    private async addVocabularyBook(file: TFile) {
        // Check whether it already exists
        const exists = this.plugin.settings.vocabularyBooks.some(book => book.path === file.path);
        if (exists) {
            new Notice(t('notices.book_already_exists'));
            return;
        }

        // Validate the dictionary file
        const hiWordsParser = file.extension === 'hiwords' ? new HiWordsParser(this.app) : null;
        const metadata = hiWordsParser ? await hiWordsParser.readMetadata(file) : null;
        const isValid = hiWordsParser
            ? metadata !== null && await hiWordsParser.validateFile(file)
            : await new CanvasParser(this.app, this.plugin.settings).validateCanvasFile(file);
        if (!isValid) {
            new Notice(t('notices.invalid_vocabulary_book_file'));
            return;
        }

        // Add to settings
        const newBook: VocabularyBook = {
            path: file.path,
            name: file.basename,
            enabled: true,
        };

        this.plugin.settings.vocabularyBooks.push(newBook);
        await this.plugin.saveSettings();
        await this.plugin.vocabularyManager.loadVocabularyBook(newBook);
        this.plugin.refreshHighlighter();

        new Notice(t('notices.book_added').replace('{0}', newBook.name));
        this.display(); // Refresh the settings page
    }

    /**
     * Show existing word books
     */
    private displayVocabularyBooks() {
        const { containerEl } = this;

        if (this.plugin.settings.vocabularyBooks.length === 0) {
            containerEl.createEl('p', {
                text: t('settings.no_vocabulary_books'),
                cls: 'setting-item-description'
            });
            return;
        }

        this.plugin.settings.vocabularyBooks.forEach((book, index) => {
            const setting = new Setting(containerEl)
                .setName(book.name)
                .setDesc(`${t('settings.path')}: ${book.path}`);

            // Create the icon container
            const iconsContainer = setting.controlEl.createDiv({ cls: 'hi-words-book-icons' });

            if (book.path.endsWith('.hiwords')) {
                this.addHiWordsBookColorSelector(iconsContainer, book);

                const previewIcon = iconsContainer.createDiv({ cls: 'clickable-icon' });
                setIcon(previewIcon, 'panel-top-open');
                previewIcon.setAttribute('aria-label', t('settings.preview_book'));
                previewIcon.addEventListener('click', () => {
                    new HiWordsPackPreviewModal(this.app, book).open();
                });
            }

            // Reload icon
            const reloadIcon = iconsContainer.createDiv({ cls: 'clickable-icon' });
            setIcon(reloadIcon, 'refresh-cw');
            reloadIcon.setAttribute('aria-label', t('settings.reload_book'));
            reloadIcon.addEventListener('click', () => {
                void (async () => {
                    await this.plugin.vocabularyManager.reloadVocabularyBook(book.path);
                    this.plugin.refreshHighlighter();
                    new Notice(t('notices.book_reloaded').replace('{0}', book.name));
                })().catch(error => {
                    console.error('HiWords failed to reload dictionaries:', error);
                });
            });

            // Delete icon
            const deleteIcon = iconsContainer.createDiv({ cls: 'clickable-icon mod-warning' });
            setIcon(deleteIcon, 'trash');
            deleteIcon.setAttribute('aria-label', t('settings.remove_vocabulary_book'));
            deleteIcon.addEventListener('click', () => {
                void (async () => {
                    this.plugin.settings.vocabularyBooks.splice(index, 1);
                    await this.plugin.saveSettings();
                    await this.plugin.vocabularyManager.loadAllVocabularyBooks();
                    this.plugin.refreshHighlighter();
                    new Notice(t('notices.book_removed').replace('{0}', book.name));
                    this.display(); // Refresh the settings page
                })().catch(error => {
                    console.error('HiWords failed to delete dictionary:', error);
                });
            });

            // Enable/disable toggle
            setting.addToggle(toggle => toggle
                .setValue(book.enabled)
                .onChange((value) => {
                    this.runAsync(async () => {
                        book.enabled = value;
                        await this.plugin.saveSettings();
                        if (value) {
                            await this.plugin.vocabularyManager.loadVocabularyBook(book);
                        } else {
                            await this.plugin.vocabularyManager.loadAllVocabularyBooks();
                        }
                        this.plugin.refreshHighlighter();
                    }, 'HiWords failed to save dictionary enabled state:');
                }));
        });
    }

    private addHiWordsBookColorSelector(container: HTMLElement, book: VocabularyBook) {
        const options = [
            { value: '', label: t('settings.book_color_default'), css: 'var(--text-muted)' },
            { value: '1', label: t('modals.color_red'), css: 'var(--color-red)' },
            { value: '2', label: t('modals.color_orange'), css: 'var(--color-orange)' },
            { value: '3', label: t('modals.color_yellow'), css: 'var(--color-yellow)' },
            { value: '4', label: t('modals.color_green'), css: 'var(--color-green)' },
            { value: '5', label: t('modals.color_blue'), css: 'var(--color-cyan)' },
            { value: '6', label: t('modals.color_purple'), css: 'var(--color-purple)' },
        ];

        const colorControl = container.createDiv({ cls: 'hi-words-book-color-control clickable-icon' });
        colorControl.setAttribute('aria-label', t('settings.book_color'));
        colorControl.setAttribute('role', 'button');
        colorControl.setAttribute('tabindex', '0');
        const swatch = colorControl.createSpan({ cls: 'hi-words-book-color-swatch' });

        const updateSwatch = () => {
            const selected = options.find(option => option.value === (book.color || '')) || options[0];
            swatch.style.setProperty('--hi-words-book-color', selected.css);
            colorControl.setAttribute('aria-label', `${t('settings.book_color')}: ${selected.label}`);
        };

        const applyColor = async (value: string) => {
            book.color = value || undefined;
            updateSwatch();
            await this.plugin.saveSettings();
            if (book.enabled) {
                await this.plugin.vocabularyManager.loadVocabularyBook(book);
            }
            this.plugin.refreshHighlighter();
        };

        const openPalette = (event: MouseEvent | KeyboardEvent) => {
            activeDocument.querySelectorAll('.hi-words-book-color-palette').forEach(el => el.remove());

            const palette = activeDocument.body.createDiv({ cls: 'hi-words-book-color-palette' });

            const closePalette = () => {
                palette.remove();
                activeDocument.removeEventListener('click', handleOutsideClick, true);
                activeDocument.removeEventListener('keydown', handleEscape, true);
            };
            const handleOutsideClick = (outsideEvent: MouseEvent) => {
                const target = outsideEvent.target as Node | null;
                if (target && (palette.contains(target) || colorControl.contains(target))) {
                    return;
                }
                closePalette();
            };
            const handleEscape = (keyboardEvent: KeyboardEvent) => {
                if (keyboardEvent.key === 'Escape') {
                    closePalette();
                }
            };

            for (const option of options) {
                const item = palette.createEl('button', {
                    cls: 'hi-words-book-color-palette-item',
                    attr: {
                        type: 'button',
                        'aria-label': option.label,
                        title: option.label,
                    },
                });
                item.style.setProperty('--hi-words-book-color', option.css);
                item.style.setProperty('background-color', option.css, 'important');
                if ((book.color || '') === option.value) {
                    item.addClass('is-selected');
                    setIcon(item, 'check');
                }
                item.addEventListener('click', () => {
                    void applyColor(option.value);
                    closePalette();
                });
            }

            const rect = colorControl.getBoundingClientRect();
            palette.style.left = `${Math.min(rect.left, window.innerWidth - 260)}px`;
            palette.style.top = `${rect.bottom + 6}px`;

            activeDocument.addEventListener('click', handleOutsideClick, true);
            activeDocument.addEventListener('keydown', handleEscape, true);
        };

        colorControl.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            openPalette(event);
        });
        colorControl.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openPalette(event);
            }
        });

        updateSwatch();
    }

    /**
     * Show statistics
     */
    private displayStats() {
        const { containerEl } = this;
        const stats = this.plugin.vocabularyManager.getStats();

        const statsEl = containerEl.createEl('div', { cls: 'hi-words-stats' });

        // Total number of word books
        const totalBooksItem = statsEl.createEl('div', { cls: 'stat-item' });
        totalBooksItem.createEl('div', { cls: 'stat-value', text: stats.totalBooks.toString() });
        totalBooksItem.createEl('div', { cls: 'stat-label', text: t('settings.total_books').split(':')[0] });

        // Enabled word books
        const enabledBooksItem = statsEl.createEl('div', { cls: 'stat-item' });
        enabledBooksItem.createEl('div', { cls: 'stat-value', text: stats.enabledBooks.toString() });
        enabledBooksItem.createEl('div', { cls: 'stat-label', text: t('settings.enabled_books').split(':')[0] });

        // Total number of words
        const totalWordsItem = statsEl.createEl('div', { cls: 'stat-item' });
        totalWordsItem.createEl('div', { cls: 'stat-value', text: stats.totalWords.toString() });
        totalWordsItem.createEl('div', { cls: 'stat-label', text: t('settings.total_words').split(':')[0] });
    }
}

class HiWordsPackPreviewModal extends Modal {
    private book: VocabularyBook;

    constructor(app: App, book: VocabularyBook) {
        super(app);
        this.book = book;
    }

    onOpen() {
        this.contentEl.empty();
        this.modalEl.addClass('hi-words-pack-preview-modal-container');
        this.contentEl.addClass('hi-words-pack-preview-modal');
        void this.render();
    }

    private async render() {
        const file = this.app.vault.getAbstractFileByPath(this.book.path);
        if (!(file instanceof TFile)) {
            this.contentEl.createEl('p', { text: t('notices.invalid_vocabulary_book_file') });
            return;
        }

        const parser = new HiWordsParser(this.app);
        const metadata = await parser.readMetadata(file);
        const definitions = await parser.parseFile(file);
        if (this.book.color) {
            for (const definition of definitions) {
                if (!definition.color) {
                    definition.color = this.book.color;
                }
            }
        }

        this.titleEl.setText(metadata?.title || this.book.name);

        const summary = this.contentEl.createDiv({ cls: 'hi-words-pack-preview-summary' });

        const metaGrid = summary.createDiv({ cls: 'hi-words-pack-preview-meta-grid' });
        this.addMetaItem(metaGrid, t('modals.pack_words'), String(metadata?.cardCount ?? definitions.length));
        this.addMetaItem(metaGrid, t('modals.pack_language'), metadata?.language || '-');
        this.addMetaItem(metaGrid, t('modals.pack_version'), String(metadata?.version ?? 1));

        const sampleTitle = this.contentEl.createDiv({
            cls: 'hi-words-pack-preview-section-title',
            text: t('modals.pack_samples'),
        });
        sampleTitle.toggleClass('is-empty', definitions.length === 0);

        const sampleList = this.contentEl.createDiv({ cls: 'hi-words-pack-preview-samples' });
        for (const definition of definitions.slice(0, 3)) {
            const sample = sampleList.createDiv({ cls: 'hi-words-pack-preview-sample' });
            if (definition.color) {
                const accentColor = mapCanvasColorToCSSVar(definition.color, 'var(--color-base-60)');
                sample.style.setProperty('--word-card-accent-color', accentColor);
                sample.style.setProperty('--word-card-bg-color', getColorWithOpacity(accentColor, 0.08));
            }
            sample.createDiv({ cls: 'hi-words-pack-preview-word', text: definition.word });
            const body = sample.createDiv({ cls: 'hi-words-pack-preview-card-body' });
            renderWordCard(body, definition, {
                mode: 'sidebar',
                app: this.app,
            });
        }

        if (definitions.length === 0) {
            sampleList.createDiv({ cls: 'setting-item-description', text: t('sidebar.empty_state') });
        }
    }

    private addMetaItem(container: HTMLElement, label: string, value: string) {
        const item = container.createDiv({ cls: 'hi-words-pack-preview-meta-item' });
        item.createDiv({ cls: 'hi-words-pack-preview-meta-label', text: label });
        item.createDiv({ cls: 'hi-words-pack-preview-meta-value', text: value });
    }
}

// Dictionary file picker modal (FuzzySuggestModal with fuzzy search)
class VocabularyBookPickerModal extends FuzzySuggestModal<TFile> {
    private files: TFile[];
    private onSelect: (file: TFile) => void;

    constructor(app: App, files: TFile[], onSelect: (file: TFile) => void) {
        super(app);
        this.files = files;
        this.onSelect = onSelect;
        this.setPlaceholder(t('modals.select_vocabulary_book_file'));
    }

    // Return all selectable items
    getItems(): TFile[] {
        return this.files;
    }

    // Return each item's display text (used for search matching)
    getItemText(file: TFile): string {
        return file.path;
    }

    // Called when the user selects an item
    onChooseItem(file: TFile, evt: MouseEvent | KeyboardEvent) {
        this.onSelect(file);
    }
}
