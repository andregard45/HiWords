/**
 * Sentence extraction utility
 */

/**
 * Extract from text the sentence containing the given position
 * @param text the full text
 * @param position cursor position (character index relative to the start of the text)
 * @returns the extracted sentence
 */
export function extractSentence(text: string, position: number): string {
    if (!text || position < 0 || position > text.length) {
        return '';
    }

    // Sentence-ending markers
    const sentenceEnders = /[.!?。！？\n]/;
    
    // Search backwards for the sentence start
    let start = position;
    while (start > 0) {
        const char = text[start - 1];
        if (sentenceEnders.test(char)) {
            break;
        }
        start--;
    }
    
    // Search forwards for the sentence end
    let end = position;
    while (end < text.length) {
        const char = text[end];
        if (sentenceEnders.test(char)) {
            // Include the ending punctuation
            end++;
            break;
        }
        end++;
    }
    
    // Extract the sentence and trim whitespace
    const sentence = text.substring(start, end).trim();
    
    return sentence;
}

/**
 * Extract the sentence containing the editor selection
 * @param editor the Obsidian Editor instance
 * @returns the extracted sentence
 */
export function extractSentenceFromEditor(editor: Editor): string {
    try {
        const cursor = editor.getCursor();
        const line = editor.getLine(cursor.line);
        const ch = cursor.ch;
        
        // Use extractSentence on the current line
        return extractSentence(line, ch);
    } catch (error) {
        console.error('Failed to extract sentence from editor:', error);
        return '';
    }
}

/**
 * Extract the sentence from multi-line text
 * @param editor the Obsidian Editor instance
 * @returns the extracted sentence (may span lines)
 */
export function extractSentenceFromEditorMultiline(editor: Editor): string {
    try {
        const cursor = editor.getCursor();
        const doc = editor.getValue();
        
        // Compute the cursor position within the whole document
        let position = 0;
        for (let i = 0; i < cursor.line; i++) {
            position += editor.getLine(i).length + 1; // +1 for newline
        }
        position += cursor.ch;
        
        // Extract the sentence from the whole document
        return extractSentence(doc, position);
    } catch (error) {
        console.error('Failed to extract sentence from editor (multiline):', error);
        return '';
    }
}

/**
 * Extract the sentence from a DOM Selection
 * Works for reading mode and PDF views
 * @param selection the range object returned by window.getSelection()
 * @returns the extracted sentence
 */
export function extractSentenceFromSelection(selection: Selection | null): string {
    if (!selection || selection.rangeCount === 0) {
        return '';
    }
    
    try {
        const range = selection.getRangeAt(0);
        const selectedText = selection.toString().trim();
        
        if (!selectedText) {
            return '';
        }
        
        // Get the start node of the selection
        let startNode = range.startContainer;
        
        // If it is an element node, try to get a text node inside it
        if (startNode.nodeType === Node.ELEMENT_NODE) {
            const textNode = startNode.childNodes[range.startOffset];
            if (textNode && textNode.nodeType === Node.TEXT_NODE) {
                startNode = textNode;
            }
        }
        
        // Find a suitable paragraph container
        const paragraphContainer = findParagraphContainer(startNode);
        if (!paragraphContainer) {
            return '';
        }
        
        // Get the paragraph text
        const paragraphText = paragraphContainer.textContent || '';
        
        // Compute the actual position of the selected text within the paragraph
        const actualPosition = calculateTextPosition(paragraphContainer, startNode, range.startOffset, selectedText);
        if (actualPosition === -1) {
            return '';
        }
        
        // Extract the sentence around the middle of the selection
        const middlePosition = actualPosition + Math.floor(selectedText.length / 2);
        return extractSentence(paragraphText, middlePosition);
    } catch (error) {
        console.error('Failed to extract sentence from selection:', error);
        return '';
    }
}

/**
 * Find a suitable paragraph container
 * @param startNode the start node
 * @returns the paragraph container element
 */
function findParagraphContainer(startNode: Node): HTMLElement | null {
    let currentNode: Node | null = startNode;
    
    // If it is a text node, get its parent element
    if (currentNode.nodeType === Node.TEXT_NODE) {
        currentNode = currentNode.parentNode;
    }
    
    let paragraphContainer: HTMLElement | null = null;
    
    while (currentNode && currentNode.nodeType !== Node.DOCUMENT_NODE) {
        if (currentNode.nodeType === Node.ELEMENT_NODE) {
            const element = currentNode as HTMLElement;
            const tagName = element.tagName?.toLowerCase();
            
            // Reading mode: find paragraph-level elements
            if (tagName === 'p' || tagName === 'li' || tagName === 'blockquote') {
                return element;
            }
            
            // Find a suitably sized div container
            if (tagName === 'div') {
                const textLength = element.textContent?.length || 0;
                if (textLength > 0 && textLength < 5000) {
                    paragraphContainer = element;
                }
            }
            
            // PDF mode: find the textLayer container
            if (element.classList.contains('textLayer')) {
                return element;
            }
            
            // PDF mode: find textLayer inside the page container
            if (element.classList.contains('page') && element.closest('.pdf-container')) {
                const textLayer = element.querySelector('.textLayer');
                if (textLayer) {
                    return textLayer as HTMLElement;
                }
            }
        }
        currentNode = currentNode.parentNode;
    }
    
    return paragraphContainer;
}

/**
 * Compute the actual position of the selected text within the paragraph
 * @param container the paragraph container
 * @param startNode the start node
 * @param startOffset the start offset
 * @param selectedText the selected text
 * @returns the text position, -1 if not found
 */
function calculateTextPosition(
    container: HTMLElement,
    startNode: Node,
    startOffset: number,
    selectedText: string
): number {
    // Use TreeWalker over text nodes to compute the exact position
    const walker = activeDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    
    let currentOffset = 0;
    let node: Node | null;
    
    while ((node = walker.nextNode())) {
        if (node === startNode || node.contains(startNode)) {
            return currentOffset + startOffset;
        }
        currentOffset += node.textContent?.length || 0;
    }
    
    // Fallback: use indexOf
    const paragraphText = container.textContent || '';
    return paragraphText.indexOf(selectedText);
}
import type { Editor } from 'obsidian';
