/**
 * Color utility functions
 */

/**
 * Map Canvas node colors to Obsidian CSS variables
 * @param canvasColor the Canvas node color value (number or color name)
 * @param fallback the default color (optional)
 * @returns an Obsidian CSS variable string
 */
export function mapCanvasColorToCSSVar(
    canvasColor: string | undefined, 
    fallback = 'var(--color-accent)'
): string {
    if (!canvasColor) return fallback;
    
    // Canvas color mapping table
    const colorMap: { [key: string]: string } = {
        // Numeric mapping (common in Canvas)
        '1': 'var(--color-red)',
        '2': 'var(--color-orange)', 
        '3': 'var(--color-yellow)',
        '4': 'var(--color-green)',
        '5': 'var(--color-cyan)',
        '6': 'var(--color-purple)',
        
        // Color-name mapping
        'red': 'var(--color-red)',
        'orange': 'var(--color-orange)',
        'yellow': 'var(--color-yellow)',
        'green': 'var(--color-green)',
        'cyan': 'var(--color-cyan)',
        'blue': 'var(--color-blue)',
        'purple': 'var(--color-purple)',
        'pink': 'var(--color-pink)',
        
        // Extra color support
        'gray': 'var(--color-base-60)',
        'grey': 'var(--color-base-60)',
        'white': 'var(--color-base-00)',
        'black': 'var(--color-base-100)'
    };
    
    // Return the CSS variable if a mapping exists; otherwise return the original color value
    return colorMap[canvasColor.toLowerCase()] || canvasColor;
}

/**
 * Get a faded version of a color (for backgrounds)
 * @param cssVar the CSS variable string
 * @param opacity the opacity (0-1)
 * @returns a color string with opacity
 */
export function getColorWithOpacity(cssVar: string, opacity = 0.1): string {
    // For CSS variables, use color-mix to create the transparency effect
    if (cssVar.startsWith('var(--color-')) {
        // Use the modern CSS color-mix function
        return `color-mix(in srgb, ${cssVar} ${opacity * 100}%, transparent)`;
    }
    
    // Use color-mix for other color values too
    if (cssVar.startsWith('#') || cssVar.startsWith('rgb') || cssVar.startsWith('hsl')) {
        return `color-mix(in srgb, ${cssVar} ${opacity * 100}%, transparent)`;
    }
    
    // If nothing matches, return the original value
    return cssVar;
}

/**
 * Check whether a value is a valid Canvas color
 * @param color the color value
 * @returns whether it is a valid color
 */
export function isValidCanvasColor(color: string | undefined): boolean {
    if (!color) return false;
    
    const validColors = ['1', '2', '3', '4', '5', '6', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink'];
    return validColors.includes(color.toLowerCase());
}
