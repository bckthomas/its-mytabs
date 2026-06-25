import { checkAudioFormat, checkFilename, flacToOgg, importDir, normalizeDirName, normalizeFileName, tabDir } from "./util.ts";
import * as fs from "@std/fs";
import * as path from "@std/path";
import { AudioData, AudioDataSchema, ConfigJSON, ConfigJSONSchema, SyncRequest, TabInfo, TabInfoSchema, UpdateTabFav, UpdateTabInfo, Youtube, YoutubeSchema } from "./zod.ts";
import { kv } from "./db.ts";
import { supportedFormatList, supportedAudioFormatList } from "./common.ts";

const updateQueues = new Map<string, Promise<ConfigJSON>>();
const tabLocationCache = new Map<string, { type: "old" | "new"; configPath: string; dir: string }>();

type ImportTabsOptions = {
    importDuplicates?: boolean;
    dryRun?: boolean;
    maxDuplicateSamples?: number;
};

type ImportTabsResult = {
    importedCount: number;
    skippedCount: number;
    duplicateCount: number;
    duplicateSamples: string[];
};

type TabLocation = {
    type: "old" | "new";
    configPath: string;
    dir: string;
};

function isDeletedPath(filePath: string): boolean {
    return filePath.split(path.SEPARATOR).includes("deleted");
}

async function findConfigPathByTabId(id: string): Promise<string | null> {
    for await (const entry of fs.walk(tabDir, { includeDirs: false })) {
        if (!entry.isFile) continue;
        if (isDeletedPath(entry.path)) continue;
        if (!entry.name.toLowerCase().endsWith(".json")) continue;

        try {
            const content = await Deno.readTextFile(entry.path);
            const data = JSON.parse(content);
            if (data && typeof data === "object" && data.tab && String(data.tab.id) === id) {
                return entry.path;
            }
        } catch {
            // ignore invalid JSON
        }
    }
    return null;
}

async function resolveTabLocation(id: string): Promise<TabLocation> {
    checkFilename(id);

    const cached = tabLocationCache.get(id);
    if (cached) {
        return cached;
    }

    const oldConfigPath = path.join(tabDir, id, "config.json");
    if (await fs.exists(oldConfigPath)) {
        const location: TabLocation = { type: "old", configPath: oldConfigPath, dir: path.join(tabDir, id) };
        tabLocationCache.set(id, location);
        return location;
    }

    const configPath = await findConfigPathByTabId(id);
    if (configPath) {
        const location: TabLocation = { type: "new", configPath, dir: path.dirname(configPath) };
        tabLocationCache.set(id, location);
        return location;
    }

    throw new Error("Tab not found");
}

export async function getConfigJSONPath(id: string): Promise<string> {
    const location = await resolveTabLocation(id);
    return location.configPath;
}

async function getTabFolderPathById(id: string): Promise<string> {
    const location = await resolveTabLocation(id);
    return location.dir;
}

export async function getTabFolderPath(tab: TabInfo): Promise<string> {
    return await getTabFolderPathById(tab.id);
}

export async function getTabFolderFullPath(tab: TabInfo): Promise<string> {
    const folder = await getTabFolderPath(tab);
    return path.resolve(folder);
}

export async function getTabFilePath(tab: TabInfo): Promise<string> {
    const folder = await getTabFolderPath(tab);
    return path.join(folder, tab.filename);
}

export async function getTabFullFilePath(tab: TabInfo): Promise<string> {
    const fullPath = await getTabFilePath(tab);
    return path.resolve(fullPath);
}

async function getUniqueFileName(dir: string, base: string, ext: string): Promise<string> {
    let candidate = `${base}.${ext}`;
    let i = 1;
    while (await fs.exists(path.join(dir, candidate))) {
        candidate = `${base}-${i}.${ext}`;
        i += 1;
    }
    return candidate;
}

