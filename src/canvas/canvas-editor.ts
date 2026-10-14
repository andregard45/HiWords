import { App, TFile } from 'obsidian';
import { CanvasData, CanvasNode, HiWordsSettings } from '../utils';
import { CanvasParser } from './canvas-parser';
import { normalizeLayout } from './layout';

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Canvas file editor
 * Handles modification operations on Canvas files
 */
export class CanvasEditor {
    private app: App;
    private settings: HiWordsSettings;

    constructor(app: App, settings: HiWordsSettings) {
        this.app = app;
        this.settings = settings;
    }

    updateSettings(settings: HiWordsSettings) {
        this.settings = settings;
    }

    /**
     * Generate a 16-char lowercase hex ID (matching standard Canvas ID style)
     */
    private genHex16(): string {
        // crypto.getRandomValues is available in browsers
        const bytes = new Uint8Array(8);
        window.crypto.getRandomValues(bytes);
        return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    }

    /**
     * Add a word to a Canvas file
     * @param bookPath the Canvas file path
     * @param word the word to add
     * @param definition the word definition
     * @param color optional node color
     * @param aliases optional array of word aliases
     * @returns whether the operation succeeded
     */
    /**
     * Add a word to a Canvas file
     * Optimized version: caps alias count and adds error handling
     * @returns the generated nodeId on success, null on failure
     */
    async addWordToCanvas(bookPath: string, word: string, definition: string, color?: number, aliases?: string[]): Promise<string | null> {
        try {
            const file = this.app.vault.getAbstractFileByPath(bookPath);
            if (!file || !(file instanceof TFile) || !CanvasParser.isCanvasFile(file)) {
                console.error(`Invalid Canvas file: ${bookPath}`);
                return null;
            }

            // Filter out empty aliases
            if (aliases) {
                aliases = aliases.filter((alias) => alias && alias.trim().length > 0);
                if (aliases.length === 0) aliases = undefined;
            }

            // Use atomic updates to avoid concurrent overwrites
            const parser = new CanvasParser(this.app, this.settings);
            let generatedNodeId = '';
            await this.app.vault.process(file, (current) => {
                const canvasData: CanvasData = JSON.parse(current || '{"nodes":[],"edges":[]}');
                if (!Array.isArray(canvasData.nodes)) canvasData.nodes = [];

                // Generate a 16-hex ID
                const nodeId = this.genHex16();
                generatedNodeId = nodeId;

                // Placement parameters (read from settings; defaults if unset)
                const newW = this.settings.cardWidth ?? 260;
                const newH = this.settings.cardHeight ?? 120;
                const verticalGap = 20;
                const groupPadding = 24; // Horizontal gap kept from the Mastered group

                // Simple geometry helpers (with fallbacks)
                const num = (v: unknown, def: number) => (typeof v === 'number' ? v : def);
                const rectOf = (n: Partial<CanvasNode>) => ({
                    x: num(n.x, 0),
                    y: num(n.y, 0),
                    w: num(n.width, 200),
                    h: num(n.height, 60),
                });
                const overlaps = (ax: number, aw: number, bx: number, bw: number) => ax < bx + bw && ax + aw > bx;

                // Locate the Mastered group (if present)
                const masteredGroup = canvasData.nodes.find(
                    (n) => n.type === 'group' && (n.label === 'Mastered' || n.label === '已掌握')
                );
                const g = masteredGroup ? rectOf(masteredGroup as Partial<CanvasNode>) : undefined;

                // Compute position: default (0,0). Prefer the last normal node outside the Mastered group as reference
                let x = 0;
                let y = 0;
                if (canvasData.nodes.length > 0) {
                    let ref: Partial<CanvasNode> | undefined;
                    for (let i = canvasData.nodes.length - 1; i >= 0; i--) {
                        const n = canvasData.nodes[i] as Partial<CanvasNode>;
                        if (n.type === 'group') continue;
                        if (g) {
                            const r = rectOf(n);
                            const insideHoriz = overlaps(r.x, r.w, g.x, g.w);
                            const insideVert = overlaps(r.y, r.h, g.y, g.h);
                            if (insideHoriz && insideVert) continue; // Skip reference nodes inside the Mastered group
                        }
                        ref = n;
                        break;
                    }
                    if (ref) {
                        const r = rectOf(ref);
                        x = r.x;
                        y = r.y + r.h + verticalGap;
                    }
                }

                // If the new position overlaps the Mastered group horizontally, place it in the margin to the group's right
                if (g && overlaps(x, newW, g.x, g.w)) {
                    x = g.x + g.w + groupPadding;
                }

                // Build the text
                let nodeText = word;
                if (aliases && aliases.length > 0) nodeText = `${word}\n*${aliases.join(', ')}*`;
                if (definition) nodeText = `${nodeText}\n\n${definition}`;

                const newNode: CanvasNode = {
                    id: nodeId,
                    type: 'text',
                    x,
                    y,
                    width: newW,
                    height: newH,
                    text: nodeText,
                    color: color !== undefined ? color.toString() : undefined,
                };

                canvasData.nodes.push(newNode);

                // Consistently use the configurable auto-layout
                normalizeLayout(canvasData, this.settings, parser);
                return JSON.stringify(canvasData);
            });

            return generatedNodeId;
        } catch (error) {
            console.error(`Failed to add word to Canvas: ${formatError(error)}`);
            return null;
        }
    }

