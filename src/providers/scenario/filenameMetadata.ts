import * as path from 'path';
import { OutputFilenameParser, OutputFilenameParserField } from '../../profile/profileTypes';

export interface ParsedFilenameMetadata {
    parserId: string;
    extracted: Record<string, string | number>;
    confidence: number;
    title?: string;
}

interface CompiledParser {
    parser: OutputFilenameParser;
    regex: RegExp;
    captureNames: string[];
}

export function parseFilenameWithParsers(
    filePath: string,
    parsers: OutputFilenameParser[],
    entryType: 'file' | 'folder' = 'file'
): ParsedFilenameMetadata | undefined {
    if (parsers.length === 0) {
        return undefined;
    }

    const filename = path.basename(filePath);
    const normalizedPath = filePath.replace(/\\/g, '/');
    const compiled = parsers
        .filter(parser => appliesToPath(parser, normalizedPath, entryType))
        .map(parser => compileParser(parser))
        .filter((item): item is CompiledParser => Boolean(item));

    let best: ParsedFilenameMetadata | undefined;
    for (const item of compiled) {
        const match = item.regex.exec(filename);
        if (!match?.groups) {
            continue;
        }

        const converted = convertGroups(match.groups, item.parser.fields);
        if (!converted) {
            continue;
        }

        const confidence = calculateConfidence(item, converted);
        const title = renderTitleTemplate(item.parser.titleTemplate, converted);
        if (!best || confidence > best.confidence) {
            best = {
                parserId: item.parser.id,
                extracted: converted,
                confidence,
                title
            };
        }
    }

    return best;
}

export function validateFilenameParser(parser: OutputFilenameParser): string[] {
    const errors: string[] = [];
    if (!parser.id.trim()) {
        errors.push('Parser id is required.');
    }
    if (!parser.pattern.trim()) {
        errors.push(`Parser '${parser.id || '<unknown>'}' pattern is required.`);
    }

    const fieldNames = parser.fields.map(field => field.name.trim()).filter(Boolean);
    const duplicates = findDuplicates(fieldNames);
    if (duplicates.length > 0) {
        errors.push(`Parser '${parser.id}' has duplicate field names: ${duplicates.join(', ')}.`);
    }

    for (const field of parser.fields) {
        if (!field.name.trim()) {
            errors.push(`Parser '${parser.id}' contains an empty field name.`);
            continue;
        }
        if (field.type === 'enum' && (!field.enumValues || field.enumValues.length === 0)) {
            errors.push(`Parser '${parser.id}' enum field '${field.name}' must define enum values.`);
        }
    }

    const compiled = compileParser(parser);
    if (!compiled) {
        errors.push(`Parser '${parser.id}' has an invalid pattern.`);
        return errors;
    }

    const captureNames = new Set(compiled.captureNames);
    for (const field of parser.fields) {
        if (!captureNames.has(field.name)) {
            errors.push(`Parser '${parser.id}' field '${field.name}' is not captured by pattern.`);
        }
    }

    const titleTemplate = parser.titleTemplate?.trim();
    if (titleTemplate) {
        const templateFields = [...titleTemplate.matchAll(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g)].map(match => match[1]);
        for (const fieldName of templateFields) {
            if (!captureNames.has(fieldName)) {
                errors.push(
                    `Parser '${parser.id}' title template references unknown field '${fieldName}'.`
                );
            }
        }
    }

    return errors;
}

function compileParser(parser: OutputFilenameParser): CompiledParser | undefined {
    try {
        if (parser.pattern.startsWith('regex:')) {
            const raw = parser.pattern.slice('regex:'.length).trim();
            const regex = new RegExp(raw);
            const captureNames = [...raw.matchAll(/\(\?<([a-zA-Z_][a-zA-Z0-9_]*)>/g)].map(match => match[1]);
            return { parser, regex, captureNames };
        }

        const captures: string[] = [];
        const regexSource = escapeRegExp(parser.pattern).replace(/\\\{([a-zA-Z_][a-zA-Z0-9_]*)\\\}/g, (_full, name) => {
            captures.push(name);
            return `(?<${name}>.+?)`;
        });
        return {
            parser,
            regex: new RegExp(`^${regexSource}$`),
            captureNames: captures
        };
    } catch {
        return undefined;
    }
}

function convertGroups(
    groups: Record<string, string>,
    fields: OutputFilenameParserField[]
): Record<string, string | number> | undefined {
    const result: Record<string, string | number> = {};
    for (const field of fields) {
        const raw = groups[field.name];
        if (raw === undefined) {
            return undefined;
        }

        if (field.type === 'number') {
            const parsed = Number(raw);
            if (Number.isNaN(parsed)) {
                return undefined;
            }
            result[field.name] = parsed;
            continue;
        }

        if (field.type === 'datetime') {
            const parsed = Date.parse(raw);
            if (Number.isNaN(parsed)) {
                return undefined;
            }
            result[field.name] = raw;
            continue;
        }

        if (field.type === 'enum') {
            if (!field.enumValues?.includes(raw)) {
                return undefined;
            }
            result[field.name] = raw;
            continue;
        }

        result[field.name] = raw;
    }

    return result;
}

function calculateConfidence(
    parser: CompiledParser,
    extracted: Record<string, string | number>
): number {
    const totalFields = parser.parser.fields.length || 1;
    const matchedFields = Object.keys(extracted).length;
    return matchedFields / totalFields;
}

function renderTitleTemplate(
    template: string | undefined,
    extracted: Record<string, string | number>
): string | undefined {
    const normalized = template?.trim();
    if (!normalized) {
        return undefined;
    }

    const rendered = normalized.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_full, fieldName: string) => {
        const value = extracted[fieldName];
        return value === undefined ? '' : String(value);
    }).trim();
    return rendered.length > 0 ? rendered : undefined;
}

function appliesToPath(
    parser: OutputFilenameParser,
    normalizedPath: string,
    entryType: 'file' | 'folder'
): boolean {
    const appliesToKind = parser.appliesToKind ?? 'files';
    if (appliesToKind === 'files' && entryType === 'folder') {
        return false;
    }
    if (appliesToKind === 'folders' && entryType === 'file') {
        return false;
    }

    if (!parser.appliesTo || parser.appliesTo.length === 0) {
        return true;
    }

    const filename = path.basename(normalizedPath);
    return parser.appliesTo.some(rule => {
        const trimmed = rule.trim();
        if (!trimmed) {
            return false;
        }
        if (trimmed.startsWith('.')) {
            return filename.toLowerCase().endsWith(trimmed.toLowerCase());
        }
        const globRegex = new RegExp(`^${trimmed.split('*').map(escapeRegExp).join('.*')}$`);
        return globRegex.test(normalizedPath);
    });
}

function findDuplicates(values: string[]): string[] {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const value of values) {
        if (seen.has(value)) {
            duplicates.add(value);
        } else {
            seen.add(value);
        }
    }
    return [...duplicates];
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