function isValidGPString(value: string): boolean {
    if (!value || value.length === 0) return false;
    if (value.length > 200) return false; // Sanity check
    // Check if mostly printable ASCII or valid Unicode
    let validChars = 0;
    for (const char of value) {
        const code = char.charCodeAt(0);
        // Allow ASCII printables, common accented chars, and spaces
        if ((code >= 32 && code <= 126) || code >= 160) {
            validChars++;
        }
    }
    return validChars > value.length * 0.8; // At least 80% valid chars
}

function parseStringFromBuffer(buffer: Uint8Array, offset: number): { value: string; newOffset: number } | null {
    if (offset >= buffer.length) return null;

    // Read 4-byte length (little-endian int32)
    if (offset + 4 > buffer.length) return null;
    const length = buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16) | (buffer[offset + 3] << 24);

    // Strict length validation
    if (length <= 0 || length > 500) return null; // Much stricter limit
    if (offset + 4 + length > buffer.length) return null;

    const stringBytes = buffer.slice(offset + 4, offset + 4 + length);
    const decoder = new TextDecoder("latin1");
    let value = "";
    try {
        value = decoder.decode(stringBytes).replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim();
    } catch {
        return null;
    }

    const newOffset = offset + 4 + length;

    // Keep scanning even if this field is empty or noisy.
    if (!value) {
        return { value: "", newOffset };
    }

    // Invalid field content should be ignored, not stop metadata parsing.
    if (!isValidGPString(value)) {
        return { value: "", newOffset };
    }

    return { value, newOffset };
}

async function parseGuitarProMetadata(filePath: string): Promise<{ title: string; artist: string } | null> {
    try {
        // Read a larger header block because some GP3/GP5 files store metadata farther.
        const maxReadBytes = 64 * 1024;
        const fileData = await Deno.readFile(filePath);
        const buffer = fileData.length > maxReadBytes ? fileData.slice(0, maxReadBytes) : fileData;
        const bytesRead = buffer.length;

        if (!bytesRead || bytesRead < 100) return null;

        // Look for "FICHIER GUITAR PRO" header (more flexible)
        const headerBytes = buffer.slice(0, 100);
        const decoder = new TextDecoder("latin1");
        const headerStr = decoder.decode(headerBytes);

        if (!headerStr.includes("FICHIER GUITAR PRO")) {
            return null;
        }

        // Find "FICHIER GUITAR PRO" and start parsing around it.
        // GP variants place metadata fields at slightly different offsets.
        const headerIndex = headerStr.indexOf("FICHIER GUITAR PRO");
        if (headerIndex === -1) return null;

        const offsetCandidates: number[] = [];
        for (let offset = headerIndex + 20; offset <= headerIndex + 120; offset++) {
            offsetCandidates.push(offset);
        }

        for (const startOffset of offsetCandidates) {
            if (startOffset + 8 > buffer.length) {
                continue;
            }

            const fields: string[] = [];
            let cursor = startOffset;

            // Parse several consecutive length-prefixed strings.
            for (let i = 0; i < 12; i++) {
                const result = parseStringFromBuffer(buffer, cursor);
                if (!result) {
                    break;
                }
                cursor = result.newOffset;
                const cleaned = result.value.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim();
                if (cleaned) {
                    fields.push(cleaned);
                }
            }

            if (fields.length < 3) {
                continue;
            }

            // Common GP layout: title, subtitle, artist, album, ...
            const title = fields[0];
            const artistCandidates = [fields[1], fields[2], fields[3], fields[4]].filter(Boolean) as string[];
            const artist = artistCandidates.find((candidate) => !candidate.toLowerCase().includes("tab by")) || artistCandidates[0];

            if (title && artist) {
                console.log(`Parsed GP metadata: artist="${artist}", title="${title}"`);
                return { title, artist };
            }
        }

        return null;
    } catch (e) {
        console.error(`Failed to parse GP metadata from ${filePath}:`, e);
        return null;
    }
}