    /**
     * Update a word in a Canvas file
     * @param bookPath the Canvas file path
     * @param nodeId the node ID to update
     * @param word the word
     * @param definition the word definition
     * @param color optional node color
     * @param aliases optional array of word aliases
     * @returns whether the operation succeeded
     */
    async updateWordInCanvas(bookPath: string, nodeId: string, word: string, definition: string, color?: number, aliases?: string[]): Promise<boolean> {
        try {
            const file = this.app.vault.getAbstractFileByPath(bookPath);
            if (!file || !(file instanceof TFile) || !CanvasParser.isCanvasFile(file)) {
                console.error(`Invalid Canvas file: ${bookPath}`);
                return false;
            }

            // Filter out empty aliases
            if (aliases) {
                aliases = aliases.filter((alias) => alias && alias.trim().length > 0);
                if (aliases.length === 0) aliases = undefined;
            }

            let updated = false;
            const parser = new CanvasParser(this.app);
            await this.app.vault.process(file, (current) => {
                const canvasData: CanvasData = JSON.parse(current || '{"nodes":[],"edges":[]}');
                if (!Array.isArray(canvasData.nodes)) canvasData.nodes = [];

                const index = canvasData.nodes.findIndex((n) => n.id === nodeId);
                if (index === -1) {
                    console.error(`Node not found: ${nodeId}`);
                    return JSON.stringify(canvasData);
                }

                let nodeText = word;
                if (aliases && aliases.length > 0) nodeText = `${word}\n*${aliases.join(', ')}*`;
                if (definition) nodeText = `${nodeText}\n\n${definition}`;

                canvasData.nodes[index].text = nodeText;
                if (color !== undefined) canvasData.nodes[index].color = color.toString();

                // Auto layout
                normalizeLayout(canvasData, this.settings, parser);

                updated = true;
                return JSON.stringify(canvasData);
            });

            return updated;
        } catch (error) {
            console.error(`Failed to update word in Canvas: ${formatError(error)}`);
            return false;
        }
    }

    /**
     * Delete a word from a Canvas file
     * @param bookPath the Canvas file path
     * @param nodeId the node ID to delete
     * @returns whether the operation succeeded
     */
    async deleteWordFromCanvas(bookPath: string, nodeId: string): Promise<boolean> {
        try {
            const file = this.app.vault.getAbstractFileByPath(bookPath);
            if (!file || !(file instanceof TFile) || !CanvasParser.isCanvasFile(file)) {
                console.error(`Invalid Canvas file: ${bookPath}`);
                return false;
            }

            let removed = false;
            const parser = new CanvasParser(this.app);
            await this.app.vault.process(file, (current) => {
                const canvasData: CanvasData = JSON.parse(current || '{"nodes":[],"edges":[]}');
                if (!Array.isArray(canvasData.nodes)) canvasData.nodes = [];

                const index = canvasData.nodes.findIndex((n) => n.id === nodeId);
                if (index === -1) {
                    console.warn(`Node to delete not found: ${nodeId}`);
                    return JSON.stringify(canvasData);
                }

                canvasData.nodes.splice(index, 1);
                // Auto layout
                normalizeLayout(canvasData, this.settings, parser);

                removed = true;
                return JSON.stringify(canvasData);
            });

            return removed;
        } catch (error) {
            console.error(`Failed to delete word from Canvas: ${formatError(error)}`);
            return false;
        }
    }

    /**
     * Set only the node color (text, size and position unchanged)
     */
    async setNodeColor(bookPath: string, nodeId: string, color?: number): Promise<boolean> {
        try {
            const file = this.app.vault.getAbstractFileByPath(bookPath);
            if (!file || !(file instanceof TFile) || !CanvasParser.isCanvasFile(file)) {
                console.error(`Invalid Canvas file: ${bookPath}`);
                return false;
            }

            let updated = false;
            const parser = new CanvasParser(this.app, this.settings);
            await this.app.vault.process(file, (current) => {
                const canvasData: CanvasData = JSON.parse(current || '{"nodes":[],"edges":[]}');
                if (!Array.isArray(canvasData.nodes)) canvasData.nodes = [];

                const index = canvasData.nodes.findIndex((n) => n.id === nodeId);
                if (index === -1) {
                    console.error(`Node not found: ${nodeId}`);
                    return JSON.stringify(canvasData);
                }

                if (color !== undefined) {
                    canvasData.nodes[index].color = color.toString();
                } else {
                    delete canvasData.nodes[index].color;
                }

                // Still run one normalization pass (lightweight) to keep layout consistent
                normalizeLayout(canvasData, this.settings, parser);

                updated = true;
                return JSON.stringify(canvasData);
            });

            return updated;
        } catch (error) {
            console.error(`Failed to set node color: ${formatError(error)}`);
            return false;
        }
    }
}
