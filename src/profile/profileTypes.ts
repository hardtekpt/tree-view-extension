export type MetadataFieldType = 'string' | 'number' | 'enum' | 'datetime';

export interface OutputFilenameParserField {
    name: string;
    type: MetadataFieldType;
    enumValues?: string[];
}

export interface OutputFilenameParser {
    id: string;
    pattern: string;
    fields: OutputFilenameParserField[];
    appliesTo?: string[];
    appliesToKind?: 'files' | 'folders' | 'both';
    titleTemplate?: string;
}
