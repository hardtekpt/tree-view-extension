import * as fs from 'fs';

export interface XmlParameter {
    id: string;
    filePath: string;
    fileName: string;
    parameterPath: string;
    value: string;
}

interface InternalParameter extends XmlParameter {
    tokens: string[];
    start: number;
    end: number;
    kind: 'text' | 'attribute';
}

interface StackNode {
    name: string;
    tokens: string[];
    childNameCount: Map<string, number>;
    hasChildElement: boolean;
    textSegments: Array<{ start: number; end: number; raw: string }>;
}

// Extract editable scalar values while keeping mapping to original text spans.
export function extractXmlParameters(xmlText: string, filePath: string): XmlParameter[] {
    const internal = parseParametersWithSpans(xmlText, filePath);
    return internal.map(({ tokens: _tokens, start: _start, end: _end, kind: _kind, ...row }) => row);
}

// Apply updates by replacing exact value spans, preserving comments/whitespace/line structure.
export function applyXmlParameterUpdates(
    xmlText: string,
    filePath: string,
    updates: Map<string, string>
): string {
    const internal = parseParametersWithSpans(xmlText, filePath);
    const byId = new Map(internal.map(param => [param.id, param] as const));

    const replacements: Array<{ start: number; end: number; value: string }> = [];
    for (const [id, next] of updates.entries()) {
        const param = byId.get(id);
        if (!param) {
            continue;
        }
        const encoded = param.kind === 'attribute' ? escapeXmlAttribute(next) : escapeXmlText(next);
        replacements.push({ start: param.start, end: param.end, value: encoded });
    }

    replacements.sort((a, b) => b.start - a.start);
    let output = xmlText;
    for (const replacement of replacements) {
        output = output.slice(0, replacement.start) + replacement.value + output.slice(replacement.end);
    }

    return output;
}

export function readXmlFile(filePath: string): string {
    return fs.readFileSync(filePath, 'utf8');
}

export function findXmlParameterPosition(
    xmlText: string,
    filePath: string,
    id: string
): { line: number; character: number } | undefined {
    const internal = parseParametersWithSpans(xmlText, filePath);
    const match = internal.find(param => param.id === id);
    if (!match) {
        return undefined;
    }
    return offsetToPosition(xmlText, match.start);
}

