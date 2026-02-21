export type JsonRecord = Record<string, unknown>;

export function isJsonRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((entry): entry is string => typeof entry === 'string');
}

export function asBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

export function asStringRecord(value: unknown): Record<string, string> {
    if (!isJsonRecord(value)) {
        return {};
    }

    const result: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry === 'string') {
            result[key] = entry;
        }
    }
    return result;
}

export function asBooleanRecord(value: unknown): Record<string, boolean> {
    if (!isJsonRecord(value)) {
        return {};
    }

    const result: Record<string, boolean> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry === 'boolean') {
            result[key] = entry;
        }
    }
    return result;
}
