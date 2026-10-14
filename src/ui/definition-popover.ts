import { App, MarkdownRenderer, MarkdownView, Notice, setIcon, TFile, Component } from 'obsidian';
import { VocabularyManager, MasteredService } from '../core';
import { playWordTTS, WordDefinition } from '../utils';
import { t } from '../i18n';
import HiWordsPlugin from '../../main';
import { renderWordCard } from './word-card-renderer';
import { WordNoteModal } from './word-note-modal';

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

export class DefinitionPopover extends Component {
    private app: App;
    private plugin: HiWordsPlugin;
    private activeTooltip: HTMLElement | null = null;
    private vocabularyManager: VocabularyManager | null = null;
    private masteredService: MasteredService | null = null;
    private eventHandlers: {[key: string]: (event: Event) => void} = {};
    private tooltipHideTimeout: number | undefined;
    private currentTargetEl: HTMLElement | null = null; // The highlighted element currently showing a tooltip; avoids recreating it
    private hoverIntentTimer: number | null = null; // Hover-intent timer; avoids frequent flicker
    private lastShowTs = 0; // Last-show timestamp, used to enforce a minimum interval
    private currentTooltipComponent: Component | null = null; // The Component used by the current tooltip
    private static readonly SHOW_DELAY_MS = 120; // Delay from hover to show
    private static readonly MIN_INTERVAL_MS = 150; // Minimum interval between two shows

    constructor(plugin: HiWordsPlugin) {
        super();
        this.app = plugin.app;
        this.plugin = plugin;

        this.eventHandlers = {
            mouseover: (event: Event) => this.handleMouseOver(event as MouseEvent),
            mouseout: (event: Event) => this.handleMouseOut(event as MouseEvent),
            scroll: (() => this.removeTooltip()).bind(this),
            resize: (() => this.removeTooltip()).bind(this),
        };

        this.registerEvents();
    }

