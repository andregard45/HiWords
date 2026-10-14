import { App, TFile } from 'obsidian';
import { CanvasData, CanvasNode, WordDefinition, WordSection, HiWordsSettings, buildStudyKey, inferLearningItemType } from '../utils';
import { parsePhrase } from '../utils/pattern-matcher';

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class CanvasParser {
    private app: App;
    private settings?: HiWordsSettings;

    constructor(app: App, settings?: HiWordsSettings) {
        this.app = app;
        this.settings = settings;
    }

    updateSettings(settings: HiWordsSettings) {
        this.settings = settings;
    }

    /**
     * Strip Markdown formatting from text
     * @param text the text to process
     * @returns the processed text
     */
    private removeMarkdownFormatting(text: string): string {
        if (!text) return text;
        
        // Remove bold formatting **text** or __text__
        text = text.replace(/\*\*(.*?)\*\*/g, '$1').replace(/__(.*?)__/g, '$1');
        
        // Remove italic formatting *text* or _text_
        text = text.replace(/\*(.*?)\*/g, '$1').replace(/_(.*?)_/g, '$1');
        
        // Remove inline code formatting `text`
        text = text.replace(/`(.*?)`/g, '$1');
        
        // Remove strikethrough formatting ~~text~~
        text = text.replace(/~~(.*?)~~/g, '$1');
        
        // Remove highlight formatting ==text==
        text = text.replace(/==(.*?)==/g, '$1');
        
        // Remove link formatting [text](url)
        text = text.replace(/\[(.*?)\]\(.*?\)/g, '$1');
        
        return text.trim();
    }

    /**
     * Remove YAML frontmatter at the start of Markdown text
     * Only attempt removal when the text starts with ---; removes the first frontmatter block
     */
    private removeFrontmatter(text: string): string {
        if (!text) return text;
        // Strip the BOM
        if (text.charCodeAt(0) === 0xFEFF) {
            text = text.slice(1);
        }
        // Only when starting with ---, strip up to the next ---
        if (text.startsWith('---')) {
            const fmEnd = text.indexOf('\n---');
            if (fmEnd !== -1) {
                const after = text.slice(fmEnd + 4); // Skip "\n---"
                // Remove one possibly following newline
                return after.replace(/^\r?\n/, '');
            }
        }
        return text;
    }

    /**
     * Parse sections: split by ---; a leading **title** becomes the section heading
     */
    private parseSections(content: string): WordSection[] {
        if (!content) return [];

        const sectionTexts = content.split(/\n\s*---\s*\n/);
        const sections: WordSection[] = [];

        for (const sectionText of sectionTexts) {
            const trimmed = sectionText.trim();
            if (!trimmed) continue;

            const lines = trimmed.split('\n');
            const firstLine = lines[0].trim();
            const boldMatch = firstLine.match(/^\*\*(.+?)\*\*$/);

            if (boldMatch) {
                sections.push({
                    title: boldMatch[1].trim(),
                    content: lines.slice(1).join('\n').trim(),
                });
                continue;
            }

            sections.push({
                title: sections.length === 0 ? 'Definition' : `Content ${sections.length + 1}`,
                content: trimmed,
            });
        }

        return sections;
    }

    /**
     * Parse a Canvas file and extract word definitions
     */
    async parseCanvasFile(file: TFile, options?: { legacyMasteredDetection?: 'group' | 'color' }): Promise<WordDefinition[]> {
        try {
            const content = await this.app.vault.cachedRead(file);
            const canvasData: CanvasData = JSON.parse(content);
            
            const detectionMode = options?.legacyMasteredDetection;
            // Find the "Mastered" group (when group mode is used)
            const masteredGroup = detectionMode === 'group'
                ? canvasData.nodes.find(node => 
                    node.type === 'group' && 
                    (node.label === 'Mastered' || node.label === '已掌握')
                )
                : undefined;
            
            const definitions: WordDefinition[] = [];
            
            for (const node of canvasData.nodes) {
                // Text nodes
                if (node.type === 'text' && node.text) {
                    const wordDef = this.parseTextNode(node, file.path);
                    if (wordDef) {
                        if (detectionMode === 'group') {
                            if (masteredGroup && this.isNodeInGroup(node, masteredGroup)) {
                                wordDef.mastered = true;
                            }
                        } else if (detectionMode === 'color') {
                            if (node.color === '4') {
                                wordDef.mastered = true;
                            }
                        }
                        definitions.push(wordDef);
                    }
                }
                // File nodes (Markdown)
                else if (node.type === 'file' && node.file) {
                    const wordDef = await this.parseFileNode(node, file.path);
                    if (wordDef) {
                        if (detectionMode === 'group') {
                            if (masteredGroup && this.isNodeInGroup(node, masteredGroup)) {
                                wordDef.mastered = true;
                            }
                        } else if (detectionMode === 'color') {
                            if (node.color === '4') {
                                wordDef.mastered = true;
                            }
                        }
                        definitions.push(wordDef);
                    }
                }
            }
            
            return definitions;
        } catch (error) {
            console.error(`Failed to parse canvas file ${file.path}:`, error);
            return [];
        }
    }

    /**
     * Parse word, aliases and definition from arbitrary text content
     */
    private parseFromText(text: string, node: CanvasNode, sourcePath: string): WordDefinition | null {
        if (!text) return null;

        // Remove frontmatter first, then trim overall
        text = this.removeFrontmatter(text).trim();
        let word = '';
        const aliases: string[] = [];
        let definition = '';

        try {
            // Split into lines
            const lines = text.split('\n');
            if (lines.length === 0) return null;
            
            // Take the first line as the headword
            word = lines[0].replace(/^#+\s*/, '').trim();
            
            // Strip Markdown formatting (bold, italic, code, etc.)
            word = this.removeMarkdownFormatting(word);
            
            if (!word) return null;
            
            // Process aliases and definition
            if (lines.length > 1) {
                // Loop to find italic alias lines
                let aliasLineIndex = -1;
                let definitionStartIndex = -1;
                // Parse aliases (starting from the second line)
                for (let i = 1; i < lines.length; i++) {
                    const line = lines[i].trim();
                    
                    // Check for italic-form aliases *alias1, alias2, alias3*
                    if (
                        line.startsWith('*') &&
                        line.endsWith('*') &&
                        line.length > 2 &&
                        !line.startsWith('**') &&
                        !line.endsWith('**')
                    ) {
                        const aliasText = line.slice(1, -1); // Trim the surrounding *
                        const aliasArray = aliasText.split(',').map(a => a.trim()).filter(a => a);
                        aliases.push(...aliasArray);
                        aliasLineIndex = i;
                    }
                    // If it is neither an alias line nor blank, the definition starts here
                    else if (line !== '') {
                        definitionStartIndex = i;
                        break;
                    }
                }
                
                // If the definition start was found, extract the definition
                if (definitionStartIndex > 0 && definitionStartIndex < lines.length) {
                    // Skip blank lines at the definition start
                    while (definitionStartIndex < lines.length && lines[definitionStartIndex].trim() === '') {
                        definitionStartIndex++;
                    }
                    
                    if (definitionStartIndex < lines.length) {
                        definition = lines.slice(definitionStartIndex).join('\n').trim();
                    }
                } else if (aliasLineIndex === -1) {
                    // If no alias line was found, all following lines are the definition
                    definition = lines.slice(1).join('\n').trim();
                }
            }

            if (!word) return null;

            // Parse the phrase and detect whether it is a pattern phrase
            const phraseInfo = parsePhrase(word);
            const language = this.inferCanvasLanguage(word);
            const type = inferLearningItemType(word, language);
            const studyKey = buildStudyKey({ word, language, type });
            const rawDefinition = definition;
            let sections: WordSection[] | undefined;

            if (definition && definition.includes('\n---\n')) {
                sections = this.parseSections(definition);
                if (sections.length > 0) {
                    definition = sections[0].content;
                }
            }
            
            const result: WordDefinition = {
                word: phraseInfo.isPattern ? phraseInfo.original : word.toLowerCase(), // Pattern phrases keep their case; plain words are lowercased
                type,
                language,
                studyKey,
                aliases: aliases.length > 0 ? aliases : undefined,
                definition,
                rawDefinition: rawDefinition || definition,
                sections,
                source: sourcePath,
                nodeId: node.id,
                color: node.color,
                isPattern: phraseInfo.isPattern,
                patternParts: phraseInfo.isPattern ? phraseInfo.parts : undefined
            };
            

            
            return result;
        } catch (error) {
            console.error(`Error parsing node text: ${formatError(error)}`);
            return null;
        }
    }

    private inferCanvasLanguage(word: string): string | undefined {
        if (/[\u4e00-\u9fff]/.test(word)) return 'zh';
        if (/[A-Za-z]/.test(word)) return 'en';
        return undefined;
    }

    /**
     * Parse a text node into word, aliases and definition (wraps generic text parsing)
     * Optimized version: supports italic lines after the headword as aliases
     */
    private parseTextNode(node: CanvasNode, sourcePath: string): WordDefinition | null {
        if (!node.text) return null;
        return this.parseFromText(node.text, node, sourcePath);
    }

    /**
     * Parse a file node (Markdown) using the configured parsing mode
     */
    private async parseFileNode(node: CanvasNode, sourcePath: string): Promise<WordDefinition | null> {
        try {
            const filePath = node.type === 'file' ? node.file : undefined;
            if (!filePath) return null;

            const abs = this.app.vault.getAbstractFileByPath(filePath);
            if (!(abs instanceof TFile)) return null;
            if (abs.extension !== 'md') return null;

            const mode = this.settings?.fileNodeParseMode || 'filename-with-alias';
            const fileName = abs.basename; // File name (without extension)

            // Mode 1: file name only
            if (mode === 'filename') {
                const language = this.inferCanvasLanguage(fileName);
                const type = inferLearningItemType(fileName, language);
                return {
                    word: fileName,
                    type,
                    language,
                    studyKey: buildStudyKey({ word: fileName, language, type }),
                    aliases: [],
                    definition: '',
                    source: sourcePath,
                    nodeId: node.id,
                    color: node.color,
                    mastered: false
                };
            }

            // Read the file content
            const md = await this.app.vault.cachedRead(abs);

            // Mode 2: file content only (current behavior)
            if (mode === 'content') {
                return this.parseFromText(md, node, sourcePath);
            }

            // Mode 3: file name as headword, first content line as alias (default)
            if (mode === 'filename-with-alias') {
                const parsed = this.parseFromText(md, node, sourcePath);
                
                if (parsed && parsed.word) {
                    // Use the original word as an alias
                    const originalWord = parsed.word;
                    const existingAliases = parsed.aliases || [];
                    const newAliases = originalWord !== fileName 
                        ? [originalWord, ...existingAliases]
                        : existingAliases; // If the file name equals the first content line, avoid duplication
                    const language = this.inferCanvasLanguage(fileName);
                    const type = inferLearningItemType(fileName, language);
                    
                    return {
                        ...parsed,
                        word: fileName,
                        language,
                        type,
                        studyKey: buildStudyKey({ word: fileName, language, type }),
                        aliases: newAliases
                    };
                }
                
                // If parsing fails (empty file), at least return the file name
                const language = this.inferCanvasLanguage(fileName);
                const type = inferLearningItemType(fileName, language);
                return {
                    word: fileName,
                    type,
                    language,
                    studyKey: buildStudyKey({ word: fileName, language, type }),
                    aliases: [],
                    definition: '',
                    source: sourcePath,
                    nodeId: node.id,
                    color: node.color,
                    mastered: false
                };
            }

            return null;
        } catch (error) {
            console.error('Failed to parse file node:', error);
            return null;
        }
    }

    /**
     * Check whether a file is a Canvas file
     */
    static isCanvasFile(file: TFile): boolean {
        return file.extension === 'canvas';
    }

    /**
     * Validate the Canvas file format
     */
    async validateCanvasFile(file: TFile): Promise<boolean> {
        try {
            const content = await this.app.vault.cachedRead(file);
            const trimmed = content?.trim() ?? '';
            // A newly created empty Canvas counts as valid
            if (trimmed === '') return true;

            const data = JSON.parse(trimmed);
            // Missing fields default to empty arrays and remain valid
            const nodesOk = !('nodes' in data) || Array.isArray(data.nodes);
            const edgesOk = !('edges' in data) || Array.isArray(data.edges);
            return nodesOk && edgesOk;
        } catch {
            // Parsing failed, but since it is a .canvas file adding is allowed; later parsing returns empty results
            return true;
        }
    }

    /**
     * Check whether a node is inside the given group
     * @param node the node to check
     * @param group the group node
     * @returns whether it is inside the group
     */
    public isNodeInGroup(node: CanvasNode, group: CanvasNode): boolean {
        // Use geometry only to avoid ambiguity with the node.group field
        const nodeX = typeof node.x === 'number' ? node.x : 0;
        const nodeY = typeof node.y === 'number' ? node.y : 0;
        const nodeW = typeof node.width === 'number' ? node.width : 200; // Default text width
        const nodeH = typeof node.height === 'number' ? node.height : 60; // Default text height

        const groupX = typeof group.x === 'number' ? group.x : 0;
        const groupY = typeof group.y === 'number' ? group.y : 0;
        const groupW = typeof group.width === 'number' ? group.width : 300; // Default group width
        const groupH = typeof group.height === 'number' ? group.height : 150; // Default group height

        const nodeLeft = nodeX;
        const nodeRight = nodeX + nodeW;
        const nodeTop = nodeY;
        const nodeBottom = nodeY + nodeH;

        const groupLeft = groupX;
        const groupRight = groupX + groupW;
        const groupTop = groupY;
        const groupBottom = groupY + groupH;

        const isInside =
            nodeLeft >= groupLeft &&
            nodeRight <= groupRight &&
            nodeTop >= groupTop &&
            nodeBottom <= groupBottom;

        if (!isInside) {
            const hasOverlap =
                nodeLeft < groupRight &&
                nodeRight > groupLeft &&
                nodeTop < groupBottom &&
                nodeBottom > groupTop;

            if (hasOverlap) {
                const overlapLeft = Math.max(nodeLeft, groupLeft);
                const overlapRight = Math.min(nodeRight, groupRight);
                const overlapTop = Math.max(nodeTop, groupTop);
                const overlapBottom = Math.min(nodeBottom, groupBottom);
                const overlapArea = (overlapRight - overlapLeft) * (overlapBottom - overlapTop);
                const nodeArea = nodeW * nodeH;
                return overlapArea >= nodeArea * 0.5;
            }
            return false;
        }

        return true;
    }
}
