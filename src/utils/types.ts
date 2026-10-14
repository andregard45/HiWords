// Use Obsidian's official Canvas types
import type { AllCanvasNodeData, CanvasData as ObsidianCanvasData } from 'obsidian/canvas';

// Export aliases of the official types for backward compatibility
export type CanvasNode = AllCanvasNodeData;
export type CanvasData = ObsidianCanvasData;

export interface WordSection {
    title: string;
    content: string;
}

export interface WordCardDefinition {
    pos?: string;
    zh?: string;
    en?: string;
}

export interface WordCardExample {
    text: string;
    translation?: string;
    source?: string;
}

export interface WordCardMemory {
    hint?: string;
    note?: string;
    root?: string;
    mnemonic?: string;
}

export interface WordCardPhonetics {
    uk?: string;
    us?: string;
}

export interface WordCardAudio {
    uk?: string;
    us?: string;
    default?: string;
}

export interface WordCardImage {
    src: string;
    alt?: string;
    caption?: string;
    credit?: string;
}

export interface WordCardConfusable {
    word: string;
    note: string;
    examples?: string[];
}

export interface WordCardAffix {
    text: string;
    meaning?: string;
    role?: string;
}

export interface WordCardMorphology {
    type?: string;
    root?: string;
    prefixes?: WordCardAffix[];
    suffixes?: WordCardAffix[];
    compound?: string[];
    breakdown?: string;
    explanation?: string;
}

export interface WordCardPhrase {
    phrase: string;
    meaning?: string;
    note?: string;
    example?: string;
}

export interface WordCardRelation {
    type: string;
    target: string;
    targetType?: LearningItemType | 'topic' | 'grammar' | 'pattern' | 'concept';
    note?: string;
}

export interface WordCardUsageMistake {
    wrong: string;
    correct: string;
    note?: string;
}

export interface WordCardUsage {
    register?: string;
    domains?: string[];
    topics?: string[];
    commonPatterns?: string[];
    mistakes?: WordCardUsageMistake[];
}

export interface WordCardLearning {
    depth?: string;
    priority?: number;
    reason?: string;
}

export type WordCardDetailSection =
    'definitions' |
    'examples' |
    'collocations' |
    'memory' |
    'forms' |
    'morphology' |
    'phrases' |
    'usage' |
    'confusables' |
    'relations' |
    'note';

export type WordCardPreviewDensity = 'simple' | 'standard' | 'rich';

export interface VocabularyBookDisplaySettings {
    previewDensity?: WordCardPreviewDensity;
    previewSections?: WordCardDetailSection[];
    detailSections?: WordCardDetailSection[];
    hiddenSections?: WordCardDetailSection[];
}

export interface WordCard {
    id?: string;
    version?: number;
    word: string;
    type?: LearningItemType;
    aliases?: string[];
    color?: string; // Optional Canvas-style color id: "1".."6"
    phonetic?: string; // v1 compatibility; prefer phonetics in new .hiwords packs
    phonetics?: WordCardPhonetics;
    audio?: WordCardAudio;
    language?: string;
    level?: string;
    partsOfSpeech?: string[];
    difficulty?: number;
    priority?: number;
    tags?: string[];
    frequency?: number;
    register?: string;
    domains?: string[];
    examTags?: string[];
    definitions?: WordCardDefinition[];
    definition?: string;
    examples?: WordCardExample[];
    memory?: WordCardMemory;
    collocations?: string[];
    phrases?: WordCardPhrase[];
    forms?: Record<string, string | string[] | number | boolean | null | undefined>;
    morphology?: WordCardMorphology;
    relations?: WordCardRelation[];
    usage?: WordCardUsage;
    learning?: WordCardLearning;
    confusables?: WordCardConfusable[];
    images?: WordCardImage[];
}

// Vocabulary definition
export interface WordDefinition {
    word: string;
    type?: LearningItemType;
    language?: string;
    studyKey?: string;
    aliases?: string[]; // List of word aliases
    definition: string; // Legacy compatibility: store the first section's content when sections exist
    rawDefinition?: string; // Original full definition (includes all sections)
    sections?: WordSection[]; // Multi-section content separated by ---
    source: string; // Canvas file path
    nodeId: string; // Canvas node ID
    color?: string;
    mastered?: boolean; // Whether mastered
    isPattern?: boolean; // Whether it is a pattern phrase (contains ... placeholders)
    patternParts?: string[]; // Parts of the pattern phrase (excluding ...)
    card?: WordCard; // HiWords structured word card (from a .hiwords dictionary package)
    userNote?: string;
    userNoteSource?: {
        source: string;
        nodeId: string;
    };
}

export interface StudyItem {
    studyKey: string;
    word: string;
    type?: LearningItemType;
    language?: string;
    aliases: string[];
    mastered: boolean;
    sources: WordDefinition[];
    primary: WordDefinition;
}

// Word book configuration
export interface VocabularyBook {
    path: string; // Canvas file path
    name: string; // Display name
    enabled: boolean; // Whether enabled
    color?: string; // .hiwords dictionary default color, using Canvas-style color ids "1".."6"
    display?: VocabularyBookDisplaySettings; // Dictionary-level detail display preference
}

// Highlight style type
export type HighlightStyle = 'underline' | 'background' | 'bold' | 'dotted' | 'wavy';

export type LearningItemType = 'word' | 'phrase' | 'concept' | 'term';

export interface StudyProgressItem {
    status: 'mastered';
    masteredAt?: string;
    updatedAt: string;
}

// Plugin settings
export interface HiWordsSettings {
    vocabularyBooks: VocabularyBook[];
    studyProgress?: Record<string, StudyProgressItem>;
    masteredMigrationVersion?: number;
    showDefinitionOnHover: boolean;
    enableAutoHighlight: boolean;
    highlightStyle: HighlightStyle; // Highlight style
    enableMasteredFeature: boolean; // Enable the mastered feature
    showMasteredInSidebar: boolean; // Show mastered words in the sidebar
    blurDefinitions: boolean; // Blur definition content; reveal on hover
    // Pronunciation URL template (e.g. https://dict.youdao.com/dictvoice?audio={{word}}&type=2)
    ttsTemplate?: string;
    pronunciationVariant?: 'uk' | 'us';
    // Auto-layout settings (simplified)
    autoLayoutEnabled?: boolean; // Whether auto-layout is enabled (simple grid with fixed parameters)
    // Card size settings
    cardWidth?: number; // Card width (default 260)
    cardHeight?: number; // Card height (default 120)
    // Highlight scope settings
    highlightMode?: 'all' | 'exclude' | 'include'; // Highlight mode: all/exclude/include
    highlightPaths?: string; // File path list (comma-separated)
    // File-node parsing mode
    fileNodeParseMode?: 'filename' | 'content' | 'filename-with-alias'; // File-node parsing mode
    // Enable section tabs
    enableSectionTabs?: boolean;
    // Sidebar default display mode: detail mode shows full content, word mode shows only the title line
    sidebarDefaultDisplayMode?: 'detail' | 'word';
}

// Vocabulary match information
export interface WordMatch {
    word: string;
    definition: WordDefinition;
    from: number;
    to: number;
    color: string;
    matchedText?: string; // The actually matched text (for pattern phrases)
    segments?: Array<{from: number, to: number}>; // Segmented highlight positions (for pattern phrases)
}