function parseImportArtistTitle(filename: string): { artist: string; title: string } {
    const heuristics = [" - ", " -- ", "__", " -", "-_", "~"];
    for (const sep of heuristics) {
        if (filename.includes(sep)) {
            const [artist, ...rest] = filename.split(sep);
            const title = rest.join(sep);
            if (artist && title) {
                return { artist: artist.trim(), title: title.trim() };
            }
        }
    }
    // No separator found - convert snake_case/kebab-case to TitleCase
    const titleWithSpaces = filename.replace(/[_-]/g, " ");
    const titleCase = titleWithSpaces
        .split(" ")
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(" ");
    return { artist: "Unknown Artist", title: titleCase };
}

function isUnknownLikeArtist(value: string): boolean {
    const normalized = value
        .toLowerCase()
        .replaceAll("_", " ")
        .replaceAll("-", " ")
        .replace(/\s+/g, " ")
        .trim();
    return normalized === "unknown" || normalized === "unknown artist" || normalized === "unknow" || normalized === "unknow artist";
}

function makeTitleKey(title: string): string {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .replace(/[0-9]+$/g, "")
        .trim();
}

async function inferArtistFromExistingTabs(title: string): Promise<string | null> {
    const key = makeTitleKey(title);
    if (!key) {
        return null;
    }

    const artistCount = new Map<string, number>();
    const configPaths = await findAllTabConfigPaths();
    for (const configPath of configPaths) {
        try {
            const content = await Deno.readTextFile(configPath);
            const data = JSON.parse(content);
            const config = ConfigJSONSchema.parse(data);

            const artist = (config.tab.artist || "").trim();
            if (!artist || isUnknownLikeArtist(artist)) {
                continue;
            }

            const tabKey = makeTitleKey(config.tab.title || "");
            if (!tabKey || tabKey !== key) {
                continue;
            }

            artistCount.set(artist, (artistCount.get(artist) || 0) + 1);
        } catch {
            // ignore malformed files
        }
    }

    let bestArtist: string | null = null;
    let bestCount = 0;
    for (const [artist, count] of artistCount.entries()) {
        if (count > bestCount) {
            bestArtist = artist;
            bestCount = count;
        }
    }
    return bestArtist;
}

async function getImportTabLocation(filePath: string): Promise<{ artist: string; title: string }> {
    const relPath = path.relative(importDir, filePath);
    const parts = relPath.split(path.SEPARATOR).filter(Boolean);
    const ext = path.extname(filePath);
    const extWithoutDot = ext.slice(1).toLowerCase();
    const baseFilename = path.basename(filePath, ext);
    let title = baseFilename;
    let artist = "Unknown Artist";
    const parsedFromFilename = parseImportArtistTitle(baseFilename);

    // Try to extract metadata from Guitar Pro files first.
    let metadata: { title: string; artist: string } | null = null;
    if (["gp", "gp3", "gp4", "gp5", "gpx"].includes(extWithoutDot)) {
        metadata = await parseGuitarProMetadata(filePath);
        if (metadata?.title) {
            title = metadata.title;
        }
    }

    const folderArtist = parts.length > 1 ? parts[0].trim() : "";

    // Prefer metadata artist for GP files, especially when folder names are placeholders.
    if (metadata?.artist && !isUnknownLikeArtist(metadata.artist)) {
        artist = metadata.artist;
    } else if (folderArtist && !isUnknownLikeArtist(folderArtist)) {
        artist = folderArtist;
    } else if (metadata?.artist) {
        artist = metadata.artist;
    } else {
        artist = parsedFromFilename.artist;
        title = parsedFromFilename.title;

        if (isUnknownLikeArtist(artist)) {
            const inferredArtist = await inferArtistFromExistingTabs(title);
            if (inferredArtist) {
                artist = inferredArtist;
            }
        }
    }

    if (!title) {
        title = `tab-${Date.now()}`;
    }

    // Final sanity check: ensure title is reasonable length
    if (title.length > 200) {
        title = title.substring(0, 200);
    }

    return { artist: normalizeDirName(artist), title };
}

