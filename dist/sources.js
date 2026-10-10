import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { CollectorError, isSha } from './contracts.js';
const exec = promisify(execFile);
const decoder = new TextDecoder('utf-8', { fatal: true });
const fieldLimit = 65536;
const filteredSourceMarker = '[filtered source]';
function decode(bytes) {
    try {
        return decoder.decode(bytes);
    }
    catch {
        throw new CollectorError('InvalidGitEncoding');
    }
}
function validatePath(path) {
    return path.length > 0 && path.length <= 4096 && !path.startsWith('/') &&
        !path.split('/').some(part => !part || part === '.' || part === '..') &&
        !/[\u0000-\u001f\u007f]/u.test(path);
}
function sensitive(path) {
    const segments = path.toLowerCase().split('/');
    return segments.some((part, index) => part === '.env' || part.startsWith('.env.') ||
        /\.(?:pem|key|crt|cer|cert|p8|p12|pfx|jks|keystore|asc|gpg|kdbx|secret|secrets)$/u.test(part) ||
        /^(?:id_rsa|id_ed25519|id_ecdsa|authorized_keys|known_hosts|credentials|credentials\..+|secrets|secrets\..+|\.npmrc|\.pypirc|\.netrc|\.htpasswd)$/u.test(part) ||
        index < segments.length - 1 && /^(?:\.ssh|\.aws|\.azure|\.gnupg|secrets|credentials)$/u.test(part));
}
function compileGlobs(patterns) {
    if (!Array.isArray(patterns) || patterns.length > 256)
        throw new CollectorError('InvalidIgnorePattern');
    return patterns.map(pattern => {
        if (typeof pattern !== 'string' || !pattern || Buffer.byteLength(pattern, 'utf8') > 1024 ||
            pattern.startsWith('/') || pattern.endsWith('/') || /[\\{}\[\]!\u0000-\u001f\u007f]/u.test(pattern))
            throw new CollectorError('InvalidIgnorePattern');
        const parts = pattern.split('/');
        if (parts.some(part => !part || part === '.' || part === '..' || part.includes('**') && part !== '**'))
            throw new CollectorError('InvalidIgnorePattern');
        return parts;
    });
}
function matchPart(pattern, value) {
    const characters = Array.from(value);
    let previous = new Uint8Array(characters.length + 1);
    previous[0] = 1;
    for (const char of pattern) {
        const current = new Uint8Array(characters.length + 1);
        if (char === '*') {
            current[0] = previous[0];
            for (let valueIndex = 1; valueIndex <= characters.length; valueIndex++)
                current[valueIndex] = previous[valueIndex] || current[valueIndex - 1] ? 1 : 0;
        }
        else {
            for (let valueIndex = 1; valueIndex <= characters.length; valueIndex++)
                current[valueIndex] = previous[valueIndex - 1] && (char === '?' || char === characters[valueIndex - 1]) ? 1 : 0;
        }
        previous = current;
    }
    return previous[characters.length] === 1;
}
function matchGlob(pattern, path) {
    const parts = path.split('/');
    if (pattern.length === 1)
        return parts.some(part => matchPart(pattern[0], part));
    let previous = new Uint8Array(parts.length + 1);
    previous[0] = 1;
    for (const segment of pattern) {
        const current = new Uint8Array(parts.length + 1);
        if (segment === '**') {
            current[0] = previous[0];
            for (let partIndex = 1; partIndex <= parts.length; partIndex++)
                current[partIndex] = previous[partIndex] || current[partIndex - 1] ? 1 : 0;
        }
        else {
            for (let partIndex = 1; partIndex <= parts.length; partIndex++)
                current[partIndex] = previous[partIndex - 1] && matchPart(segment, parts[partIndex - 1]) ? 1 : 0;
        }
        previous = current;
    }
    return previous[parts.length] === 1;
}
function parseChanges(data) {
    if (!data.length)
        return [];
    const fields = data.subarray(0, data.at(-1) === 0 ? -1 : undefined).toString('binary').split('\0');
    const changes = [];
    for (let fieldIndex = 0; fieldIndex < fields.length;) {
        const header = fields[fieldIndex++];
        const match = /^:([0-7]{6}) ([0-7]{6}) [0-9a-f]{40,64} [0-9a-f]{40,64} ([ACDMRTU])([0-9]*)$/u.exec(header);
        if (!match || fieldIndex >= fields.length)
            throw new CollectorError('GitDiffInvalid');
        const first = decode(Buffer.from(fields[fieldIndex++], 'binary'));
        const rename = match[3] === 'R';
        if (rename && fieldIndex >= fields.length)
            throw new CollectorError('GitDiffInvalid');
        const path = rename ? decode(Buffer.from(fields[fieldIndex++], 'binary')) : first;
        if (!validatePath(path) || rename && !validatePath(first))
            throw new CollectorError('UnsafeGitPath');
        const status = match[3] === 'A' ? 'Added' : match[3] === 'D' ? 'Deleted' : rename ? 'Renamed' : 'Modified';
        if (match[3] === 'U')
            throw new CollectorError('GitDiffInvalid');
        changes.push({ path, ...(rename ? { oldPath: first } : {}), status, oldMode: match[1], newMode: match[2] });
    }
    return changes;
}
export class SourceReader {
    checkoutDir;
    globs;
    #excludedValues;
    maxGitBytes;
    stored = new Map();
    collectedGitBytes = 0;
    collecting = false;
    constructor(checkoutDir, options = {}) {
        if (typeof checkoutDir !== 'string' || !checkoutDir)
            throw new CollectorError('CheckoutInvalid');
        this.checkoutDir = resolve(checkoutDir);
        this.globs = compileGlobs(options.ignorePatterns ?? []);
        if (options.excludedValues !== undefined && (!Array.isArray(options.excludedValues) || options.excludedValues.some(value => typeof value !== 'string')))
            throw new CollectorError('ExcludedValuesInvalid');
        this.#excludedValues = (options.excludedValues ?? []).filter(Boolean);
        this.maxGitBytes = options.maxGitBytes ?? 32 * 1024 * 1024;
        if (!Number.isSafeInteger(this.maxGitBytes) || this.maxGitBytes < fieldLimit + 1)
            throw new CollectorError('GitLimitInvalid');
    }
    async git(...args) {
        const remainingBytes = this.maxGitBytes - this.collectedGitBytes;
        if (remainingBytes <= 0)
            throw new CollectorError('GitOutputLimitExceeded');
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
        env.GIT_CONFIG_NOSYSTEM = '1';
        env.GIT_CONFIG_GLOBAL = '/dev/null';
        env.GIT_NO_REPLACE_OBJECTS = '1';
        env.GIT_OPTIONAL_LOCKS = '0';
        env.GIT_LITERAL_PATHSPECS = '1';
        env.GIT_NO_LAZY_FETCH = '1';
        env.LC_ALL = 'C';
        try {
            const { stdout } = await exec('git', args, { cwd: this.checkoutDir, env, encoding: 'buffer', maxBuffer: remainingBytes,
                timeout: 30000, killSignal: 'SIGKILL' });
            const output = Buffer.from(stdout);
            this.collectedGitBytes += output.byteLength;
            return output;
        }
        catch (error) {
            if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
                throw new CollectorError('GitOutputLimitExceeded');
            if (typeof error === 'object' && error !== null && 'killed' in error && error.killed === true)
                throw new CollectorError('GitCommandTimedOut');
            throw new CollectorError('GitCommandFailed');
        }
    }
    hasCredential(value) {
        return this.#excludedValues.some(secret => value.includes(secret));
    }
    async verifyCheckout() {
        const stat = await lstat(this.checkoutDir).catch(() => { throw new CollectorError('CheckoutInvalid'); });
        if (!stat.isDirectory() || stat.isSymbolicLink())
            throw new CollectorError('CheckoutInvalid');
        const actual = await realpath(this.checkoutDir);
        const top = decode(await this.git('rev-parse', '--show-toplevel')).trimEnd();
        if (await realpath(top).catch(() => '') !== actual)
            throw new CollectorError('CheckoutInvalid');
        if (decode(await this.git('rev-parse', '--is-inside-work-tree')).trim() !== 'true' ||
            decode(await this.git('rev-parse', '--is-bare-repository')).trim() !== 'false')
            throw new CollectorError('CheckoutInvalid');
    }
    store(path, kind, bytes, fromSha, toSha) {
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const reference = { path, kind, sha256, bytes: bytes.byteLength, fromSha, toSha };
        this.stored.set(JSON.stringify(reference), Uint8Array.from(bytes));
        return reference;
    }
    async collect(fromSha, toSha) {
        if (this.collecting)
            throw new CollectorError('SourceReaderBusy');
        this.collecting = true;
        try {
            return await this.collectInternal(fromSha, toSha);
        }
        catch (error) {
            this.stored.clear();
            throw error;
        }
        finally {
            this.collecting = false;
        }
    }
    async collectInternal(fromSha, toSha) {
        this.stored.clear();
        this.collectedGitBytes = 0;
        if (!isSha(fromSha) || !isSha(toSha))
            throw new CollectorError('InvalidSourceRef');
        await this.verifyCheckout();
        for (const sha of [fromSha, toSha]) {
            if (decode(await this.git('cat-file', '-t', sha)).trim() !== 'commit')
                throw new CollectorError('InvalidSourceRef');
        }
        try {
            await this.git('merge-base', '--is-ancestor', fromSha, toSha);
        }
        catch {
            throw new CollectorError('SourceRangeNotAncestor');
        }
        const commitData = decode(await this.git('log', '--first-parent', '--reverse', '-z', '--format=%H%x00%s', `${fromSha}..${toSha}`));
        const commitFields = commitData.split('\0').filter(Boolean);
        if (commitFields.length % 2)
            throw new CollectorError('GitLogInvalid');
        const commits = [];
        for (let commitIndex = 0; commitIndex < commitFields.length; commitIndex += 2) {
            const sha = commitFields[commitIndex];
            const subject = commitFields[commitIndex + 1].trim();
            if (!isSha(sha))
                throw new CollectorError('GitLogInvalid');
            if (subject && !this.hasCredential(subject))
                commits.push({ sha, subject });
        }
        if (commits.length > 1000)
            throw new CollectorError('InputLimitExceeded');
        const changes = parseChanges(await this.git('diff', '--raw', '-z', '--no-abbrev', '--find-renames', '--no-ext-diff', fromSha, toSha, '--'));
        const files = [];
        const references = [];
        const changedPaths = [];
        let filtered = false;
        for (const change of changes) {
            const { path, oldPath, status } = change;
            if (sensitive(path) || oldPath && sensitive(oldPath) || this.globs.some(glob => matchGlob(glob, path) || oldPath && matchGlob(glob, oldPath)) ||
                this.hasCredential(path) || oldPath && this.hasCredential(oldPath)) {
                filtered = true;
                continue;
            }
            if (change.oldMode === '120000' || change.newMode === '120000' ||
                change.oldMode === '160000' || change.newMode === '160000') {
                filtered = true;
                continue;
            }
            let context = '';
            let content = Buffer.alloc(0);
            let binaryOrCredential = false;
            for (const endpoint of [
                ...(status === 'Added' ? [] : [{ sha: fromSha, path: oldPath ?? path, current: false }]),
                ...(status === 'Deleted' ? [] : [{ sha: toSha, path, current: true }]),
            ]) {
                const blob = await this.git('show', '--no-textconv', `${endpoint.sha}:${endpoint.path}`);
                if (blob.includes(0)) {
                    binaryOrCredential = true;
                    break;
                }
                let text;
                try {
                    text = decode(blob);
                }
                catch {
                    binaryOrCredential = true;
                    break;
                }
                if (this.hasCredential(text)) {
                    binaryOrCredential = true;
                    break;
                }
                if (endpoint.current || status === 'Deleted') {
                    content = blob;
                    context = text;
                }
            }
            if (binaryOrCredential) {
                filtered = true;
                continue;
            }
            const diffBytes = await this.git('diff', '--binary', '--no-ext-diff', '--no-textconv', '--find-renames', fromSha, toSha, '--', ...(oldPath ? [oldPath, path] : [path]));
            let diff;
            try {
                diff = decode(diffBytes);
            }
            catch {
                filtered = true;
                continue;
            }
            if (this.hasCredential(diff) || /(?:^|\n)(?:GIT binary patch|Binary files .* differ)(?:\r?\n|$)/u.test(diff)) {
                filtered = true;
                continue;
            }
            const file = { path, status, diff: '' };
            if (Buffer.byteLength(diff) <= fieldLimit)
                file.diff = diff;
            else
                references.push(this.store(path, 'Diff', diffBytes, fromSha, toSha));
            if (status !== 'Deleted') {
                if (content.byteLength <= fieldLimit)
                    file.context = context;
                else
                    references.push(this.store(path, 'CodeContext', content, fromSha, toSha));
            }
            files.push(file);
            changedPaths.push(path);
            if (files.length > 200)
                throw new CollectorError('InputLimitExceeded');
        }
        if (filtered)
            changedPaths.push(filteredSourceMarker);
        return { fromSha, toSha, commits, files, references, changedPaths };
    }
    async readReference(reference) {
        const bytes = this.stored.get(JSON.stringify(reference));
        if (!bytes || createHash('sha256').update(bytes).digest('hex') !== reference.sha256)
            throw new CollectorError('SourceReferenceInvalid');
        return Uint8Array.from(bytes);
    }
}
