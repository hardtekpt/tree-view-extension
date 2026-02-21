import * as fs from 'fs';
import * as path from 'path';
import { getOutputFilenameParsers } from '../../config';
import { existsDir } from '../../utils/fileSystem';
import { toPathKey } from '../../utils/pathKey';
import { parseFilenameWithParsers, type ParsedFilenameMetadata } from './filenameMetadata';

export interface ParsedOutputFileMetadata extends ParsedFilenameMetadata {
    filePath: string;
    relativePath: string;
    fileName: string;
}

export interface ParsedOutputFolderMetadata extends ParsedFilenameMetadata {
    folderPath: string;
    relativePath: string;
    folderName: string;
}

export class OutputMetadataResolver {
    private readonly cache = new Map<string, { mtimeMs: number; metadata?: ParsedFilenameMetadata }>();

    getParsedOutputMetadataForRun(runPath: string): ParsedOutputFileMetadata[] {
        if (!existsDir(runPath)) {
            return [];
        }
        const parsers = getOutputFilenameParsers();
        if (parsers.length === 0) {
            return [];
        }

        const files = listFilesRecursively(runPath);
        const results: ParsedOutputFileMetadata[] = [];
        for (const filePath of files) {
            const metadata = this.getOrParseOutputMetadata(filePath, parsers, 'file');
            if (!metadata) {
                continue;
            }
            results.push({
                ...metadata,
                filePath,
                fileName: path.basename(filePath),
                relativePath: path.relative(runPath, filePath)
            });
        }
        return results;
    }

    getParsedOutputFolderMetadataForRun(runPath: string): ParsedOutputFolderMetadata[] {
        if (!existsDir(runPath)) {
            return [];
        }
        const parsers = getOutputFilenameParsers();
        if (parsers.length === 0) {
            return [];
        }

        const folders = listFoldersRecursively(runPath);
        const results: ParsedOutputFolderMetadata[] = [];
        for (const folderPath of folders) {
            const metadata = this.getOrParseOutputMetadata(folderPath, parsers, 'folder');
            if (!metadata) {
                continue;
            }
            results.push({
                ...metadata,
                folderPath,
                folderName: path.basename(folderPath),
                relativePath: path.relative(runPath, folderPath)
            });
        }
        return results;
    }

    private getOrParseOutputMetadata(
        filePath: string,
        parsers: ReturnType<typeof getOutputFilenameParsers>,
        entryType: 'file' | 'folder'
    ): ParsedFilenameMetadata | undefined {
        let stat: fs.Stats;
        try {
            stat = fs.statSync(filePath);
        } catch {
            return undefined;
        }

        const cacheKey = toPathKey(filePath);
        const cached = this.cache.get(cacheKey);
        if (cached && cached.mtimeMs === stat.mtimeMs) {
            return cached.metadata;
        }

        const metadata = parseFilenameWithParsers(filePath, parsers, entryType);
        this.cache.set(cacheKey, { mtimeMs: stat.mtimeMs, metadata });
        return metadata;
    }
}

function listFilesRecursively(rootPath: string): string[] {
    const files: string[] = [];
    const visit = (currentPath: string): void => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(currentPath, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const entryPath = path.join(currentPath, entry.name);
            if (entry.isDirectory()) {
                visit(entryPath);
                continue;
            }
            files.push(entryPath);
        }
    };
    visit(rootPath);
    return files;
}

function listFoldersRecursively(rootPath: string): string[] {
    const folders: string[] = [];
    const visit = (currentPath: string): void => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(currentPath, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            const entryPath = path.join(currentPath, entry.name);
            folders.push(entryPath);
            visit(entryPath);
        }
    };
    visit(rootPath);
    return folders;
}
