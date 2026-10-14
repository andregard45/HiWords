/**
 * Trie (prefix tree) data structure implementation
 * Used to match many words efficiently
 */
export class Trie<TPayload = unknown> {
    private root: TrieNode<TPayload>;

    constructor() {
        this.root = new TrieNode<TPayload>();
    }

    /**
     * Add a word to the trie
     * @param word the word to add
     * @param payload data associated with the word
     */
    addWord(word: string, payload: TPayload): void {
        let node = this.root;
        const lowerWord = word.toLowerCase();
        
        for (const char of lowerWord) {
            if (!node.children.has(char)) {
                node.children.set(char, new TrieNode<TPayload>());
            }
            const child = node.children.get(char);
            if (!child) return;
            node = child;
        }
        
        node.isEndOfWord = true;
        node.payload = payload;
        node.word = word; // Store the original word form
    }

    /**
     * Find all matching words in the text
     * @param text the text to search
     * @returns array of matches, each with word, position and associated data
     */
    findAllMatches(text: string): Array<TrieMatch<TPayload>> {
        const matches: Array<TrieMatch<TPayload>> = [];
        const lowerText = text.toLowerCase();
        
        // Try matching at every position in the text
        for (let i = 0; i < lowerText.length; i++) {
            let node = this.root;
            let j = i;
            
            // Try to match a word starting at the current position
            while (j < lowerText.length && node.children.has(lowerText[j])) {
                const child = node.children.get(lowerText[j]);
                if (!child) break;
                node = child;
                j++;
                
                // If a word ends here, record the match
                if (node.isEndOfWord) {
                    // Check word boundaries
                    // CJK characters need no boundary check (Chinese, Japanese, Korean are not space-separated)
                    const matchedStart = lowerText[i];
                    const matchedEnd = lowerText[j - 1];
                    const isWordBoundaryStart = isCJKChar(matchedStart) || i === 0 || !isAlphaNumeric(lowerText[i - 1]);
                    const isWordBoundaryEnd = isCJKChar(matchedEnd) || j === lowerText.length || !isAlphaNumeric(lowerText[j]);
                    
                    if (isWordBoundaryStart && isWordBoundaryEnd) {
                        matches.push({
                            word: node.word || lowerText.substring(i, j),
                            from: i,
                            to: j,
                            payload: node.payload
                        });
                    }
                }
            }
        }
        
        return matches;
    }

    /**
     * Clear the trie
     */
    clear(): void {
        this.root = new TrieNode<TPayload>();
    }
}

/**
 * Trie node
 */
class TrieNode<TPayload = unknown> {
    children: Map<string, TrieNode<TPayload>>;
    isEndOfWord: boolean;
    payload: TPayload | null;
    word: string | null;
    
    constructor() {
        this.children = new Map();
        this.isEndOfWord = false;
        this.payload = null;
        this.word = null;
    }
}

/**
 * Trie match result
 */
export interface TrieMatch<TPayload = unknown> {
    word: string;
    from: number;
    to: number;
    payload: TPayload | null;
}

/**
 * Check whether a character is alphanumeric
 * Supports English, Greek, Cyrillic, Chinese, Japanese, Korean and other characters
 * Note: Greek letters (e.g. ὐ in "οὐ") must count as word characters, otherwise
 * "οὐ" would wrongly match inside longer words like "οὐκ" or "οὐδὲ".
 */
function isAlphaNumeric(char: string): boolean {
    return /[a-z0-9\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/iu.test(char);
}

/**
 * Check whether a character is CJK (Chinese, Japanese, Korean)
 * CJK text has no space tokenization, so word-boundary checks are unnecessary
 */
function isCJKChar(char: string): boolean {
    return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char);
}
