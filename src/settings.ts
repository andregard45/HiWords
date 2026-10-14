import type { HiWordsSettings } from './utils';

/**
 * 插件默认设置
 */
export const DEFAULT_SETTINGS: HiWordsSettings = {
    vocabularyBooks: [],
    studyProgress: {},
    masteredMigrationVersion: 0,
    showDefinitionOnHover: true,
    enableAutoHighlight: true,
    highlightStyle: 'underline', // 默认使用下划线样式
    enableMasteredFeature: true, // 默认启用已掌握功能
    showMasteredInSidebar: true,  // 跟随 enableMasteredFeature 的值
    blurDefinitions: false, // 默认不启用模糊效果
    // 自动布局（简化版，使用固定参数）
    autoLayoutEnabled: true,
    // 卡片尺寸设置
    cardWidth: 260,
    cardHeight: 120,
    // 高亮范围设置
    highlightMode: 'all',
    highlightPaths: '',
    // 文件节点解析模式
    fileNodeParseMode: 'filename-with-alias',
    // 分区 Tab 显示
    enableSectionTabs: true,
    // 侧边栏默认显示模式
    sidebarDefaultDisplayMode: 'detail',
};