    /**
     * Bind interactions for internal links and tags:
     * - internal-link: hover triggers the native preview, click opens the link
     * - tag: click opens/reuses the search view
     */
    private bindInternalLinksAndTags(root: HTMLElement, sourcePath: string, hoverParent: HTMLElement) {
        // Internal link
        root.querySelectorAll('a.internal-link').forEach((a) => {
            const linkEl = a as HTMLAnchorElement;
            const linktext = (linkEl.getAttribute('href') || linkEl.dataset.href || '').trim();
            if (!linktext) return;

            linkEl.addEventListener('mouseover', (evt) => {
                // Trigger the native hover preview
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
                // Close the tooltip (if present)
                this.removeTooltip();
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
                this.removeTooltip();
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

    setVocabularyManager(manager: VocabularyManager) {
        this.vocabularyManager = manager;
    }

    setMasteredService(service: MasteredService) {
        this.masteredService = service;
    }

    private registerEvents() {
        // Use registerDomEvent so listeners are cleaned up automatically on unload
        this.registerDomEvent(activeDocument, 'mouseover', this.eventHandlers.mouseover);
        this.registerDomEvent(activeDocument, 'mouseout', this.eventHandlers.mouseout);
        // Close the tooltip directly on scroll or resize to avoid constant repositioning
        this.registerDomEvent(window, 'scroll', this.eventHandlers.scroll as EventListener, { passive: true });
        this.registerDomEvent(window, 'resize', this.eventHandlers.resize as EventListener);
    }

    /**
     * Optimized mouseleave: stays visible while the pointer is on a highlighted word or the tooltip
     */
    private handleMouseOut(event: MouseEvent) {
        window.clearTimeout(this.tooltipHideTimeout);
        if (this.hoverIntentTimer !== null) {
            window.clearTimeout(this.hoverIntentTimer);
            this.hoverIntentTimer = null;
        }
        const from = event.target as HTMLElement;
        const to = event.relatedTarget as HTMLElement | null;

        // 1. Pointer enters the tooltip: do not remove
        if (
            to &&
            this.activeTooltip &&
            (to === this.activeTooltip || this.activeTooltip.contains(to))
        ) {
            return;
        }
        // 2. Pointer moves between highlighted words: do not remove
        if (
            from &&
            to &&
            from.classList.contains('hi-words-highlight') &&
            to.classList.contains('hi-words-highlight')
        ) {
            return;
        }
        // 3. Pointer moves from tooltip to a highlighted word: do not remove
        if (
            from &&
            this.activeTooltip &&
            this.activeTooltip.contains(from) &&
            to &&
            to.classList.contains('hi-words-highlight')
        ) {
            return;
        }

        // Otherwise close the tooltip after a short delay to prevent flicker on fast movement
        this.tooltipHideTimeout = window.setTimeout(() => {
            this.removeTooltip();
        }, 80);
    }

    private async renderSectionContent(contentEl: HTMLElement, content: string, tooltip: HTMLElement): Promise<void> {
        contentEl.empty();

        if (!content || content.trim() === '') {
            contentEl.textContent = t('sidebar.no_definition');
            return;
        }

        try {
            const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
            const sourcePath = (activeView && activeView.file?.path) || this.app.workspace.getActiveFile()?.path || '';

            if (this.currentTooltipComponent) {
                this.removeChild(this.currentTooltipComponent);
                this.currentTooltipComponent = null;
            }

            const tempComponent = new Component();
            this.addChild(tempComponent);
            this.currentTooltipComponent = tempComponent;

            await MarkdownRenderer.render(
                this.app,
                content,
                contentEl,
                sourcePath,
                tempComponent
            );

            window.requestAnimationFrame(() => this.bindInternalLinksAndTags(contentEl, sourcePath, tooltip));
        } catch (error) {
            console.error('Markdown rendering failed:', error);
            contentEl.textContent = content;
        }
    }

    private handleMouseOver(event: MouseEvent) {
        // Check whether the hover-preview feature is enabled
        if (!this.plugin.settings.showDefinitionOnHover) {
            return;
        }

        const raw = event.target instanceof Node && event.target.nodeType === Node.ELEMENT_NODE
            ? event.target as HTMLElement
            : null;
        const target = raw?.closest<HTMLElement>('.hi-words-highlight') ?? null;

        if (target) {
            // Ignore if a tooltip is already shown for the same target
            if (this.currentTargetEl === target && this.activeTooltip) return;
            // Cancel the previous hoverIntent first
            if (this.hoverIntentTimer !== null) {
                window.clearTimeout(this.hoverIntentTimer);
                this.hoverIntentTimer = null;
            }
            this.currentTargetEl = target;
            const word = target.getAttribute('data-word');
            const definition = target.getAttribute('data-definition');
            if (!word || !definition) return;

            // Hover intent: delayed show to avoid creating tooltips when sweeping quickly
            this.hoverIntentTimer = window.setTimeout(() => {
                this.hoverIntentTimer = null;
                const now = Date.now();
                if (now - this.lastShowTs < DefinitionPopover.MIN_INTERVAL_MS) {
                    return; // Rate limit: too soon since the last show
                }
                this.lastShowTs = now;
                // Use void to handle the async function
                void this.createTooltip(target, word, definition);
            }, DefinitionPopover.SHOW_DELAY_MS);
        }
    }

    private async createTooltip(target: HTMLElement, word: string, definition: string) {
        this.removeTooltip();

        const tooltip = activeDocument.createElement('div');
        tooltip.className = 'hi-words-tooltip';
        const wordDef = this.vocabularyManager?.getDefinition(word);
        if (wordDef?.card) {
            tooltip.classList.add('hi-words-tooltip-structured');
        }

        // Title container
        const titleContainer = activeDocument.createElement('div');
        titleContainer.className = 'hi-words-tooltip-title-container';

        // Title text
        const titleEl = activeDocument.createElement('div');
        titleEl.className = 'hi-words-tooltip-title';
        titleEl.textContent = word;
        titleContainer.appendChild(titleEl);
        // Click the title to pronounce
        titleEl.title = 'Click to pronounce';
        titleEl.addEventListener('click', (e) => {
            e.stopPropagation();
            void playWordTTS(this.plugin, word, wordDef || undefined).catch(error => {
                console.error('HiWords failed to play pronunciation:', error);
            });
        });

        // Add the title container first
        tooltip.appendChild(titleContainer);

        const sections = wordDef?.card ? undefined : wordDef?.sections;
        const enableSectionTabs = this.plugin.settings.enableSectionTabs ?? true;

        if (sections && sections.length > 1 && enableSectionTabs) {
            const tabsContainer = activeDocument.createElement('div');
            tabsContainer.className = 'hi-words-tooltip-tabs';

            sections.forEach((section, index) => {
                const tab = activeDocument.createElement('div');
                tab.className = 'hi-words-tooltip-tab';
                if (index === 0) {
                    tab.classList.add('active');
                }
                tab.textContent = section.title;
                tab.addEventListener('click', () => {
                    tabsContainer.querySelectorAll('.hi-words-tooltip-tab').forEach(t => t.classList.remove('active'));
                    tab.classList.add('active');
                    void this.renderSectionContent(contentEl, sections[index].content, tooltip);
                });
                tabsContainer.appendChild(tab);
            });

            tooltip.appendChild(tabsContainer);
        }

        // Content
        const contentEl = activeDocument.createElement('div');
        contentEl.className = 'hi-words-tooltip-content';

        // If blur is enabled, add the blurred style to the content
        if (this.plugin.settings.blurDefinitions) {
            contentEl.classList.add('hi-words-definition', 'blur-enabled');
        } else {
            contentEl.classList.add('hi-words-definition');
        }

        // Attach contentEl to the tooltip before rendering Markdown
        // so postprocessors can detect .hi-words-tooltip via closest()
        tooltip.appendChild(contentEl);

        if (wordDef?.card) {
            renderWordCard(contentEl, wordDef, {
                mode: 'popover',
                app: this.app,
                pronunciationVariant: this.plugin.settings.pronunciationVariant || 'us',
                onPronunciationClick: (variant) => playWordTTS(this.plugin, wordDef.word, wordDef, variant),
                display: this.plugin.getVocabularyBookDisplaySettings(wordDef.source),
                onNoteClick: wordDef.source.endsWith('.hiwords') || wordDef.userNoteSource
                    ? () => {
                        this.removeTooltip();
                        new WordNoteModal(this.plugin, wordDef, async () => {
                            await this.plugin.vocabularyManager.loadAllVocabularyBooks();
                            this.plugin.refreshHighlighter();
                        }).open();
                    }
                    : undefined,
                noteActionLabel: wordDef.userNote ? t('sidebar.edit_note') : t('sidebar.add_note'),
                onOpenDetail: () => {
                    this.removeTooltip();
                    void this.plugin.showWordInSidebar(wordDef, 'document').catch(error => {
                        console.error('HiWords failed to open word card details:', error);
                    });
                },
            });
        } else {
            const contentToRender = sections && sections.length > 0 && enableSectionTabs
                ? sections[0].content
                : definition;

            if (!contentToRender || contentToRender.trim() === '') {
                contentEl.textContent = t('sidebar.no_definition');
            } else {
                await this.renderSectionContent(contentEl, contentToRender, tooltip);
            }
        }

        // Add the mastered button and source info
        if (this.vocabularyManager) {
            const detailDef = this.vocabularyManager.getDefinition(word);
            if (detailDef && detailDef.source) {
                // Mastered button (added into the title container)
                if (this.masteredService && this.masteredService.isEnabled) {
                    const buttonContainer = activeDocument.createElement('div');
                    buttonContainer.className = 'hi-words-tooltip-title-mastered-button';
                    // Remove aria-label to avoid overlapping with the popover

                    // Set the icon (unmastered shows smile to mark as mastered; mastered shows frown to undo)
                    setIcon(buttonContainer, detailDef.mastered ? 'frown' : 'smile');

                    // Add the click handler
                    buttonContainer.addEventListener('click', (e) => {
                        e.stopPropagation();

                        void (async () => {
                            try {
                                // Toggle the mastered state
                                const masteredService = this.masteredService;
                                if (!masteredService) return;

                                if (detailDef.mastered) {
                                    await masteredService.unmarkWordAsMastered(detailDef.source, detailDef.nodeId, detailDef.word);
                                } else {
                                    await masteredService.markWordAsMastered(detailDef.source, detailDef.nodeId, detailDef.word);
                                }

                                // Clean up the preview popover after clicking the mastered button
                                this.removeTooltip();
                            } catch (error) {
                                console.error('Failed to toggle mastered state:', error);
                            }
                        })();
                    });

                    // Add to the title container
                    titleContainer.appendChild(buttonContainer);
                }

                if (!detailDef.source.endsWith('.hiwords')) {
                    // Source info
                    const sourceEl = activeDocument.createElement('div');
                    sourceEl.className = 'hi-words-tooltip-source';
                    const fileName = detailDef.source.split('/').pop() || '';
                    const displayName = fileName.endsWith('.canvas') ? fileName.slice(0, -7) : fileName;
                    sourceEl.textContent = `${t('sidebar.source_prefix')}${displayName}`;

                    // Add a click handler on the source info: navigate to the source file
                    sourceEl.addEventListener('click', (e) => {
                        e.stopPropagation(); // Stop event propagation
                        void this.navigateToSource(detailDef).catch(error => {
                            console.error('HiWords failed to navigate to source:', error);
                        });
                        // Clean up the preview popover after navigating
                        this.removeTooltip();
                    });

                    tooltip.appendChild(sourceEl);
                }
            }
        }

        activeDocument.body.appendChild(tooltip);

        // Use rAF to batch positioning and overflow fixes, reducing layout thrash
        window.requestAnimationFrame(() => {
            // Read: target position and viewport
            const rect = target.getBoundingClientRect();
            const scrollTop = window.scrollY || activeDocument.documentElement.scrollTop;
            const scrollLeft = window.scrollX || activeDocument.documentElement.scrollLeft;
            const viewportWidth = window.innerWidth;

            // Write: initial positioning
            const left = rect.left + scrollLeft;
            const top = rect.bottom + scrollTop + 5;
            tooltip.style.left = left + 'px';
            tooltip.style.top = top + 'px';

            // Read: tooltip's own size
            const tooltipRect = tooltip.getBoundingClientRect();

            // Write: fix right-side overflow
            if (tooltipRect.right > viewportWidth - 10) {
                const overflow = tooltipRect.right - viewportWidth + 10;
                tooltip.style.left = (left - overflow) + 'px';
            }
        });

        // Only truly closes on mouseleave (no more flickering)
        tooltip.addEventListener('mouseleave', (e) => {
            this.removeTooltip();
        });

        this.activeTooltip = tooltip;
    }

    private removeTooltip() {
        window.clearTimeout(this.tooltipHideTimeout);
        if (this.activeTooltip && this.activeTooltip.parentNode) {
            this.activeTooltip.parentNode.removeChild(this.activeTooltip);
            this.activeTooltip = null;
        }
        // Clean up the Component associated with the tooltip
        if (this.currentTooltipComponent) {
            this.removeChild(this.currentTooltipComponent);
            this.currentTooltipComponent = null;
        }
        this.currentTargetEl = null;
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

    onunload() {
        // Events registered via registerDomEvent are cleaned up automatically; only the tooltip needs cleanup here
        this.removeTooltip();
    }
}
