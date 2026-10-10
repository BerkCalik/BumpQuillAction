import { createHash } from 'node:crypto';
import { CollectorError, assertNoCredentials, isSha } from './contracts.js';
import { httpsOrigin, readJson } from './http.js';
import { isBranchName } from './inputs.js';
import { requirePublisherUuid, validatePublicationWire } from './publisher-http.js';
const maximumContentBytes = 10485760;
function record(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new CollectorError('GitHubPublicationResponseInvalid');
    return value;
}
function sha(value) {
    if (!isSha(value) || value.length !== 40)
        throw new CollectorError('GitHubPublicationResponseInvalid');
    return value;
}
export function publicationPath(path) {
    if (!path || Buffer.byteLength(path) > 1024 || !path.isWellFormed() || /[\u0000-\u0020\u007f\\:#?%]/u.test(path) ||
        path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git') ||
        path.toLowerCase().startsWith('.github/'))
        throw new CollectorError('PublicationPathInvalid');
}
export function gitBlobSha(content) {
    return createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');
}
export function contentSha256(content) { return createHash('sha256').update(content).digest('hex'); }
function nonOutputEntries(tree, path) {
    return tree.filter(entry => entry.type !== 'tree' && entry.path !== path).sort((left, right) => left.path.localeCompare(right.path));
}
export function publicationIdentity(scope) {
    for (const identity of [scope.organizationId, scope.repositoryId, scope.branchId])
        requirePublisherUuid(identity);
    if (!Number.isSafeInteger(scope.generation) || scope.generation < 0 || !/^[1-9][0-9]{0,31}$/.test(scope.githubRepositoryId) ||
        !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(scope.owner) || !/^[a-zA-Z0-9_.-]{1,100}$/.test(scope.repository) ||
        scope.repository === '.' || scope.repository === '..' || !isBranchName(scope.refName) || !isSha(scope.targetHeadSha) || scope.targetHeadSha.length !== 40)
        throw new CollectorError('PublicationScopeInvalid');
    const binding = `${scope.organizationId}:${scope.repositoryId}:${scope.branchId}:${scope.generation}`;
    const base = `bumpquill/publication/${scope.organizationId.replaceAll('-', '')}/${scope.repositoryId.replaceAll('-', '')}/${scope.branchId.replaceAll('-', '')}/g${scope.generation}`;
    if (scope.headRef !== undefined && scope.headRef !== `refs/heads/${base}` && !new RegExp(`^refs/heads/${base}/c[0-9a-f]{32}$`).test(scope.headRef))
        throw new CollectorError('PublicationHeadRefInvalid');
    const branch = scope.headRef?.slice('refs/heads/'.length) ?? base;
    if (scope.refName === branch)
        throw new CollectorError('PublicationTargetInvalid');
    return { branch, marker: `<!-- bumpquill:publication ${binding}${branch === base ? '' : ` head:${branch}`} -->` };
}
export class GitHubPublisher {
    fetcher;
    options;
    origin;
    #authorization;
    constructor(token, fetcher = fetch, origin = 'https://api.github.com', options = {}) {
        this.fetcher = fetcher;
        this.options = options;
        if (!/^[\x21-\x7e]{1,4096}$/.test(token))
            throw new CollectorError('GitHubTokenInvalid');
        this.#authorization = `Bearer ${token}`;
        this.origin = httpsOrigin(origin);
    }
    async request(scope, route, method = 'GET', body, query = {}, absent = false) {
        publicationIdentity(scope);
        if (this.options.signal?.aborted)
            throw new CollectorError('PublisherCancelled');
        if (method !== 'GET')
            this.options.beforeWrite?.();
        const url = new URL(`/repos/${[scope.owner, scope.repository, ...route].map(encodeURIComponent).join('/')}`, this.origin);
        for (const [name, value] of Object.entries(query))
            url.searchParams.set(name, value);
        try {
            const timeout = AbortSignal.timeout(30000);
            const response = await this.fetcher(url, { method, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error',
                signal: this.options.signal ? AbortSignal.any([this.options.signal, timeout]) : timeout,
                headers: { Authorization: this.#authorization, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) } });
            if (response.redirected)
                throw new CollectorError('GitHubPublicationRejected');
            if (absent && response.status === 404) {
                await response.body?.cancel().catch(() => { });
                return null;
            }
            return await readJson(response, 16777216);
        }
        catch (error) {
            if (error instanceof CollectorError)
                throw error;
            throw new CollectorError(method === 'GET' ? 'GitHubPublicationUnavailable' : 'GitHubPublicationOutcomeUnknown');
        }
    }
    async verifyRepository(scope) {
        const repository = record(await this.request(scope, []));
        const id = typeof repository.id === 'number' && Number.isSafeInteger(repository.id) ? String(repository.id) : repository.id;
        if (id !== scope.githubRepositoryId || typeof repository.full_name !== 'string' || repository.full_name.toLowerCase() !== `${scope.owner}/${scope.repository}`.toLowerCase() ||
            repository.archived === true || repository.disabled === true)
            throw new CollectorError('GitHubPublicationScopeMismatch');
        return repository.full_name;
    }
    async ref(scope, branch, absent = false) {
        const value = await this.request(scope, ['git', 'ref', `heads/${branch}`], 'GET', undefined, {}, absent);
        if (value === null)
            return null;
        const result = record(value), object = record(result.object);
        if (result.ref !== `refs/heads/${branch}` || object.type !== 'commit')
            throw new CollectorError('GitHubPublicationRefInvalid');
        return sha(object.sha);
    }
    async commit(scope, head) {
        const result = record(await this.request(scope, ['git', 'commits', head]));
        if (result.sha !== head || !Array.isArray(result.parents) || result.parents.length > 2 || typeof result.message !== 'string' || result.message.length > 65536)
            throw new CollectorError('GitHubPublicationCommitInvalid');
        return { sha: head, tree: sha(record(result.tree).sha), parents: result.parents.map(parent => sha(record(parent).sha)), message: result.message };
    }
    async tree(scope, head) {
        const commit = await this.commit(scope, head);
        const result = record(await this.request(scope, ['git', 'trees', commit.tree], 'GET', undefined, { recursive: '1' }));
        if (result.sha !== commit.tree || result.truncated !== false || !Array.isArray(result.tree) || result.tree.length > 10000)
            throw new CollectorError('GitHubPublicationTreeInvalid');
        const paths = new Set();
        return result.tree.map(value => {
            const entry = record(value);
            if (typeof entry.path !== 'string' || !entry.path.isWellFormed() || paths.has(entry.path) || typeof entry.mode !== 'string' || typeof entry.type !== 'string')
                throw new CollectorError('GitHubPublicationTreeInvalid');
            paths.add(entry.path);
            return { path: entry.path, mode: entry.mode, type: entry.type, sha: sha(entry.sha) };
        });
    }
    async files(scope, head, paths) {
        const tree = await this.tree(scope, head);
        const files = [];
        for (const path of paths) {
            publicationPath(path);
            const entry = tree.find(item => item.path === path);
            if (!entry) {
                if (tree.some(item => path.startsWith(`${item.path}/`) && item.type !== 'tree'))
                    throw new CollectorError('PublicationPathObstructed');
                files.push({ path, content: '', githubContentSha: null });
                continue;
            }
            if (entry.type !== 'blob' || entry.mode !== '100644')
                throw new CollectorError('PublicationPathObstructed');
            const blob = record(await this.request(scope, ['git', 'blobs', entry.sha]));
            if (blob.sha !== entry.sha || blob.encoding !== 'base64' || typeof blob.content !== 'string' || !Number.isSafeInteger(blob.size) || blob.size < 0 || blob.size > maximumContentBytes ||
                !/^[A-Za-z0-9+/=\r\n]*$/.test(blob.content) || blob.content.length > 14000000)
                throw new CollectorError('GitHubPublicationBlobInvalid');
            const bytes = Buffer.from(blob.content.replace(/[\r\n]/g, ''), 'base64');
            if (bytes.length !== blob.size || bytes.toString('base64') !== blob.content.replace(/[\r\n]/g, ''))
                throw new CollectorError('GitHubPublicationBlobInvalid');
            let content;
            try {
                content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
            }
            catch {
                throw new CollectorError('GitHubPublicationBlobInvalid');
            }
            if (gitBlobSha(content) !== entry.sha)
                throw new CollectorError('GitHubPublicationBlobInvalid');
            files.push({ path, content, githubContentSha: entry.sha });
        }
        return files;
    }
    parsePullRequest(scope, value, requireMarker = true) {
        const identity = publicationIdentity(scope), result = record(value), head = record(result.head), base = record(result.base);
        for (const side of [head, base]) {
            const repository = record(side.repo);
            const id = typeof repository.id === 'number' && Number.isSafeInteger(repository.id) ? String(repository.id) : repository.id;
            if (id !== scope.githubRepositoryId || typeof repository.full_name !== 'string' || repository.full_name.toLowerCase() !== `${scope.owner}/${scope.repository}`.toLowerCase())
                throw new CollectorError('GitHubPublicationScopeMismatch');
        }
        if (!Number.isSafeInteger(result.number) || result.number < 1 || !['open', 'closed'].includes(result.state) || typeof result.merged !== 'boolean' ||
            head.ref !== identity.branch || base.ref !== scope.refName || result.merged && result.state !== 'closed' ||
            requireMarker && (typeof result.body !== 'string' || !result.body.split(/\r?\n/).includes(identity.marker)))
            throw new CollectorError('GitHubPublicationIdentityInvalid');
        return { number: result.number, state: result.state, merged: result.merged,
            headSha: sha(head.sha), baseSha: sha(base.sha), mergeCommitSha: result.merged ? sha(result.merge_commit_sha) : null };
    }
    async pullRequestHistory(scope, expectedNumber) {
        const identity = publicationIdentity(scope), matches = [];
        for (let page = 1; page <= 10; page++) {
            const items = await this.request(scope, ['pulls'], 'GET', undefined, { state: 'all', head: `${scope.owner}:${identity.branch}`, base: scope.refName, per_page: '100', page: String(page) });
            if (!Array.isArray(items) || items.length > 100)
                throw new CollectorError('GitHubPublicationResponseInvalid');
            for (const item of items) {
                const candidate = record(item);
                if (!Number.isSafeInteger(candidate.number) || candidate.number < 1)
                    throw new CollectorError('GitHubPublicationResponseInvalid');
                matches.push(candidate.number);
            }
            if (items.length < 100)
                break;
            if (page === 10)
                throw new CollectorError('GitHubPublicationPaginationExceeded');
        }
        if (new Set(matches).size !== matches.length)
            throw new CollectorError('GitHubPublicationIdentityConflict');
        const active = [], historicalMergedPullRequests = [];
        let expected;
        for (const number of matches) {
            const detail = await this.request(scope, ['pulls', String(number)], 'GET', undefined, {}, number === expectedNumber);
            if (detail === null)
                continue;
            const merged = record(detail).merged === true;
            const parsed = this.parsePullRequest(scope, detail, !merged || number === expectedNumber);
            if (merged)
                historicalMergedPullRequests.push(number);
            else
                active.push(parsed);
            if (number === expectedNumber)
                expected = parsed;
        }
        if (expectedNumber && !expected) {
            const detail = await this.request(scope, ['pulls', String(expectedNumber)], 'GET', undefined, {}, true);
            if (detail === null && active.length === 0)
                return { pullRequest: null, historicalMergedPullRequests, missingKnownPullRequest: expectedNumber };
            if (detail !== null)
                expected = this.parsePullRequest(scope, detail);
        }
        if (active.length > 1 || expectedNumber && !expected)
            throw new CollectorError('GitHubPublicationIdentityConflict');
        return { pullRequest: expectedNumber ? expected : active[0] ?? null, historicalMergedPullRequests };
    }
    async pullRequest(scope, expectedNumber) {
        return (await this.pullRequestHistory(scope, expectedNumber)).pullRequest;
    }
    async currentPullRequestHead(scope, expectedNumber) {
        await this.verifyRepository(scope);
        if (await this.ref(scope, scope.refName) !== scope.targetHeadSha)
            throw new CollectorError('PublicationTargetMoved');
        const pullRequest = await this.pullRequest(scope, expectedNumber);
        if (!pullRequest || pullRequest.merged || pullRequest.state !== 'open')
            throw new CollectorError('PublicationCustomerDecisionRequired');
        if (await this.ref(scope, publicationIdentity(scope).branch) !== pullRequest.headSha)
            throw new CollectorError('PublicationBranchMoved');
        return pullRequest.headSha;
    }
    async observe(scope, paths, expectedNumber) {
        const repositoryFullName = await this.verifyRepository(scope);
        if (paths.length !== 1 || new Set(paths).size !== paths.length)
            throw new CollectorError('PublicationSinglePathRequired');
        const targetHeadSha = await this.ref(scope, scope.refName);
        if (targetHeadSha !== scope.targetHeadSha)
            throw new CollectorError('PublicationTargetMoved');
        const branchHeadSha = await this.ref(scope, publicationIdentity(scope).branch, true);
        const history = await this.pullRequestHistory(scope, expectedNumber), pullRequest = history.pullRequest;
        if (pullRequest && !pullRequest.merged && branchHeadSha !== null && branchHeadSha !== pullRequest.headSha)
            throw new CollectorError('PublicationBranchMoved');
        if (pullRequest?.state === 'open' && branchHeadSha === null)
            throw new CollectorError('PublicationBranchMissing');
        if (history.missingKnownPullRequest && branchHeadSha === null)
            throw new CollectorError('PublicationCustomerDecisionRequired');
        return { repositoryFullName, targetHeadSha, branchHeadSha, pullRequest, historicalMergedPullRequests: history.historicalMergedPullRequests,
            ...(history.missingKnownPullRequest ? { missingKnownPullRequest: history.missingKnownPullRequest } : {}),
            files: await this.files(scope, pullRequest?.merged ? pullRequest.headSha : branchHeadSha ?? pullRequest?.headSha ?? targetHeadSha, paths) };
    }
    async unchanged(scope, expected, paths) {
        const current = await this.observe(scope, paths, expected.pullRequest?.number ?? expected.missingKnownPullRequest);
        if (current.targetHeadSha !== expected.targetHeadSha || current.branchHeadSha !== expected.branchHeadSha ||
            JSON.stringify(current.pullRequest) !== JSON.stringify(expected.pullRequest) || JSON.stringify(current.files) !== JSON.stringify(expected.files) ||
            JSON.stringify(current.historicalMergedPullRequests) !== JSON.stringify(expected.historicalMergedPullRequests) || current.missingKnownPullRequest !== expected.missingKnownPullRequest)
            throw new CollectorError('PublicationObservationChanged');
        return current;
    }
    async write(scope, manifest, expected, assertLive) {
        assertLive();
        validatePublicationWire('PublicationManifest', manifest);
        assertNoCredentials(manifest, [this.#authorization.slice('Bearer '.length)]);
        if (manifest.phase !== 'Prepared' || manifest.repositoryId !== scope.repositoryId || manifest.branchId !== scope.branchId || manifest.generation !== scope.generation ||
            manifest.files.length !== 1 || expected.files.length !== 1)
            throw new CollectorError('PublicationManifestBindingInvalid');
        requirePublisherUuid(manifest.operationId);
        const file = manifest.files[0];
        publicationPath(file.path);
        if (!file.markdown.isWellFormed() || Buffer.byteLength(file.markdown) > maximumContentBytes || contentSha256(file.markdown) !== file.sha256 ||
            expected.files[0].path !== file.path || expected.files[0].githubContentSha !== file.expectedBaseSha ||
            expected.targetHeadSha !== scope.targetHeadSha)
            throw new CollectorError('PublicationManifestBindingInvalid');
        if (expected.pullRequest?.state === 'closed')
            throw new CollectorError('PublicationCustomerDecisionRequired');
        const parent = expected.branchHeadSha ?? expected.targetHeadSha;
        if (expected.branchHeadSha) {
            const baseTree = await this.tree(scope, expected.pullRequest?.baseSha ?? expected.targetHeadSha);
            const branchTree = await this.tree(scope, parent);
            if (JSON.stringify(nonOutputEntries(baseTree, file.path)) !== JSON.stringify(nonOutputEntries(branchTree, file.path)))
                throw new CollectorError('PublicationMixedChanges');
            if (!expected.pullRequest) {
                const commit = await this.commit(scope, parent);
                if (commit.message !== this.commitMessage(scope, manifest) || expected.files[0].content !== file.markdown)
                    throw new CollectorError('PublicationOrphanBranchConflict');
            }
        }
        await this.unchanged(scope, expected, [file.path]);
        let commitSha = parent;
        if (expected.files[0].content !== file.markdown || expected.files[0].githubContentSha === null) {
            assertLive();
            const blob = record(await this.request(scope, ['git', 'blobs'], 'POST', { content: file.markdown, encoding: 'utf-8' }));
            if (blob.sha !== gitBlobSha(file.markdown))
                throw new CollectorError('GitHubPublicationBlobInvalid');
            const parentCommit = await this.commit(scope, parent);
            assertLive();
            const tree = record(await this.request(scope, ['git', 'trees'], 'POST', { base_tree: parentCommit.tree, tree: [{ path: file.path, mode: '100644', type: 'blob', sha: blob.sha }] }));
            const treeSha = sha(tree.sha);
            assertLive();
            const commit = record(await this.request(scope, ['git', 'commits'], 'POST', { message: this.commitMessage(scope, manifest), tree: treeSha, parents: [parent] }));
            commitSha = sha(commit.sha);
            const written = await this.commit(scope, commitSha);
            if (written.tree !== treeSha || written.parents.length !== 1 || written.parents[0] !== parent || written.message !== this.commitMessage(scope, manifest))
                throw new CollectorError('GitHubPublicationCommitInvalid');
            const parentTree = await this.tree(scope, parent), writtenTree = await this.tree(scope, commitSha);
            const writtenFile = (await this.files(scope, commitSha, [file.path]))[0];
            if (writtenFile.content !== file.markdown || writtenFile.githubContentSha !== gitBlobSha(file.markdown) ||
                JSON.stringify(nonOutputEntries(parentTree, file.path)) !== JSON.stringify(nonOutputEntries(writtenTree, file.path)))
                throw new CollectorError('PublicationWrittenContentMismatch');
            await this.unchanged(scope, expected, [file.path]);
            assertLive();
            const branch = publicationIdentity(scope).branch;
            const ref = record(await this.request(scope, expected.branchHeadSha === null ? ['git', 'refs'] : ['git', 'refs', `heads/${branch}`], expected.branchHeadSha === null ? 'POST' : 'PATCH', expected.branchHeadSha === null ? { ref: `refs/heads/${branch}`, sha: commitSha } : { sha: commitSha, force: false }));
            if (ref.ref !== `refs/heads/${branch}` || record(ref.object).sha !== commitSha)
                throw new CollectorError('GitHubPublicationRefInvalid');
        }
        if (commitSha === expected.targetHeadSha && !expected.pullRequest)
            throw new CollectorError('PublicationNoChanges');
        const branch = publicationIdentity(scope).branch;
        if (await this.ref(scope, scope.refName) !== expected.targetHeadSha || await this.ref(scope, branch) !== commitSha)
            throw new CollectorError('PublicationBranchMoved');
        let pullRequest = await this.pullRequest(scope, expected.pullRequest?.number);
        if (!pullRequest) {
            assertLive();
            await this.request(scope, ['pulls'], 'POST', { title: 'Update changelog', body: publicationIdentity(scope).marker, head: branch, base: scope.refName });
            pullRequest = await this.pullRequest(scope);
        }
        if (!pullRequest || pullRequest.state !== 'open' || pullRequest.headSha !== commitSha)
            throw new CollectorError('GitHubPublicationOutcomeUnknown');
        const files = await this.files(scope, commitSha, [file.path]);
        if (files[0].content !== file.markdown || files[0].githubContentSha !== gitBlobSha(file.markdown))
            throw new CollectorError('PublicationWrittenContentMismatch');
        assertLive();
        if (await this.ref(scope, scope.refName) !== expected.targetHeadSha || await this.ref(scope, branch) !== commitSha)
            throw new CollectorError('PublicationBranchMoved');
        return { pullRequest, commitSha, contentSha256: file.sha256 };
    }
    async verifyObserved(scope, manifest, observation) {
        validatePublicationWire('PublicationManifest', manifest);
        if (manifest.phase !== 'Prepared' || manifest.files.length !== 1 || observation.files.length !== 1 || !observation.pullRequest ||
            manifest.repositoryId !== scope.repositoryId || manifest.branchId !== scope.branchId || manifest.generation !== scope.generation ||
            observation.files[0].path !== manifest.files[0].path || observation.files[0].content !== manifest.files[0].markdown ||
            contentSha256(observation.files[0].content) !== manifest.files[0].sha256 || observation.files[0].githubContentSha !== gitBlobSha(manifest.files[0].markdown))
            throw new CollectorError('PublicationObservedContentMismatch');
        const pullRequest = observation.pullRequest;
        let commitSha = pullRequest.headSha;
        if (pullRequest.merged) {
            if (!pullRequest.mergeCommitSha)
                throw new CollectorError('PublicationMergeProofMissing');
            const files = await this.files(scope, pullRequest.mergeCommitSha, [manifest.files[0].path]);
            if (files[0].content !== manifest.files[0].markdown || files[0].githubContentSha !== gitBlobSha(manifest.files[0].markdown))
                throw new CollectorError('PublicationMergeContentMismatch');
            commitSha = pullRequest.mergeCommitSha;
        }
        await this.unchanged(scope, observation, [manifest.files[0].path]);
        return { pullRequest, commitSha, contentSha256: manifest.files[0].sha256 };
    }
    async reportObservation(scope, manifest, write, run, now = Date.now) {
        validatePublicationWire('PublicationManifest', manifest);
        if (manifest.phase !== 'Prepared' || manifest.files.length !== 1 || manifest.repositoryId !== scope.repositoryId ||
            manifest.branchId !== scope.branchId || manifest.generation !== scope.generation)
            throw new CollectorError('PublicationManifestBindingInvalid');
        const path = manifest.files[0].path;
        publicationPath(path);
        if (!/^[1-9][0-9]{0,31}$/.test(run.runId) || !/^[1-9][0-9]{0,15}$/.test(run.runAttempt) ||
            !['Publish', 'Observe'].includes(run.intent))
            throw new CollectorError('PublicationObservationRunInvalid');
        const observedAt = new Date(now()).toISOString();
        const observation = await this.observe(scope, [path], write.pullRequest.number);
        const pullRequest = observation.pullRequest;
        if (!pullRequest || JSON.stringify(pullRequest) !== JSON.stringify(write.pullRequest) ||
            (pullRequest.merged ? pullRequest.mergeCommitSha : pullRequest.headSha) !== write.commitSha)
            throw new CollectorError('PublicationObservationChanged');
        const commit = await this.commit(scope, pullRequest.headSha);
        const currentFile = observation.files[0];
        const boundNoOp = observation.branchHeadSha === commit.sha && manifest.files[0].expectedBaseSha === currentFile.githubContentSha &&
            currentFile.githubContentSha === gitBlobSha(manifest.files[0].markdown) && currentFile.content === manifest.files[0].markdown;
        if (!boundNoOp && commit.parents.length !== 1)
            throw new CollectorError('PublicationParentProofInvalid');
        const baseSha = boundNoOp ? commit.sha : commit.parents[0];
        const parentTree = await this.tree(scope, baseSha), currentTree = await this.tree(scope, commit.sha);
        const before = new Map(nonOutputEntries(parentTree, '').map(entry => [entry.path, JSON.stringify(entry)]));
        const after = new Map(nonOutputEntries(currentTree, '').map(entry => [entry.path, JSON.stringify(entry)]));
        const changedPaths = [...new Set([...before.keys(), ...after.keys()])].filter(name => before.get(name) !== after.get(name)).sort();
        if (boundNoOp ? changedPaths.length !== 0 : changedPaths.length !== 1 || changedPaths[0] !== path)
            throw new CollectorError('PublicationMixedChanges');
        const baseFile = (await this.files(scope, baseSha, [path]))[0];
        if (baseFile.githubContentSha !== manifest.files[0].expectedBaseSha || currentFile.content !== manifest.files[0].markdown ||
            currentFile.githubContentSha !== gitBlobSha(manifest.files[0].markdown) || contentSha256(currentFile.content) !== manifest.files[0].sha256)
            throw new CollectorError('PublicationObservedContentMismatch');
        let mergedFiles = null;
        let mergeCommitOnTargetRef = false;
        if (pullRequest.merged) {
            if (!pullRequest.mergeCommitSha)
                throw new CollectorError('PublicationMergeProofMissing');
            const mergeFiles = await this.files(scope, pullRequest.mergeCommitSha, [path]);
            if (mergeFiles[0].content !== manifest.files[0].markdown || mergeFiles[0].githubContentSha !== gitBlobSha(manifest.files[0].markdown))
                throw new CollectorError('PublicationMergeContentMismatch');
            const comparison = record(await this.request(scope, ['compare', `${pullRequest.mergeCommitSha}...${observation.targetHeadSha}`], 'GET', undefined, { per_page: '1' }));
            if (!['ahead', 'identical'].includes(comparison.status) || record(comparison.merge_base_commit).sha !== pullRequest.mergeCommitSha ||
                record(comparison.base_commit).sha !== pullRequest.mergeCommitSha || !Array.isArray(comparison.commits) || comparison.commits.length > 1 ||
                comparison.commits.some(value => !isSha(record(value).sha)) ||
                comparison.status === 'identical' && (pullRequest.mergeCommitSha !== observation.targetHeadSha || comparison.commits.length !== 0) ||
                comparison.status === 'ahead' && (pullRequest.mergeCommitSha === observation.targetHeadSha || comparison.commits.length !== 1))
                throw new CollectorError('PublicationMergeNotOnTarget');
            await this.commit(scope, observation.targetHeadSha);
            mergeCommitOnTargetRef = true;
            mergedFiles = [{ path, content: mergeFiles[0].content, blobSha: mergeFiles[0].githubContentSha }];
        }
        await this.unchanged(scope, observation, [path]);
        return { schemaVersion: 1, runId: run.runId, runAttempt: run.runAttempt, intent: run.intent,
            githubRepositoryId: scope.githubRepositoryId, repositoryFullName: observation.repositoryFullName,
            targetRef: `refs/heads/${scope.refName}`, headRef: `refs/heads/${publicationIdentity(scope).branch}`, targetHeadSha: observation.targetHeadSha,
            commitSha: commit.sha, parentShas: commit.parents, baseFileBlobSha: baseFile.githubContentSha,
            pullRequestState: pullRequest.state, merged: pullRequest.merged,
            mergeCommitSha: pullRequest.mergeCommitSha, files: [{ path, content: currentFile.content, blobSha: currentFile.githubContentSha }],
            changedPaths, observedAt, mergedFiles, mergeCommitOnTargetRef, ...(boundNoOp ? { branchHeadSha: observation.branchHeadSha } : {}) };
    }
    async orphanObservation(scope, manifest, expected, run, now = Date.now) {
        if (expected.missingKnownPullRequest !== undefined)
            throw new CollectorError('PublicationCustomerDecisionRequired');
        return this.branchObservation(scope, manifest, expected, run, now);
    }
    async readOnlyRecoveryObservation(scope, manifest, expected, run, now = Date.now) {
        validatePublicationWire('PublicationManifest', manifest);
        const file = manifest.files[0], current = expected.files[0];
        if (manifest.phase !== 'Prepared' || manifest.files.length !== 1 || expected.files.length !== 1 || manifest.repositoryId !== scope.repositoryId ||
            manifest.branchId !== scope.branchId || manifest.generation !== scope.generation || current.path !== file.path ||
            contentSha256(file.markdown) !== file.sha256 || run.intent !== 'Observe')
            throw new CollectorError('PublicationManifestBindingInvalid');
        publicationPath(file.path);
        if (current.content === file.markdown && current.githubContentSha === gitBlobSha(file.markdown)) {
            if (expected.pullRequest) {
                const written = await this.verifyObserved(scope, manifest, expected);
                return { ...await this.reportObservation(scope, manifest, written, run, now), branchHeadSha: expected.branchHeadSha };
            }
            return expected.missingKnownPullRequest ? this.deletedPullRequestObservation(scope, manifest, expected, run, now) : this.orphanObservation(scope, manifest, expected, run, now);
        }
        if (current.githubContentSha !== file.expectedBaseSha || current.githubContentSha === null && current.content !== '' ||
            current.githubContentSha !== null && current.githubContentSha !== gitBlobSha(current.content))
            throw new CollectorError('PublicationReadOnlyBaseMismatch');
        if (!expected.pullRequest && !expected.missingKnownPullRequest)
            return this.orphanObservation(scope, manifest, expected, run, now);
        if (expected.branchHeadSha === null || expected.pullRequest && expected.branchHeadSha !== expected.pullRequest.headSha ||
            expected.historicalMergedPullRequests.some(number => number !== expected.pullRequest?.number) ||
            !/^[1-9][0-9]{0,31}$/.test(run.runId) || !/^[1-9][0-9]{0,15}$/.test(run.runAttempt))
            throw new CollectorError('PublicationReadOnlyBaseMismatch');
        const observedAt = new Date(now()).toISOString(), commit = await this.commit(scope, expected.branchHeadSha);
        const baseTree = await this.tree(scope, expected.pullRequest?.baseSha ?? expected.targetHeadSha), currentTree = await this.tree(scope, commit.sha);
        if (JSON.stringify(nonOutputEntries(baseTree, file.path)) !== JSON.stringify(nonOutputEntries(currentTree, file.path)))
            throw new CollectorError('PublicationMixedChanges');
        const files = current.githubContentSha === null ? [] : [{ path: file.path, content: current.content, blobSha: current.githubContentSha }];
        let mergedFiles = null, mergeCommitOnTargetRef = false;
        if (expected.pullRequest?.merged) {
            const mergeSha = expected.pullRequest.mergeCommitSha;
            if (!mergeSha)
                throw new CollectorError('PublicationMergeProofMissing');
            const merged = (await this.files(scope, mergeSha, [file.path]))[0];
            if (merged.content !== current.content || merged.githubContentSha !== current.githubContentSha)
                throw new CollectorError('PublicationMergeContentMismatch');
            const comparison = record(await this.request(scope, ['compare', `${mergeSha}...${expected.targetHeadSha}`], 'GET', undefined, { per_page: '1' }));
            if (!['ahead', 'identical'].includes(comparison.status) || record(comparison.merge_base_commit).sha !== mergeSha || record(comparison.base_commit).sha !== mergeSha ||
                !Array.isArray(comparison.commits) || comparison.commits.length > 1 || comparison.commits.some(value => !isSha(record(value).sha)) ||
                comparison.status === 'identical' && (mergeSha !== expected.targetHeadSha || comparison.commits.length !== 0) ||
                comparison.status === 'ahead' && (mergeSha === expected.targetHeadSha || comparison.commits.length !== 1))
                throw new CollectorError('PublicationMergeNotOnTarget');
            await this.commit(scope, expected.targetHeadSha);
            mergedFiles = files;
            mergeCommitOnTargetRef = true;
        }
        await this.unchanged(scope, expected, [file.path]);
        return { schemaVersion: 1, runId: run.runId, runAttempt: run.runAttempt, intent: 'Observe', githubRepositoryId: scope.githubRepositoryId, repositoryFullName: expected.repositoryFullName,
            targetRef: `refs/heads/${scope.refName}`, headRef: `refs/heads/${publicationIdentity(scope).branch}`, targetHeadSha: expected.targetHeadSha,
            commitSha: commit.sha, parentShas: commit.parents, baseFileBlobSha: current.githubContentSha, pullRequestState: expected.pullRequest?.state ?? 'absent',
            merged: expected.pullRequest?.merged ?? false, mergeCommitSha: expected.pullRequest?.mergeCommitSha ?? null,
            files, changedPaths: [], observedAt, mergedFiles, mergeCommitOnTargetRef, branchHeadSha: expected.branchHeadSha };
    }
    async deletedPullRequestObservation(scope, manifest, expected, run, now = Date.now) {
        if (!expected.missingKnownPullRequest || expected.branchHeadSha === null)
            throw new CollectorError('PublicationCustomerDecisionRequired');
        return this.branchObservation(scope, manifest, expected, run, now);
    }
    async branchObservation(scope, manifest, expected, run, now) {
        validatePublicationWire('PublicationManifest', manifest);
        if (manifest.phase !== 'Prepared' || manifest.files.length !== 1 || expected.files.length !== 1 || manifest.repositoryId !== scope.repositoryId ||
            manifest.branchId !== scope.branchId || manifest.generation !== scope.generation)
            throw new CollectorError('PublicationManifestBindingInvalid');
        if (expected.pullRequest || expected.historicalMergedPullRequests.length)
            throw new CollectorError('PublicationCustomerDecisionRequired');
        if (!/^[1-9][0-9]{0,31}$/.test(run.runId) || !/^[1-9][0-9]{0,15}$/.test(run.runAttempt) || !['Publish', 'Observe'].includes(run.intent))
            throw new CollectorError('PublicationObservationRunInvalid');
        const file = manifest.files[0], observedAt = new Date(now()).toISOString();
        publicationPath(file.path);
        if (expected.files[0].path !== file.path || contentSha256(file.markdown) !== file.sha256 || expected.targetHeadSha !== scope.targetHeadSha)
            throw new CollectorError('PublicationManifestBindingInvalid');
        const commitSha = expected.branchHeadSha ?? expected.targetHeadSha;
        const commit = await this.commit(scope, commitSha);
        let baseFile = expected.files[0];
        let changedPaths = [];
        if (expected.branchHeadSha !== null) {
            const boundDeletedNoOp = !!expected.missingKnownPullRequest && run.intent === 'Observe' &&
                expected.files[0].githubContentSha === file.expectedBaseSha && expected.files[0].githubContentSha === gitBlobSha(file.markdown) &&
                expected.files[0].content === file.markdown;
            if (!boundDeletedNoOp && (commit.parents.length !== 1 || commit.message !== this.commitMessage(scope, manifest)))
                throw new CollectorError('PublicationOrphanBranchConflict');
            const baseSha = boundDeletedNoOp ? commitSha : commit.parents[0];
            const parentTree = await this.tree(scope, baseSha), branchTree = await this.tree(scope, commitSha);
            const before = new Map(nonOutputEntries(parentTree, '').map(entry => [entry.path, JSON.stringify(entry)]));
            const after = new Map(nonOutputEntries(branchTree, '').map(entry => [entry.path, JSON.stringify(entry)]));
            changedPaths = [...new Set([...before.keys(), ...after.keys()])].filter(path => before.get(path) !== after.get(path)).sort();
            if (boundDeletedNoOp ? changedPaths.length !== 0 : changedPaths.length !== 1 || changedPaths[0] !== file.path)
                throw new CollectorError('PublicationMixedChanges');
            baseFile = (await this.files(scope, baseSha, [file.path]))[0];
            if (expected.files[0].content !== file.markdown || expected.files[0].githubContentSha !== gitBlobSha(file.markdown))
                throw new CollectorError('PublicationObservedContentMismatch');
        }
        if (baseFile.githubContentSha !== file.expectedBaseSha)
            throw new CollectorError('PublicationObservedBaseMismatch');
        await this.unchanged(scope, expected, [file.path]);
        const current = expected.files[0];
        return { schemaVersion: 1, runId: run.runId, runAttempt: run.runAttempt, intent: run.intent, githubRepositoryId: scope.githubRepositoryId,
            repositoryFullName: expected.repositoryFullName, targetRef: `refs/heads/${scope.refName}`, headRef: `refs/heads/${publicationIdentity(scope).branch}`,
            targetHeadSha: expected.targetHeadSha, commitSha, parentShas: commit.parents, baseFileBlobSha: baseFile.githubContentSha,
            pullRequestState: 'absent', merged: false, mergeCommitSha: null,
            files: current.githubContentSha === null ? [] : [{ path: current.path, content: current.content, blobSha: current.githubContentSha }],
            changedPaths, observedAt, mergedFiles: null, mergeCommitOnTargetRef: false, branchHeadSha: expected.branchHeadSha };
    }
    async finishRecovery(scope, manifest, recovery, expected, run, assertLive) {
        assertLive();
        if (manifest.phase !== 'Prepared' || recovery.manifestId !== manifest.id || recovery.manifestRevision !== manifest.revision)
            throw new CollectorError('PublicationRecoveryBindingInvalid');
        if (recovery.writeFromHeadSha !== undefined) {
            if (recovery.commitSha !== null || !expected.pullRequest || expected.pullRequest.state !== 'open' || expected.pullRequest.merged ||
                expected.branchHeadSha !== recovery.writeFromHeadSha || expected.pullRequest.headSha !== recovery.writeFromHeadSha)
                throw new CollectorError('PublicationRecoveryBindingInvalid');
            return this.write(scope, manifest, expected, assertLive);
        }
        if (recovery.commitSha !== expected.branchHeadSha)
            throw new CollectorError('PublicationRecoveryBindingInvalid');
        if (expected.pullRequest) {
            if (expected.pullRequest.state !== 'open' || expected.pullRequest.merged || recovery.commitSha !== expected.pullRequest.headSha)
                throw new CollectorError('PublicationCustomerDecisionRequired');
            return this.verifyObserved(scope, manifest, expected);
        }
        await this.orphanObservation(scope, manifest, expected, { ...run, intent: 'Publish' });
        assertLive();
        if (recovery.commitSha === null)
            return this.write(scope, manifest, expected, assertLive);
        await this.unchanged(scope, expected, [manifest.files[0].path]);
        const existing = await this.pullRequest(scope);
        if (!existing) {
            assertLive();
            await this.request(scope, ['pulls'], 'POST', { title: 'Update changelog', body: publicationIdentity(scope).marker,
                head: publicationIdentity(scope).branch, base: scope.refName });
        }
        const current = await this.observe(scope, [manifest.files[0].path]);
        if (!current.pullRequest || current.pullRequest.state !== 'open' || current.pullRequest.merged || current.branchHeadSha !== recovery.commitSha ||
            current.pullRequest.headSha !== recovery.commitSha)
            throw new CollectorError('PublicationRecoveryOutcomeUnknown');
        assertLive();
        return this.verifyObserved(scope, manifest, current);
    }
    commitMessage(scope, manifest) {
        return `BumpQuill publication ${manifest.operationId} manifest ${manifest.id} revision ${manifest.revision}\n\n${publicationIdentity(scope).marker}\nsha256:${manifest.files[0].sha256}`;
    }
}