function parseParametersWithSpans(xmlText: string, filePath: string): InternalParameter[] {
    const output: InternalParameter[] = [];
    const stack: StackNode[] = [];
    const rootCounter = new Map<string, number>();

    let i = 0;
    while (i < xmlText.length) {
        const lt = xmlText.indexOf('<', i);
        if (lt === -1) {
            captureTextSegment(xmlText, i, xmlText.length, stack);
            break;
        }

        captureTextSegment(xmlText, i, lt, stack);

        if (xmlText.startsWith('<!--', lt)) {
            const end = xmlText.indexOf('-->', lt + 4);
            i = end >= 0 ? end + 3 : xmlText.length;
            continue;
        }

        if (xmlText.startsWith('<?', lt)) {
            const end = xmlText.indexOf('?>', lt + 2);
            i = end >= 0 ? end + 2 : xmlText.length;
            continue;
        }

        if (xmlText.startsWith('<![CDATA[', lt)) {
            const end = xmlText.indexOf(']]>', lt + 9);
            i = end >= 0 ? end + 3 : xmlText.length;
            continue;
        }

        if (xmlText.startsWith('</', lt)) {
            const gt = xmlText.indexOf('>', lt + 2);
            if (gt < 0) {
                break;
            }

            const closingName = xmlText.slice(lt + 2, gt).trim();
            const node = stack.pop();
            if (node && node.name === closingName && !node.hasChildElement) {
                for (const segment of node.textSegments) {
                    if (segment.raw.trim().length === 0) {
                        continue;
                    }
                    pushParameter(output, filePath, node.tokens, segment.raw, segment.start, segment.end, 'text');
                }
            }
            i = gt + 1;
            continue;
        }

        if (xmlText.startsWith('<!', lt)) {
            const gt = xmlText.indexOf('>', lt + 2);
            i = gt >= 0 ? gt + 1 : xmlText.length;
            continue;
        }

        const gt = findTagEnd(xmlText, lt + 1);
        if (gt < 0) {
            break;
        }

        const tagBody = xmlText.slice(lt + 1, gt);
        const selfClosing = /\/\s*$/.test(tagBody);
        const content = selfClosing ? tagBody.replace(/\/\s*$/, '') : tagBody;
        const nameMatch = content.trim().match(/^([^\s/>]+)/);
        if (!nameMatch) {
            i = gt + 1;
            continue;
        }
        const name = nameMatch[1];

        const parent = stack[stack.length - 1];
        if (parent) {
            parent.hasChildElement = true;
        }

        const siblingCounter = parent ? parent.childNameCount : rootCounter;
        const index = siblingCounter.get(name) ?? 0;
        siblingCounter.set(name, index + 1);

        const elementTokens = [
            ...(parent ? parent.tokens : []),
            name,
            ...(index > 0 ? [`[${index}]`] : [])
        ];

        const attrsText = content.slice(content.indexOf(name) + name.length);
        const attrRegex = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
        let match: RegExpExecArray | null;
        while ((match = attrRegex.exec(attrsText))) {
            const attrName = match[1];
            const quoted = match[2];
            const rawValue = match[3] ?? match[4] ?? '';
            const valueOffset = match.index + match[0].indexOf(quoted) + 1;
            const start = lt + 1 + (content.indexOf(name) + name.length) + valueOffset;
            const end = start + rawValue.length;

            pushParameter(
                output,
                filePath,
                [...elementTokens, `@${attrName}`],
                rawValue,
                start,
                end,
                'attribute'
            );
        }

        if (!selfClosing) {
            stack.push({
                name,
                tokens: elementTokens,
                childNameCount: new Map(),
                hasChildElement: false,
                textSegments: []
            });
        }

        i = gt + 1;
    }

    return output;
}

function captureTextSegment(xmlText: string, start: number, end: number, stack: StackNode[]): void {
    if (end <= start || stack.length === 0) {
        return;
    }
    const top = stack[stack.length - 1];
    top.textSegments.push({ start, end, raw: xmlText.slice(start, end) });
}

function pushParameter(
    output: InternalParameter[],
    filePath: string,
    tokens: string[],
    value: string,
    start: number,
    end: number,
    kind: 'text' | 'attribute'
): void {
    const parameterPath = tokensToPath(tokens);
    output.push({
        id: `${filePath}::${parameterPath}`,
        filePath,
        fileName: filePath.split(/[\\/]/).pop() ?? filePath,
        parameterPath,
        value,
        tokens,
        start,
        end,
        kind
    });
}

function tokensToPath(tokens: string[]): string {
    return tokens
        .map(token => (token.startsWith('[') || token.startsWith('@') ? token : `/${token}`))
        .join('')
        .replace(/^\//, '');
}

function findTagEnd(xmlText: string, from: number): number {
    let quote: '"' | "'" | undefined;
    for (let i = from; i < xmlText.length; i += 1) {
        const char = xmlText[i];
        if (quote) {
            if (char === quote) {
                quote = undefined;
            }
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (char === '>') {
            return i;
        }
    }
    return -1;
}

function escapeXmlText(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function escapeXmlAttribute(value: string): string {
    return escapeXmlText(value)
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function offsetToPosition(text: string, offset: number): { line: number; character: number } {
    let line = 0;
    let lineStart = 0;

    for (let i = 0; i < offset && i < text.length; i += 1) {
        if (text[i] === '\n') {
            line += 1;
            lineStart = i + 1;
        }
    }

    return {
        line,
        character: Math.max(0, offset - lineStart)
    };
}
