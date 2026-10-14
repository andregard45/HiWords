/**
 * Pattern phrase matching utility
 * Supports cross-word phrase matching with ... placeholders
 */

/**
 * Parse a phrase and detect placeholders
 */
export function parsePhrase(phrase: string): {
    isPattern: boolean;
    parts: string[];
    original: string;
} {
    const trimmed = phrase.trim();
    
    if (trimmed.includes('...')) {
        // Split the phrase and filter out empty strings
        const parts = trimmed.split('...').map(p => p.trim()).filter(p => p.length > 0);
        return {
            isPattern: true,
            parts: parts,
            original: trimmed
        };
    }
    
    return {
        isPattern: false,
        parts: [trimmed],
        original: trimmed
    };
}

/**
 * Escape regex special characters
 */
function escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the matching regex for a pattern phrase
 * @param parts the fixed parts of the phrase
 * @returns the regular expression
 */
export function buildPatternRegex(parts: string[]): RegExp {
    if (parts.length === 0) return /(?!)/; // Never matches
    if (parts.length === 1) {
        // Single part: use boundary matching
        const escaped = escapeRegExp(parts[0]);
        return new RegExp(`\\b${escaped}\\b`, 'gi');
    }
    
    // Multiple parts: join with placeholders
    // Sentence boundary: excludes . , ! ? ; : \n and similar punctuation
    const sentenceBoundary = '[^.,!?;:\\n]*?';
    const escapedParts = parts.map(p => escapeRegExp(p));
    
    // Build the pattern: part1 [no sentence break] part2 [no sentence break] part3 ...
    const pattern = escapedParts.join(sentenceBoundary);
    
    return new RegExp(pattern, 'gi');
}

/**
 * Find all pattern-phrase matches in the text
 * @param text the text to search
 * @param parts the fixed parts of the phrase
 * @param offset the text's offset within the document
 * @returns array of matches with overall and per-segment positions
 */
export function findPatternMatches(
    text: string,
    parts: string[],
    offset = 0
): Array<{
    from: number;
    to: number;
    matchedText: string;
    segments: Array<{from: number, to: number}>;
}> {
    const matches: Array<{
        from: number;
        to: number;
        matchedText: string;
        segments: Array<{from: number, to: number}>;
    }> = [];
    
    if (parts.length === 0) return matches;
    
    // If there is only one part, match directly
    if (parts.length === 1) {
        const regex = new RegExp(`\\b${escapeRegExp(parts[0])}\\b`, 'gi');
        let match;
        while ((match = regex.exec(text)) !== null) {
            matches.push({
                from: offset + match.index,
                to: offset + match.index + match[0].length,
                matchedText: match[0],
                segments: [{
                    from: offset + match.index,
                    to: offset + match.index + match[0].length
                }]
            });
        }
        return matches;
    }
    
    // Multi-part matching: locate each part manually
    const lowerText = text.toLowerCase();
    const lowerParts = parts.map(p => p.toLowerCase());
    
    // Find the first part from the start of the text
    let searchStart = 0;
    while (searchStart < text.length) {
        const firstPartIndex = lowerText.indexOf(lowerParts[0], searchStart);
        if (firstPartIndex === -1) break;
        
        // Check word boundaries for the first part
        if (!isWordBoundary(text, firstPartIndex, firstPartIndex + parts[0].length)) {
            searchStart = firstPartIndex + 1;
            continue;
        }
        
        // Try to match subsequent parts
        const segments: Array<{from: number, to: number}> = [];
        segments.push({
            from: offset + firstPartIndex,
            to: offset + firstPartIndex + parts[0].length
        });
        
        let currentPos = firstPartIndex + parts[0].length;
        let allPartsMatched = true;
        
        for (let i = 1; i < parts.length; i++) {
            // Find the next part between the current position and the next sentence boundary
            const nextBoundary = findNextSentenceBoundary(text, currentPos);
            const searchText = text.substring(currentPos, nextBoundary);
            const lowerSearchText = searchText.toLowerCase();
            
            const partIndex = lowerSearchText.indexOf(lowerParts[i]);
            if (partIndex === -1) {
                allPartsMatched = false;
                break;
            }
            
            const absolutePartIndex = currentPos + partIndex;
            
            // Check word boundaries
            if (!isWordBoundary(text, absolutePartIndex, absolutePartIndex + parts[i].length)) {
                allPartsMatched = false;
                break;
            }
            
            segments.push({
                from: offset + absolutePartIndex,
                to: offset + absolutePartIndex + parts[i].length
            });
            
            currentPos = absolutePartIndex + parts[i].length;
        }
        
        if (allPartsMatched) {
            const matchStart = firstPartIndex;
            const matchEnd = currentPos;
            matches.push({
                from: offset + matchStart,
                to: offset + matchEnd,
                matchedText: text.substring(matchStart, matchEnd),
                segments: segments
            });
        }
        
        searchStart = firstPartIndex + 1;
    }
    
    return matches;
}

/**
 * Find the position of the next sentence boundary
 */
function findNextSentenceBoundary(text: string, startPos: number): number {
    const boundaries = ['.', ',', '!', '?', ';', ':', '\n'];
    let minPos = text.length;
    
    for (const boundary of boundaries) {
        const pos = text.indexOf(boundary, startPos);
        if (pos !== -1 && pos < minPos) {
            minPos = pos;
        }
    }
    
    return minPos;
}

/**
 * Check word boundaries
 * Supports English, Chinese, Japanese, Korean and other characters
 */
function isWordBoundary(text: string, start: number, end: number): boolean {
    const before = start > 0 ? text[start - 1] : ' ';
    const after = end < text.length ? text[end] : ' ';
    
    // Check whether surrounding characters are word characters
    // Greek letters (e.g. ὐ in "οὐ") must count as word characters, otherwise
    // "οὐ" would wrongly match inside longer words like "οὐκ" or "οὐδὲ".
    const isWordChar = (char: string) => {
        return /[a-z0-9\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/iu.test(char);
    };
    
    // CJK characters need no boundary check (Chinese, Japanese, Korean are not space-separated)
    const isCJK = (char: string) => {
        return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char);
    };
    
    const startChar = text[start];
    const endChar = text[end - 1];
    const boundaryStart = isCJK(startChar) || !isWordChar(before);
    const boundaryEnd = isCJK(endChar) || !isWordChar(after);
    
    return boundaryStart && boundaryEnd;
}