async function isDirEmpty(dir: string): Promise<boolean> {
    for await (const _ of Deno.readDir(dir)) {
        return false;
    }
    return true;
}

async function removeEmptyImportDirs(dir: string): Promise<void> {
    for await (const entry of Deno.readDir(dir)) {
        if (!entry.isDirectory) continue;
        const childDir = path.join(dir, entry.name);
        await removeEmptyImportDirs(childDir);
        if (await isDirEmpty(childDir)) {
            await Deno.remove(childDir);
        }
    }
}

async function toHex(buffer: ArrayBuffer): Promise<string> {
    return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashFileData(data: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
    return await toHex(digest);
}

async function buildExistingTabHashSet(): Promise<Set<string>> {
    const hashes = new Set<string>();
    const configPaths = await findAllTabConfigPaths();

    for (const configPath of configPaths) {
        try {
            const content = await Deno.readTextFile(configPath);
            const data = JSON.parse(content);
            const config = ConfigJSONSchema.parse(data);
            const dirPath = path.dirname(configPath);
            const tabPath = path.join(dirPath, config.tab.filename);

            if (!await fs.exists(tabPath)) {
                continue;
            }

            const tabFileData = await Deno.readFile(tabPath);
            hashes.add(await hashFileData(tabFileData));
        } catch {
            // ignore malformed config/file
        }
    }

    return hashes;
}

export async function importTabsFromImportDir(options: ImportTabsOptions = {}): Promise<ImportTabsResult> {
    const importDuplicates = options.importDuplicates ?? false;
    const dryRun = options.dryRun ?? false;
    const maxDuplicateSamples = options.maxDuplicateSamples ?? 20;

    let importedCount = 0;
    let skippedCount = 0;
    let duplicateCount = 0;
    const duplicateSamples: string[] = [];
    const existingHashes = await buildExistingTabHashSet();

    for await (const entry of fs.walk(importDir, { includeDirs: false })) {
        if (!entry.isFile) continue;
        const ext = path.extname(entry.name).slice(1).toLowerCase();
        if (!supportedFormatList.includes(ext)) continue;

        try {
            const fileData = await Deno.readFile(entry.path);
            const hash = await hashFileData(fileData);
            const isDuplicate = existingHashes.has(hash);

            if (isDuplicate) {
                duplicateCount += 1;
                if (duplicateSamples.length < maxDuplicateSamples) {
                    duplicateSamples.push(entry.name);
                }
                if (!importDuplicates) {
                    skippedCount += 1;
                    continue;
                }
            }

            const { artist, title } = await getImportTabLocation(entry.path);
            if (!dryRun) {
                await createTab(fileData, ext, title, artist, entry.name);
                await Deno.remove(entry.path);
            }
            existingHashes.add(hash);
            importedCount += 1;
        } catch (e) {
            console.error(`Failed importing ${entry.path}:`, e);
            skippedCount += 1;
        }
    }

    if (!dryRun) {
        await removeEmptyImportDirs(importDir);
    }
    console.log(`Imported ${importedCount} files from import folder, skipped ${skippedCount}, duplicates ${duplicateCount}.`);
    return { importedCount, skippedCount, duplicateCount, duplicateSamples };
}

async function findTabFile(dirPath: string): Promise<string | null> {
    for await (const entry of Deno.readDir(dirPath)) {
        if (!entry.isFile) continue;
        const ext = path.extname(entry.name).slice(1).toLowerCase();
        if (supportedFormatList.includes(ext)) {
            return entry.name;
        }
    }
    return null;
}

async function findAllTabConfigPaths(): Promise<string[]> {
    const paths: string[] = [];
    for await (const entry of fs.walk(tabDir, { includeDirs: false })) {
        if (!entry.isFile) continue;
        if (isDeletedPath(entry.path)) continue;
        if (!entry.name.toLowerCase().endsWith(".json")) continue;
        paths.push(entry.path);
    }
    return paths;
}

async function findAudioFiles(dirPath: string): Promise<string[]> {
    const files: string[] = [];
    for await (const entry of Deno.readDir(dirPath)) {
        if (!entry.isFile) continue;
        const ext = path.extname(entry.name).slice(1).toLowerCase();
        if (supportedAudioFormatList.includes(ext)) {
            files.push(entry.name);
        }
    }
    return files;
}

export async function getConfigJSON(id: string, excludeAudio = false): Promise<ConfigJSON | null> {
    const location = await resolveTabLocation(id);
    const configPath = location.configPath;

    if (await fs.exists(configPath)) {
        try {
            const content = await Deno.readTextFile(configPath);
            const data = JSON.parse(content);
            const config = ConfigJSONSchema.parse(data);
            config.tab.id = id;

            if (!excludeAudio) {
                const dirPath = location.dir;
                const audioFiles = await findAudioFiles(dirPath);
                config.audio = audioFiles.map((filename) => {
                    const meta = config.audio.find((a: AudioData) => a.filename === filename);
                    if (meta) {
                        return meta;
                    }
                    return AudioDataSchema.parse({ filename });
                });
            }

            return config;
        } catch (e) {
            console.error(`Failed to read config JSON for tab ${id}:`, e);
            return null;
        }
    }
    return null;
}

async function writeConfigFilePath(configPath: string, config: ConfigJSON): Promise<void> {
    await Deno.writeTextFile(configPath, JSON.stringify(config, null, 2));
}

async function writeConfigJSON(id: string, config: ConfigJSON): Promise<void> {
    const configPath = await getConfigJSONPath(id);
    await writeConfigFilePath(configPath, config);
}

export async function tabExists(id: string): Promise<boolean> {
    try {
        const configPath = await getConfigJSONPath(id);
        return await fs.exists(configPath);
    } catch {
        return false;
    }
}

export async function checkTabExists(id: string): Promise<void> {
    if (!await tabExists(id)) {
        throw new Error("Tab not found");
    }
}

export async function getAllTabs(): Promise<TabInfo[]> {
    const tabsById = new Map<string, TabInfo>();
    const configPaths = await findAllTabConfigPaths();

    for (const configPath of configPaths) {
        try {
            const content = await Deno.readTextFile(configPath);
            const data = JSON.parse(content);
            const config = ConfigJSONSchema.parse(data);
            tabsById.set(config.tab.id, config.tab);
        } catch {
            // ignore invalid or irrelevant JSON files
        }
    }

    const tabs = Array.from(tabsById.values());
    tabs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return tabs;
}

export async function createTab(tabFileData: Uint8Array, ext: string, title: string, artist: string, originalFilename: string) {
    const id = await getNextTabID();
    const safeArtist = normalizeDirName(artist || "Unknown Artist");
    const artistDir = path.join(tabDir, safeArtist);
    await fs.ensureDir(artistDir);

    const baseTitle = normalizeFileName(title || path.basename(originalFilename, path.extname(originalFilename)));
    const filename = await getUniqueFileName(artistDir, baseTitle, ext);
    const configFilename = await getUniqueFileName(artistDir, path.basename(filename, path.extname(filename)), "json");
    const configPath = path.join(artistDir, configFilename);

    await Deno.writeFile(path.join(artistDir, filename), tabFileData);

    const tab: TabInfo = TabInfoSchema.parse({
        id: id.toString(),
        title,
        artist,
        filename,
        originalFilename,
        createdAt: new Date().toISOString(),
        public: false,
        fav: false,
    });

    const info: ConfigJSON = { tab, audio: [], youtube: [] };
    await writeConfigFilePath(configPath, info);
    tabLocationCache.set(tab.id, { type: "new", configPath, dir: artistDir });

    return id.toString();
}

export async function writeTabInfo(tab: TabInfo) {
    await updateConfigJSON(tab.id, async (config) => {
        config.tab = tab;
    });
}

export async function getTab(id: string): Promise<TabInfo> {
    const config = await getConfigJSON(id, true);
    if (config) {
        return config.tab;
    }
    throw new Error("Tab not found");
}

export async function getOrCreateTab(id: string): Promise<TabInfo | null> {
    try {
        return await getTab(id);
    } catch {
        // Continue for old-style directories
    }

    const dirPath = path.join(tabDir, id);
    if (!await fs.exists(dirPath)) {
        return null;
    }

    const tabFile = await findTabFile(dirPath);
    if (!tabFile) {
        return null;
    }

    const tab: TabInfo = TabInfoSchema.parse({
        id,
        title: id,
        artist: "",
        filename: tabFile,
        originalFilename: tabFile,
        createdAt: new Date().toISOString(),
        public: false,
        fav: false,
    });

    const newConfig: ConfigJSON = { tab, audio: [], youtube: [] };
    const configPath = path.join(dirPath, "config.json");
    await writeConfigFilePath(configPath, newConfig);
    tabLocationCache.set(id, { type: "old", configPath, dir: dirPath });
    return tab;
}

export async function fixMissingTab(config: ConfigJSON): Promise<ConfigJSON> {
    const filePath = await getTabFullFilePath(config.tab);
    if (await fs.exists(filePath)) {
        return config;
    }

    const folder = await getTabFolderFullPath(config.tab);
    const tabFile = await findTabFile(folder);
    if (!tabFile) {
        return config;
    }

    return await updateConfigJSON(config.tab.id, async (cfg) => {
        cfg.tab.filename = tabFile;
    });
}

export async function replaceTab(tab: TabInfo, tabFileData: Uint8Array, ext: string, originalFilename: string) {
    const folder = await getTabFolderPath(tab);
    const oldFilePath = path.join(folder, tab.filename);
    const renamedOldFilePath = oldFilePath + "." + Date.now().toString();
    await Deno.rename(oldFilePath, renamedOldFilePath);

    const filename = "tab." + ext;
    const newFilePath = path.join(folder, filename);
    await Deno.writeFile(newFilePath, tabFileData);

    tab.filename = filename;
    tab.originalFilename = originalFilename;
    await writeTabInfo(tab);
}

export async function getNextTabID(): Promise<number> {
    while (true) {
        const nextID = await getNextID();
        const dir = path.join(tabDir, nextID.toString());

        if (!await fs.exists(dir)) {
            return nextID;
        }
        console.log(`Tab directory ${dir} already exists, trying next ID`);
    }
}

async function getNextID(): Promise<number> {
    while (true) {
        const key = ["counter", "tab_id"];
        const res = await kv.get<Deno.KvU64>(key);
        const current = res.value || new Deno.KvU64(0n);
        const next = new Deno.KvU64(current.value + 1n);
        const commit = await kv.atomic()
            .check({ key, versionstamp: res.versionstamp })
            .mutate({ type: "set", key, value: next })
            .commit();
        if (commit.ok) {
            return Number(next.value);
        }
    }
}

export async function updateTab(tab: TabInfo, data: UpdateTabInfo) {
    tab.title = data.title;
    tab.artist = data.artist;
    tab.public = data.public;
    await writeTabInfo(tab);
}

export async function updateTabFav(tab: TabInfo, data: UpdateTabFav) {
    tab.fav = data.fav;
    await writeTabInfo(tab);
}

export async function deleteTab(id: string) {
    const location = await resolveTabLocation(id);

    if (location.type === "old") {
        const oldPath = location.dir;
        const newPath = path.join(tabDir, "deleted", id + "-" + Date.now().toString());
        await fs.ensureDir(path.join(tabDir, "deleted"));
        await Deno.rename(oldPath, newPath);
        return;
    }

    const config = await getConfigJSON(id, true);
    if (!config) {
        throw new Error("Tab not found");
    }

    const folder = location.dir;
    const tabFile = path.join(folder, config.tab.filename);
    if (await fs.exists(tabFile)) {
        await Deno.remove(tabFile);
    }
    for (const audio of config.audio) {
        const audioPath = path.join(folder, audio.filename);
        if (await fs.exists(audioPath)) {
            await Deno.remove(audioPath);
        }
    }
    if (await fs.exists(location.configPath)) {
        await Deno.remove(location.configPath);
    }

    if (await isDirEmpty(folder)) {
        await Deno.remove(folder);
    }
}

export async function addAudio(tab: TabInfo, audioFileData: Uint8Array, originalFilename: string) {
    checkAudioFormat(originalFilename);
    checkFilename(originalFilename);

    let filename = normalizeFileName(originalFilename);
    const tabDirPath = await getTabFolderPath(tab);

    if (filename.toLowerCase().endsWith(".flac")) {
        const lastDotIndex = filename.lastIndexOf(".");
        filename = filename.substring(0, lastDotIndex) + ".ogg";
        audioFileData = await flacToOgg(audioFileData);
    }

    const base = path.basename(filename, path.extname(filename));
    const ext = path.extname(filename).slice(1);
    filename = await getUniqueFileName(tabDirPath, base, ext);
    const filePath = path.join(tabDirPath, filename);

    await Deno.writeFile(filePath, audioFileData);
}

export async function removeAudio(tab: TabInfo, filename: string) {
    checkAudioFormat(filename);
    checkFilename(filename);

    const tabDirPath = await getTabFolderPath(tab);
    const filePath = path.join(tabDirPath, filename);
    if (!await fs.exists(filePath)) {
        throw new Error("Audio file not found");
    }

    await Deno.remove(filePath);

    await updateConfigJSON(tab.id, async (config) => {
        config.audio = config.audio.filter((a: AudioData) => a.filename !== filename);
    });
}

export async function updateConfigJSON(id: string, callback: (config: ConfigJSON) => Promise<void>) {
    const queue = updateQueues.get(id) || Promise.resolve();
    const newQueue = queue.then(async () => {
        const config = await getConfigJSON(id, true);
        if (!config) {
            throw new Error("Tab not found");
        }
        await callback(config);
        await writeConfigJSON(id, config);
        return config;
    });
    updateQueues.set(id, newQueue);
    return newQueue;
}

export async function updateAudio(tab: TabInfo, filename: string, data: SyncRequest) {
    checkAudioFormat(filename);
    checkFilename(filename);

    const tabDirPath = await getTabFolderPath(tab);
    const filePath = path.join(tabDirPath, filename);
    if (!await fs.exists(filePath)) {
        throw new Error("Audio file not found");
    }

    await updateConfigJSON(tab.id, async (config) => {
        const existingIndex = config.audio.findIndex((a: AudioData) => a.filename === filename);
        const audioData = AudioDataSchema.parse({ filename, ...data });

        if (existingIndex >= 0) {
            config.audio[existingIndex] = audioData;
        } else {
            config.audio.push(audioData);
        }
    });
}

export async function addYoutube(id: string, videoID: string) {
    await updateConfigJSON(id, async (config) => {
        if (config.youtube.some((y: Youtube) => y.videoID === videoID)) {
            throw new Error("YouTube video already exists");
        }
        config.youtube.push(YoutubeSchema.parse({ videoID }));
    });
}

export async function updateYoutube(id: string, videoID: string, data: SyncRequest) {
    await updateConfigJSON(id, async (config) => {
        const existingIndex = config.youtube.findIndex((y: Youtube) => y.videoID === videoID);
        const youtubeData = YoutubeSchema.parse({ videoID, ...data });

        if (existingIndex >= 0) {
            config.youtube[existingIndex] = youtubeData;
        } else {
            config.youtube.push(youtubeData);
        }
    });
}

export async function removeYoutube(id: string, videoID: string) {
    await updateConfigJSON(id, async (config) => {
        config.youtube = config.youtube.filter((y: Youtube) => y.videoID !== videoID);
    });
}

export async function migrateStorage() {
    let migratedCount = 0;
    let skippedCount = 0;

    for await (const entry of Deno.readDir(tabDir)) {
        if (!entry.isDirectory || entry.name === "deleted") continue;
        const id = entry.name;

        // Only migrate if ID looks like old numeric format
        if (isNaN(Number(id))) {
            // Likely new format (artist name), skip migration
            continue;
        }

        const oldDir = path.join(tabDir, id);
        const oldConfigPath = path.join(oldDir, "config.json");
        let config: ConfigJSON | null = null;

        if (await fs.exists(oldConfigPath)) {
            try {
                const raw = await Deno.readTextFile(oldConfigPath);
                config = ConfigJSONSchema.parse(JSON.parse(raw));
            } catch {
                skippedCount++;
                continue;
            }
        }

        const tabFileName = config?.tab.filename || await findTabFile(oldDir);
        if (!tabFileName) {
            skippedCount++;
            continue;
        }

        if (!config) {
            const titleBase = path.basename(tabFileName, path.extname(tabFileName));
            config = ConfigJSONSchema.parse({
                tab: {
                    id,
                    title: titleBase,
                    artist: "",
                    filename: tabFileName,
                    originalFilename: tabFileName,
                    createdAt: new Date().toISOString(),
                    public: false,
                    fav: false,
                },
                audio: [],
                youtube: [],
            });
        }

        const tabFilePath = path.join(oldDir, tabFileName);
        if (!await fs.exists(tabFilePath)) {
            skippedCount++;
            continue;
        }

        const safeArtist = normalizeDirName(config.tab.artist || "Unknown Artist");
        const artistDir = path.join(tabDir, safeArtist);
        await fs.ensureDir(artistDir);

        const baseTitle = normalizeFileName(config.tab.title || path.basename(tabFileName, path.extname(tabFileName)));
        const ext = path.extname(tabFileName).slice(1).toLowerCase();
        const newTabFilename = await getUniqueFileName(artistDir, baseTitle, ext);
        const newConfigFilename = await getUniqueFileName(artistDir, path.basename(newTabFilename, path.extname(newTabFilename)), "json");
        const newTabPath = path.join(artistDir, newTabFilename);
        const newConfigPath = path.join(artistDir, newConfigFilename);

        await Deno.copyFile(tabFilePath, newTabPath);
        config.tab.filename = newTabFilename;
        config.tab.artist = config.tab.artist || "";

        const migratedAudio: AudioData[] = [];
        for (const audio of config.audio) {
            const oldAudioPath = path.join(oldDir, audio.filename);
            if (!await fs.exists(oldAudioPath)) {
                continue;
            }
            const audioBase = normalizeFileName(path.basename(audio.filename, path.extname(audio.filename)));
            const audioExt = path.extname(audio.filename).slice(1).toLowerCase();
            const newAudioFilename = await getUniqueFileName(artistDir, audioBase, audioExt);
            await Deno.copyFile(oldAudioPath, path.join(artistDir, newAudioFilename));
            migratedAudio.push(AudioDataSchema.parse({ ...audio, filename: newAudioFilename }));
        }
        config.audio = migratedAudio;

        await writeConfigFilePath(newConfigPath, config);
        await Deno.remove(oldDir, { recursive: true });

        migratedCount++;
    }

    console.log(`Storage migration complete: ${migratedCount} migrated, ${skippedCount} skipped.`);
    return { migratedCount, skippedCount };
}
