import type { HiWordsSettings } from './utils';

/**
 * Plugin default settings
 */
export const DEFAULT_SETTINGS: HiWordsSettings = {
    vocabularyBooks: [],
    studyProgress: {},
    masteredMigrationVersion: 0,
    showDefinitionOnHover: true,
    enableAutoHighlight: true,
    highlightStyle: 'underline', // Underline style by default
    enableMasteredFeature: true, // Mastered feature enabled by default
    showMasteredInSidebar: true,  // Follows the value of enableMasteredFeature
    blurDefinitions: false, // Blur effect disabled by default
    // Pronunciation URL template (user-editable in settings)
    ttsTemplate: 'https://dict.youdao.com/dictvoice?audio={{word}}&type=2',
    pronunciationVariant: 'us',
    // Auto layout (simplified, fixed parameters)
    autoLayoutEnabled: true,
    // Card size settings
    cardWidth: 260,
    cardHeight: 120,
    // Highlight scope settings
    highlightMode: 'all',
    highlightPaths: '',
    // File-node parsing mode
    fileNodeParseMode: 'filename-with-alias',
    // Section tab display
    enableSectionTabs: true,
    // Sidebar default display mode
    sidebarDefaultDisplayMode: 'detail',
};
