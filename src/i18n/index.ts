import { App, getLanguage } from 'obsidian';
import en from './en';
import zh from './zh';
import es from './es';
import fr from './fr';
import de from './de';
import ja from './ja';

// Supported languages
export type SupportedLocale = 'en' | 'zh' | 'es' | 'fr' | 'de' | 'ja';

// Language pack interface
export interface LanguagePack {
    plugin_name: string;
    settings: {
        vocabulary_books: string;
        add_vocabulary_book: string;
        remove_vocabulary_book: string;
        show_definition_on_hover: string;
        show_definition_on_hover_desc: string;
        enable_auto_highlight: string;
        enable_auto_highlight_desc: string;
        highlight_style: string;
        highlight_style_desc: string;
        enable_section_tabs?: string;
        enable_section_tabs_desc?: string;
        sidebar_default_display_mode?: string;
        sidebar_default_display_mode_desc?: string;
        sidebar_display_detail?: string;
        sidebar_display_word?: string;
        style_underline: string;
        style_background: string;
        style_bold: string;
        style_dotted: string;
        style_wavy: string;
        save_settings: string;
        no_vocabulary_books: string;
        path: string;
        reload_book: string;
        preview_book?: string;
        book_color?: string;
        book_color_default?: string;
        statistics: string;
        total_books: string;
        enabled_books: string;
        total_words: string;
        enable_mastered_feature: string;
        enable_mastered_feature_desc: string;
        blur_definitions: string;
        blur_definitions_desc: string;
        // Auto layout section
        auto_layout: string;
        enable_auto_layout: string;
        enable_auto_layout_desc: string;
        card_size: string;
        card_size_desc: string;
        grid_gaps: string;
        grid_gaps_desc: string;
        left_padding: string;
        left_padding_desc: string;
        columns_auto: string;
        columns_auto_desc: string;
        columns: string;
        columns_desc: string;
        group_inner_layout: string;
        group_inner_layout_desc: string;
        // Highlight scope settings
        highlight_scope?: string;
        highlight_mode?: string;
        highlight_mode_desc?: string;
        mode_all?: string;
        mode_exclude?: string;
        mode_include?: string;
        highlight_paths?: string;
        highlight_paths_desc?: string;
        highlight_paths_placeholder?: string;
        // File node parse mode
        file_node_parse_mode?: string;
        file_node_parse_mode_desc?: string;
        mode_filename?: string;
        mode_content?: string;
        mode_filename_with_alias?: string;
        // Add-word description template settings
        add_word_template?: string;
        add_word_template_desc?: string;
        add_word_template_placeholder?: string;
    };
    sidebar: {
        title: string;
        empty_state: string;
        source_prefix: string;
        found: string;
        words: string;
        my_note?: string;
        add_note?: string;
        edit_note?: string;
        delete_note?: string;
        note_modal_title?: string;
        note_placeholder?: string;
        note_required?: string;
        note_saved?: string;
        note_save_failed?: string;
        note_deleted?: string;
        note_delete_failed?: string;
    };
    commands: {
        add_word: string;
        add_selected_word?: string;
        edit_word?: string;
        refresh_vocabulary: string;
        show_sidebar: string;
        open_library?: string;
        toggle_sidebar_default_display?: string;
    };
    notices: {
        vocabulary_refreshed: string;
        word_added: string;
        word_exists: string;
        error_adding_word: string;
        select_book_required: string;
        readonly_hiwords_book?: string;
        adding_word: string;
        word_added_success: string;
        add_word_failed: string;
        no_canvas_files: string;
        no_vocabulary_book_files?: string;
        book_already_exists: string;
        invalid_canvas_file: string;
        invalid_vocabulary_book_file?: string;
        book_added: string;
        book_reloaded: string;
        book_removed: string;
    };
    modals: {
        word_label: string;
        word_placeholder: string;
        definition_label: string;
        book_label: string;
        select_book: string;
        color_label: string;
        color_gray: string;
        aliases_label: string;
        aliases_placeholder: string;
        definition_placeholder: string;
        add_button: string;
        cancel_button: string;
        select_canvas_file: string;
        select_vocabulary_book_file?: string;
        pack_words?: string;
        pack_language?: string;
        pack_version?: string;
        pack_id?: string;
        pack_samples?: string;
        delete_confirmation: string;
        save_button: string;
    };
    library?: {
        title: string;
        description: string;
        refresh: string;
        books: string;
        book_stat: string;
        cards: string;
        items: string;
        learning: string;
        mastered: string;
        progress: string;
        total_progress: string;
        enabled: string;
        disabled: string;
        select_book: string;
        type: string;
        search_placeholder: string;
        all_statuses: string;
        all_types: string;
        no_results: string;
        load_more: string;
        loaded_all: string;
        mark_mastered: string;
        unmark_mastered: string;
        edit_word: string;
        book_display_settings: string;
        book_display_settings_desc: string;
        preview_density: string;
        preview_density_desc: string;
        preview_simple: string;
        preview_standard: string;
        preview_rich: string;
        display_order: string;
        display_order_desc: string;
        preview_area: string;
        detail_area: string;
        move_up: string;
        move_down: string;
        detail_sections: string;
        detail_sections_desc: string;
        section_definitions: string;
        section_examples: string;
        section_collocations: string;
        section_phrases: string;
        section_usage: string;
        section_forms: string;
        section_morphology: string;
        section_confusables: string;
        section_relations: string;
        section_memory: string;
        section_note: string;
        save_display_settings: string;
        reset_display_settings: string;
    };
    // Common action labels used in UI
    actions?: {
        expand: string;        // expand
        collapse: string;      // collapse
        mark_mastered: string; // mark as mastered
        unmark_mastered: string; // forgot (unmark mastered)
    };
}

