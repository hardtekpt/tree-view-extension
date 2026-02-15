import { RunTagDefinition } from './types';

// Generate a stable tag id from label with collision handling.
export function createTagId(label: string, catalog: Map<string, RunTagDefinition>): string {
    const slug = label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'tag';

    let candidate = slug;
    let index = 2;
    while (catalog.has(candidate)) {
        candidate = `${slug}-${index}`;
        index += 1;
    }

    return candidate;
}

// Keep colors normalized and valid for consistent rendering.
export function normalizeColor(value: string): string {
    const trimmed = value.trim();
    if (/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(trimmed)) {
        return trimmed.toUpperCase();
    }

    return '#888888';
}

// Normalize optional fields so persistence and UI stay predictable.
export function normalizeTag(tag: RunTagDefinition): RunTagDefinition {
    return {
        ...tag,
        label: tag.label.trim(),
        color: normalizeColor(tag.color),
        icon: tag.icon?.trim() || undefined,
        description: tag.description?.trim() || undefined
    };
}

// Render a compact tag "chip" for tree item descriptions.
export function formatTagChip(tag: RunTagDefinition): string {
    return `${colorToEmoji(tag.color)} [${tag.label}]`;
}

function colorToEmoji(hexColor: string): string {
    const value = hexColor.replace('#', '');
    if (!/^[0-9a-fA-F]{6}$/.test(value)) {
        return '⬜';
    }

    const r = parseInt(value.slice(0, 2), 16);
    const g = parseInt(value.slice(2, 4), 16);
    const b = parseInt(value.slice(4, 6), 16);

    if (r > 200 && g < 100 && b < 100) {
        return '🟥';
    }
    if (g > 160 && r < 140 && b < 140) {
        return '🟩';
    }
    if (b > 160 && r < 140 && g < 160) {
        return '🟦';
    }
    if (r > 200 && g > 170 && b < 120) {
        return '🟨';
    }
    if (r > 170 && b > 170 && g < 150) {
        return '🟪';
    }
    if (r > 150 && g > 120 && b < 80) {
        return '🟧';
    }

    return '⬜';
}
