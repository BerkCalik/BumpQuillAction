import { CollectorError, isDateTime, isSha } from './contracts.js';
import { readJson } from './http.js';
import { createHash } from 'node:crypto';
const defaultApiOrigin = 'https://api.github.com';
const requestTimeoutMs = 30000;
const repositoryResponseBytes = 1048576;
const pullRequestPageBytes = 1048576;
const pageSize = 100;
const maximumAssociatedPullRequests = 1000;
const titleLimit = 1024;
const descriptionLimit = 65536;
function apiOriginOf(value) {
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
            url.port && url.port !== '443' || value !== url.origin && value !== `${url.origin}/`)
            throw new Error();
        return url.origin;
    }
    catch {
        throw new CollectorError('GitHubApiOriginInvalid');
    }
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function safeText(value, limit) {
    return typeof value === 'string' && value.isWellFormed() && value.length <= limit;
}
function plainText(value, limit) {
    return safeText(value, limit) && value.length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
}
function validOwner(value) {
    return typeof value === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(value);
}
function validName(value) {
    return typeof value === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(value) && value !== '.' && value !== '..';
}
function sameRepository(fullName, owner, name) {
    return typeof fullName === 'string' && fullName.toLowerCase() === `${owner}/${name}`.toLowerCase();
}
function observePermissions(value) {
    if (value === undefined || value === null)
        return { status: 'Unavailable' };
    if (!isRecord(value))
        throw new CollectorError('GitHubResponseInvalid');
    const permissions = {};
    for (const key of ['admin', 'maintain', 'push', 'triage', 'pull']) {
        if (!Object.hasOwn(value, key))
            continue;
        if (typeof value[key] !== 'boolean')
            throw new CollectorError('GitHubResponseInvalid');
        permissions[key] = value[key];
    }
    return Object.keys(permissions).length ? { status: 'Observed', permissions } : { status: 'Unavailable' };
}
function rejectedCode(status) {
    if (status >= 300 && status < 400)
        return 'GitHubRedirectRejected';
    if (status === 401 || status === 403)
        return 'GitHubAuthorizationRejected';
    if (status === 404)
        return 'GitHubNotFound';
    return 'GitHubRequestRejected';
}
export class GitHubReader {
    fetcher;
    origin;
    #authorization;
    protectedSignals = new Map();
    constructor(token, fetcher = fetch, apiOrigin = defaultApiOrigin) {
        this.fetcher = fetcher;
        if (typeof token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(token))
            throw new CollectorError('GitHubTokenInvalid');
        this.#authorization = `Bearer ${token}`;
        this.origin = apiOriginOf(apiOrigin);
    }
    url(path, query = {}) {
        const url = new URL(`/${path.map(encodeURIComponent).join('/')}`, this.origin);
        for (const [key, value] of Object.entries(query))
            url.searchParams.set(key, value);
        return url;
    }
    async get(url, maximumBytes) {
        if (url.origin !== this.origin)
            throw new CollectorError('GitHubApiOriginInvalid');
        let response;
        try {
            response = await this.fetcher(url, {
                method: 'GET', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(requestTimeoutMs),
                headers: { Accept: 'application/vnd.github+json', Authorization: this.#authorization,
                    'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'bumpquill-action' },
            });
        }
        catch {
            throw new CollectorError('GitHubRequestFailed');
        }
        try {
            if (response.redirected || response.type === 'opaqueredirect' || response.url && new URL(response.url).origin !== this.origin)
                throw new CollectorError('GitHubRedirectRejected');
            if (!response.ok)
                throw new CollectorError(rejectedCode(response.status));
            try {
                return await readJson(response, maximumBytes);
            }
            catch (error) {
                throw new CollectorError(error instanceof CollectorError && error.code === 'HttpResponseTooLarge' ? 'GitHubResponseTooLarge' : 'GitHubResponseInvalid');
            }
        }
        catch (error) {
            await response.body?.cancel().catch(() => { });
            if (error instanceof CollectorError)
                throw error;
            throw new CollectorError('GitHubResponseInvalid');
        }
    }
    async repository(owner, name) {
        if (!validOwner(owner) || !validName(name))
            throw new CollectorError('GitHubRepositoryInvalid');
        const result = await this.get(this.url(['repos', owner, name]), repositoryResponseBytes);
        if (!isRecord(result) || typeof result.id !== 'number' || !Number.isSafeInteger(result.id) || result.id < 1 ||
            !plainText(result.full_name, 140) || !plainText(result.default_branch, 255))
            throw new CollectorError('GitHubResponseInvalid');
        if (!sameRepository(result.full_name, owner, name))
            throw new CollectorError('GitHubRepositoryMismatch');
        return { id: String(result.id), fullName: result.full_name, defaultBranch: result.default_branch,
            permissionObservation: observePermissions(result.permissions) };
    }
    async pullRequestsForCommit(owner, name, sha) {
        if (!validOwner(owner) || !validName(name))
            throw new CollectorError('GitHubRepositoryInvalid');
        if (!isSha(sha))
            throw new CollectorError('InvalidSourceRef');
        const associated = [];
        for (let page = 1;; page++) {
            const items = await this.get(this.url(['repos', owner, name, 'commits', sha, 'pulls'], { per_page: String(pageSize), page: String(page) }), pullRequestPageBytes);
            if (!Array.isArray(items) || items.length > pageSize)
                throw new CollectorError('GitHubResponseInvalid');
            if (associated.length + items.length > maximumAssociatedPullRequests)
                throw new CollectorError('GitHubPullRequestLimitExceeded');
            associated.push(...items);
            if (items.length < pageSize)
                break;
        }
        const pullRequests = [];
        const seen = new Map();
        const signals = [];
        for (const item of associated) {
            if (!isRecord(item) || typeof item.number !== 'number' || !Number.isSafeInteger(item.number) || item.number < 1 ||
                !safeText(item.title, titleLimit) || item.body !== undefined && item.body !== null && !safeText(item.body, descriptionLimit) ||
                item.merged_at !== null && item.merged_at !== undefined && (typeof item.merged_at !== 'string' || !isDateTime(item.merged_at)) ||
                item.merge_commit_sha !== null && item.merge_commit_sha !== undefined && typeof item.merge_commit_sha !== 'string' ||
                !isRecord(item.base) || !isRecord(item.base.repo))
                throw new CollectorError('GitHubResponseInvalid');
            if (!item.merged_at || !sameRepository(item.base.repo.full_name, owner, name))
                continue;
            if (!isSha(item.merge_commit_sha))
                throw new CollectorError('GitHubResponseInvalid');
            if (item.labels !== undefined) {
                if (!Array.isArray(item.labels) || item.labels.length > 100)
                    throw new CollectorError('GitHubResponseInvalid');
                for (const label of item.labels) {
                    if (!isRecord(label) || !plainText(label.name, 100))
                        throw new CollectorError('GitHubResponseInvalid');
                    const kind = /^(?:breaking[ -]change|breaking)$/iu.test(label.name) ? 'BreakingChangeLabel' :
                        /^(?:security|security[ -]fix)$/iu.test(label.name) ? 'SecurityLabel' : undefined;
                    if (!kind)
                        continue;
                    const sourceReference = `github:${owner}/${name}:pull:${item.number}:label:${label.name}`;
                    const evidenceSha256 = createHash('sha256').update(JSON.stringify({ repository: `${owner}/${name}`, number: item.number,
                        mergeCommitSha: item.merge_commit_sha, label: label.name }), 'utf8').digest('hex');
                    if (!signals.some(signal => signal.sourceReference === sourceReference))
                        signals.push({ kind, sourceReference, evidenceSha256 });
                    if (signals.length > 32)
                        throw new CollectorError('GitHubPullRequestLimitExceeded');
                }
            }
            const request = { number: item.number, title: item.title, effectiveCommitSha: item.merge_commit_sha };
            if (typeof item.body === 'string' && item.body)
                request.description = item.body;
            const key = JSON.stringify(request);
            const previous = seen.get(request.number);
            if (previous !== undefined) {
                if (previous !== key)
                    throw new CollectorError('GitHubResponseInvalid');
                continue;
            }
            seen.set(request.number, key);
            pullRequests.push(request);
        }
        if (this.protectedSignals.size >= 1000)
            throw new CollectorError('GitHubPullRequestLimitExceeded');
        this.protectedSignals.set(`${owner}/${name}/${sha}`, signals);
        return pullRequests;
    }
    protectedEvidenceForCommit(owner, name, sha) {
        const evidence = this.protectedSignals.get(`${owner}/${name}/${sha}`);
        if (!evidence)
            throw new CollectorError('GitHubCommitEvidenceUnavailable');
        return structuredClone(evidence);
    }
}