// Language pack collection
const languagePacks: Record<SupportedLocale, LanguagePack> = {
    en,
    zh,
    es,
    fr,
    de,
    ja,
};

/**
 * Internationalization manager class
 */
export class I18n {
    private static instance: I18n;
    private app: App | null = null;
    
    /**
     * Get singleton instance
     */
    public static getInstance(): I18n {
        if (!I18n.instance) {
            I18n.instance = new I18n();
        }
        return I18n.instance;
    }
    
    /**
     * Set the Obsidian App instance
     */
    public setApp(app: App): void {
        this.app = app;
    }
    
    /**
     * Get the current language
     */
    private getCurrentLocale(): SupportedLocale {
        // Use the official Obsidian API to get the language setting (requires minAppVersion: "1.8.7")
        const obsidianLocale = getLanguage();
        
        // Map the Obsidian language setting to our supported languages
        if (obsidianLocale.startsWith('zh')) {
            return 'zh';
        }
        if (obsidianLocale.startsWith('es')) {
            return 'es';
        }
        if (obsidianLocale.startsWith('fr')) {
            return 'fr';
        }
        if (obsidianLocale.startsWith('de')) {
            return 'de';
        }
        if (obsidianLocale.startsWith('ja') || obsidianLocale.startsWith('jp')) {
            return 'ja';
        }
        
        // Default to English
        return 'en';
    }
    
    /**
     * Get translated text
     * @param key Translation key, supports dot-separated paths like 'sidebar.title'
     * @returns The translated text
     */
    public t(key: string): string {
        const locale = this.getCurrentLocale();
        const pack = languagePacks[locale];
        const keys = key.split('.');
        let result: unknown = pack;
        
        for (const k of keys) {
            if (typeof result === 'object' && result !== null && k in result) {
                result = (result as Record<string, unknown>)[k];
            } else {
                console.warn(`Translation key ${key} does not exist in the ${locale} language pack`);
                return key;
            }
        }
        
        return typeof result === 'string' ? result : key;
    }
}

// Export the singleton instance
export const i18n = I18n.getInstance();

// Export the translate function for convenience
export const t = (key: string): string => i18n.t(key);
