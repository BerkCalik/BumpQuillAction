import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { CollectorError, assertNoCredentials, isSha, serializeAnalysisInput, validateWire } from './contracts.js';
import { SourceReader } from './sources.js';
const execute = promisify(execFile);
const decoder = new TextDecoder('utf-8', { fatal: true });
const maximumNodes = 2000;
const maximumProofBytes = 1024 * 1024;
const maximumInputBytes = 10 * 1024 * 1024;
const maximumMessageBytes = 65536;
const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
function decode(value) {
    try {
        return decoder.decode(value);
    }
    catch {
        throw new CollectorError('InvalidGitEncoding');
    }
}
function sensitivePath(path) {
    const segments = path.toLowerCase().split('/');
    return segments.some((part, index) => part === '.env' || part.startsWith('.env.') ||
        /\.(?:pem|key|crt|cer|cert|p8|p12|pfx|jks|keystore|asc|gpg|kdbx|secret|secrets)$/u.test(part) ||
        /^(?:id_rsa|id_ed25519|id_ecdsa|authorized_keys|known_hosts|credentials|credentials\..+|secrets|secrets\..+|\.npmrc|\.pypirc|\.netrc|\.htpasswd)$/u.test(part) ||
        index < segments.length - 1 && /^(?:\.ssh|\.aws|\.azure|\.gnupg|secrets|credentials)$/u.test(part));
}
export function validateCollectorSourceProof(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new CollectorError('CollectorSourceProofInvalid');
    const proof = value;
    const fields = ['schemaVersion', 'completeness', 'commitCount', 'ancestry', 'boundaries', 'commits', 'pullRequests'];
    if (Object.keys(proof).length !== fields.length || Object.keys(proof).some(key => !fields.includes(key)) ||
        proof.schemaVersion !== 1 || proof.completeness !== 'Complete' || !Number.isInteger(proof.commitCount) ||
        !Array.isArray(proof.ancestry) || !Array.isArray(proof.boundaries) || !Array.isArray(proof.commits) || !Array.isArray(proof.pullRequests) ||
        proof.commitCount !== proof.commits.length || proof.commits.length > 1000 || proof.pullRequests.length > 1000 ||
        proof.ancestry.length > maximumNodes || proof.boundaries.length < 1 || proof.boundaries.length > maximumNodes ||
        Buffer.byteLength(JSON.stringify(proof), 'utf8') > maximumProofBytes)
        throw new CollectorError('CollectorSourceProofInvalid');
    for (const node of proof.ancestry) {
        if (!node || !isSha(node.sha) || !Array.isArray(node.parents) || node.parents.length > 8 ||
            node.parents.some(parent => !isSha(parent) || parent === node.sha) || new Set(node.parents).size !== node.parents.length)
            throw new CollectorError('CollectorSourceProofInvalid');
    }
    for (const cut of proof.boundaries) {
        if (!cut || !['From', 'To'].includes(cut.root) || !isSha(cut.sha) || !Array.isArray(cut.witnessPath) ||
            !cut.witnessPath.length || cut.witnessPath.length > maximumNodes || cut.witnessPath.some(sha => !isSha(sha)) ||
            cut.witnessPath.at(-1) !== cut.sha)
            throw new CollectorError('CollectorSourceProofInvalid');
    }
    for (const link of proof.commits) {
        if (!link || !Number.isInteger(link.inputCommitIndex) || link.inputCommitIndex < 0 || link.inputCommitIndex >= proof.commitCount ||
            !/^[0-9a-f]{64}$/.test(link.fullMessageSha256) || !Array.isArray(link.files) || link.files.length > 200 ||
            !Array.isArray(link.protectedEvidence) || link.protectedEvidence.length > 32)
            throw new CollectorError('CollectorSourceProofInvalid');
        for (const file of link.files)
            if (!file || !Number.isInteger(file.inputFileIndex) || file.inputFileIndex < 0 ||
                !isSha(file.blobSha) || file.state !== 'Readable')
                throw new CollectorError('CollectorSourceProofInvalid');
        for (const signal of link.protectedEvidence)
            if (!signal || !['BreakingChangeLabel', 'SecurityLabel', 'SecurityAdvisory'].includes(signal.kind) ||
                typeof signal.sourceReference !== 'string' || !signal.sourceReference.length || signal.sourceReference.length > 256 ||
                /[\u0000-\u001f\u007f]/u.test(signal.sourceReference) || !/^[0-9a-f]{64}$/.test(signal.evidenceSha256))
                throw new CollectorError('CollectorSourceProofInvalid');
    }
    for (const link of proof.pullRequests)
        if (!link || !Number.isInteger(link.inputPullRequestIndex) || link.inputPullRequestIndex < 0 ||
            link.inputPullRequestIndex >= proof.pullRequests.length || !isSha(link.effectiveCommitSha))
            throw new CollectorError('CollectorSourceProofInvalid');
}
export function validateCollectorInput(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new CollectorError('WireContractInvalid');
    const payload = value;
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > maximumInputBytes)
        throw new CollectorError('InputLimitExceeded');
    if (payload.schemaVersion === 1) {
        validateWire('AnalysisInputPayload', value);
        return;
    }
    if (payload.schemaVersion !== 2 || !Array.isArray(payload.commits))
        throw new CollectorError('WireContractInvalid');
    for (const commit of payload.commits) {
        if (!commit || typeof commit.message !== 'string' || !commit.message.isWellFormed() ||
            Buffer.byteLength(commit.message, 'utf8') > maximumMessageBytes || commit.subject !== commit.message.split('\n')[0].replace(/\r$/u, ''))
            throw new CollectorError('CollectorCommitMessageInvalid');
    }
    validateWire('AnalysisInputPayload', value);
}
export function serializeCollectorInput(binding, sources, pullRequests, excludedValues = []) {
    if (!('sourceProof' in sources))
        return { ...serializeAnalysisInput({ schemaVersion: 1, jobId: binding.id,
                repositoryId: binding.repositoryId, branchId: binding.branchId, generation: binding.generation, fromSha: binding.fromSha,
                toSha: binding.toSha, commits: sources.commits, files: sources.files, pullRequests }, excludedValues), sourceProof: undefined };
    const collected = sources;
    const sourceProof = structuredClone(collected.sourceProof);
    sourceProof.pullRequests = pullRequests.map((request, index) => ({ inputPullRequestIndex: index, effectiveCommitSha: request.effectiveCommitSha }));
    validateCollectorSourceProof(sourceProof);
    const payload = { schemaVersion: 2, jobId: binding.id, repositoryId: binding.repositoryId, branchId: binding.branchId,
        generation: binding.generation, fromSha: binding.fromSha, toSha: binding.toSha, commits: collected.commits, files: collected.files, pullRequests };
    validateCollectorInput(payload);
    assertNoCredentials({ payload, sourceProof }, excludedValues);
    const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
    return { bytes, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), sourceProof };
}
export class CollectorSourceProofReader {
    checkoutDir;
    options;
    nodes = new Map();
    gitBytes = 0;
    files;
    constructor(checkoutDir, options = {}) {
        this.checkoutDir = checkoutDir;
        this.options = options;
        this.files = new SourceReader(checkoutDir, { excludedValues: options.excludedValues, ignorePatterns: options.ignorePatterns });
    }
    async git(...args) {
        if (this.options.signal?.aborted)
            throw new CollectorError('CollectorCancelled');
        const remaining = 32 * 1024 * 1024 - this.gitBytes;
        if (remaining <= 0)
            throw new CollectorError('GitOutputLimitExceeded');
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
        Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1',
            GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1', LC_ALL: 'C' });
        try {
            const { stdout } = await execute('git', args, { cwd: this.checkoutDir, env, encoding: 'buffer', maxBuffer: remaining,
                timeout: 30000, killSignal: 'SIGKILL', signal: this.options.signal });
            const bytes = Buffer.from(stdout);
            this.gitBytes += bytes.length;
            return bytes;
        }
        catch {
            throw new CollectorError(this.options.signal?.aborted ? 'CollectorCancelled' : 'CollectorGitProofUnavailable');
        }
    }
    async node(sha) {
        const known = this.nodes.get(sha);
        if (known)
            return known;
        if (!isSha(sha) || this.nodes.size >= maximumNodes)
            throw new CollectorError('SourceGraphIncomplete');
        const raw = await this.git('cat-file', 'commit', sha);
        const separator = raw.indexOf('\n\n');
        if (separator < 0 || raw.length - separator - 2 > maximumMessageBytes)
            throw new CollectorError('CollectorCommitMessageInvalid');
        const headers = decode(raw.subarray(0, separator)).split('\n');
        const parents = headers.filter(line => line.startsWith('parent ')).map(line => line.slice(7));
        if (parents.length > 8 || parents.some(parent => !isSha(parent)))
            throw new CollectorError('SourceGraphIncomplete');
        const message = decode(raw.subarray(separator + 2));
        assertNoCredentials(message, this.options.excludedValues ?? []);
        const node = { sha, parents, message };
        this.nodes.set(sha, node);
        return node;
    }
    async witness(root, target) {
        const paths = [[root]];
        const seen = new Set();
        for (let index = 0; index < paths.length; index++) {
            const path = paths[index];
            const current = path.at(-1);
            if (current === target)
                return path;
            if (seen.has(current))
                continue;
            seen.add(current);
            if (paths.length > maximumNodes * 8)
                throw new CollectorError('SourceGraphIncomplete');
            for (const parent of (await this.node(current)).parents)
                paths.push([...path, parent]);
        }
        throw new CollectorError('SourceBoundaryUnverified');
    }
    async collect(fromSha, toSha) {
        this.nodes.clear();
        this.gitBytes = 0;
        if (!isSha(fromSha) || !isSha(toSha))
            throw new CollectorError('InvalidSourceRef');
        const top = decode(await this.git('rev-parse', '--show-toplevel')).trimEnd();
        if (await realpath(top) !== await realpath(this.checkoutDir))
            throw new CollectorError('CheckoutInvalid');
        if (this.options.headSha !== undefined && (!isSha(this.options.headSha) ||
            decode(await this.git('rev-parse', '--verify', 'HEAD')).trim() !== this.options.headSha))
            throw new CollectorError('CollectorHeadMismatch');
        if (decode(await this.git('rev-parse', '--is-shallow-repository')).trim() !== 'false')
            throw new CollectorError('SourceGraphIncomplete');
        await this.git('merge-base', '--is-ancestor', fromSha, toSha);
        const shas = decode(await this.git('rev-list', '--topo-order', '--reverse', '--max-count=1001', `${fromSha}..${toSha}`)).trim().split('\n').filter(Boolean);
        if (shas.length > 1000 || shas.some(sha => !isSha(sha)))
            throw new CollectorError('InputLimitExceeded');
        const interval = new Set(shas);
        for (const sha of shas)
            await this.node(sha);
        const boundaries = [
            { root: 'From', sha: fromSha, witnessPath: [fromSha] }, { root: 'To', sha: toSha, witnessPath: [toSha] }
        ];
        const cuts = new Set([fromSha]);
        for (const sha of shas)
            for (const parent of (await this.node(sha)).parents) {
                if (interval.has(parent) || cuts.has(parent))
                    continue;
                const path = await this.witness(fromSha, parent);
                boundaries.push({ root: 'From', sha: parent, witnessPath: path });
                for (const vertex of path)
                    cuts.add(vertex);
            }
        const files = [];
        const commits = [];
        const links = [];
        const protectedRange = shas.some(sha => /(?:^\s*BREAKING(?: CHANGE|-CHANGE)\s*:|^[a-zA-Z][a-zA-Z0-9-]*(?:\([^)\r\n]+\))?!:|\b(?:security|CVE-\d{4}-\d+|GHSA-[a-z0-9-]+)\b)/imu.test(this.nodes.get(sha).message));
        const fileReader = protectedRange ? new SourceReader(this.checkoutDir, { excludedValues: this.options.excludedValues }) : this.files;
        for (const sha of shas) {
            const node = await this.node(sha);
            if (!node.parents.length)
                throw new CollectorError('SourceGraphIncomplete');
            const collected = await fileReader.collect(node.parents[0], sha);
            if (collected.references.length)
                throw new CollectorError('EffectiveSourceUnreadable');
            const attributed = [];
            for (const file of collected.files) {
                const blobSha = decode(await this.git('rev-parse', '--verify', `${file.status === 'Deleted' ? node.parents[0] : sha}:${file.path}`)).trim();
                if (!isSha(blobSha))
                    throw new CollectorError('EffectiveSourceUnreadable');
                attributed.push({ inputFileIndex: files.length, blobSha, state: 'Readable' });
                files.push(file);
                if (files.length > 200)
                    throw new CollectorError('InputLimitExceeded');
            }
            const excludedFiles = [];
            const changed = decode(await this.git('diff', '--name-status', '-z', '--find-renames', '--no-ext-diff', node.parents[0], sha, '--')).split('\0');
            for (let index = 0; index < changed.length - 1;) {
                const rawStatus = changed[index++];
                const oldPath = changed[index++];
                const rename = /^R\d+$/u.test(rawStatus);
                const status = rename ? 'R' : rawStatus;
                const path = rename ? changed[index++] : oldPath;
                if (collected.files.some(file => file.path === path))
                    continue;
                if (!['A', 'M', 'D', 'T', 'R'].includes(status) || !path || path.startsWith('/') || /[\u0000-\u001f\u007f]/u.test(path))
                    throw new CollectorError('SourceGraphIncomplete');
                const object = `${status === 'D' ? node.parents[0] : sha}:${path}`;
                const blobSha = decode(await this.git('rev-parse', '--verify', object)).trim();
                if (!isSha(blobSha))
                    throw new CollectorError('SourceGraphIncomplete');
                const endpoint = status === 'D' ? node.parents[0] : sha;
                const entry = decode(await this.git('ls-tree', '-z', endpoint, '--', path));
                const mode = /^([0-7]{6}) (?:blob|commit) ([0-9a-f]{40,64})\t/u.exec(entry);
                if (!mode || mode[2] !== blobSha)
                    throw new CollectorError('SourceGraphIncomplete');
                const sensitive = sensitivePath(path) || rename && sensitivePath(oldPath);
                let reason = sensitive ? 'Sensitive' : 'Ignored';
                if (!['100644', '100755'].includes(mode[1]))
                    reason = 'Unsupported';
                else if (!sensitive) {
                    const content = await this.git('cat-file', 'blob', blobSha);
                    try {
                        if (content.includes(0))
                            reason = 'Binary';
                        else {
                            const text = decode(content);
                            if ((this.options.excludedValues ?? []).filter(Boolean).some(secret => text.includes(secret) || path.includes(secret) || oldPath.includes(secret)))
                                reason = 'Sensitive';
                        }
                    }
                    catch {
                        reason = 'Binary';
                    }
                }
                excludedFiles.push({ path, blobSha, status: status === 'A' ? 'Added' : status === 'D' ? 'Deleted' : status === 'R' ? 'Renamed' : 'Modified', reason });
                if (excludedFiles.length + attributed.length > 200)
                    throw new CollectorError('InputLimitExceeded');
            }
            links.push({ inputCommitIndex: commits.length, files: attributed, fullMessageSha256: sha256(node.message), protectedEvidence: [],
                ...(excludedFiles.length ? { excludedFiles } : {}) });
            commits.push({ sha, subject: node.message.split('\n')[0].replace(/\r$/u, ''), message: node.message });
        }
        const sourceProof = { schemaVersion: 1, completeness: 'Complete', commitCount: commits.length,
            ancestry: [...this.nodes.values()].map(({ sha, parents }) => ({ sha, parents })), boundaries, commits: links, pullRequests: [] };
        validateCollectorSourceProof(sourceProof);
        return { fromSha, toSha, commits, files, references: [], changedPaths: [...new Set(files.map(file => file.path))], sourceProof };
    }
    readReference() { throw new CollectorError('SourceReferenceInvalid'); }
}
