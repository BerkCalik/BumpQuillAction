import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { CollectorError, assertNoCredentials, constructExchange, validateActionSync, validateClaimedManualRequest, validateWire } from './contracts.js';
import { maximumSyncBodyBytes, sha256Text, validateObservation } from './observation-report.js';
export function httpsOrigin(value) {
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.port && url.port !== '443')
            throw new Error();
        return url.origin;
    }
    catch {
        throw new CollectorError('HttpsOriginRequired');
    }
}
export async function readJson(response, maximumBytes = 1048576) {
    if (!response.ok || response.redirected)
        throw new CollectorError('HttpRequestRejected');
    if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''))
        throw new CollectorError('HttpResponseInvalid');
    const declared = response.headers.get('content-length');
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes))
        throw new CollectorError('HttpResponseTooLarge');
    if (!response.body)
        throw new CollectorError('HttpResponseInvalid');
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done)
                break;
            size += value.byteLength;
            if (size > maximumBytes)
                throw new CollectorError('HttpResponseTooLarge');
            chunks.push(value);
        }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    }
    catch (error) {
        if (error instanceof CollectorError)
            throw error;
        throw new CollectorError('HttpResponseInvalid');
    }
    finally {
        await reader.cancel().catch(() => { });
        reader.releaseLock();
    }
}
export async function requestJson(fetcher, url, init) {
    try {
        return await readJson(await fetcher(url, { ...init, redirect: 'error', signal: init.signal
                ? AbortSignal.any([init.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) }));
    }
    catch (error) {
        if (error instanceof CollectorError)
            throw error;
        throw new CollectorError('HttpRequestFailed');
    }
}
export async function requestGitHubOidc(env, audience, fetcher = fetch, signal) {
    if (env.GITHUB_ACTIONS !== 'true' || !env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ||
        !audience || audience.length > 512 || /[\u0000-\u001f\u007f]/u.test(audience))
        throw new CollectorError('ActionOidcUnavailable');
    let url;
    try {
        url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
        if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port && url.port !== '443' ||
            !(url.hostname === 'actions.githubusercontent.com' || url.hostname.endsWith('.actions.githubusercontent.com')))
            throw new Error();
        url.searchParams.set('audience', audience);
    }
    catch {
        throw new CollectorError('ActionOidcOriginInvalid');
    }
    const result = await requestJson(fetcher, url, { method: 'GET', headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`, Accept: 'application/json' }, signal });
    if (result === null || typeof result !== 'object' || Array.isArray(result) || !('value' in result) ||
        typeof result.value !== 'string' || !result.value || result.value.length > 32768)
        throw new CollectorError('ActionOidcResponseInvalid');
    return result.value;
}
function requireUuid(value) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
        throw new CollectorError('WireContractInvalid');
}
export class BackendClient {
    fetcher;
    now;
    options;
    origin;
    #token;
    #oidcSha256;
    #exchangeCredentials = [];
    #syncBodies = new Map();
    #mutationBodies = new Map();
    constructor(origin, fetcher = fetch, now = Date.now, options = {}) {
        this.fetcher = fetcher;
        this.now = now;
        this.options = options;
        this.origin = httpsOrigin(origin);
    }
    async exchange(projectKey, oidcToken) {
        const token = validateWire('ActionToken', await requestJson(this.fetcher, new URL('/v1/action/auth/exchange', this.origin), {
            method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify(constructExchange(projectKey, oidcToken)), signal: this.options.signal,
        }));
        if (!token.accessToken || token.accessToken.length > 32768 || /[\r\n]/u.test(token.accessToken) ||
            Date.parse(token.expiresAt) <= this.now() || !token.scopes.includes('collector:sync'))
            throw new CollectorError('CollectorCapabilityInvalid');
        this.#token = token;
        this.#oidcSha256 = sha256Text(oidcToken);
        this.#exchangeCredentials = [projectKey, oidcToken];
        this.#syncBodies.clear();
        this.#mutationBodies.clear();
        return token;
    }
    async sync(input, idempotencyKey) {
        validateActionSync(input);
        if (!this.#token || Date.parse(this.#token.expiresAt) <= this.now())
            throw new CollectorError('CollectorTokenExpired');
        if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(idempotencyKey))
            throw new CollectorError('IdempotencyKeyInvalid');
        if (Object.hasOwn(input, 'observation')) {
            const report = validateObservation(input.observation);
            if (report.oidcSha256 !== this.#oidcSha256 || report.accessTokenSha256 !== sha256Text(this.#token.accessToken) ||
                report.githubRepositoryId !== input.githubRepositoryId || report.ref !== `refs/heads/${input.refName}` || report.headSha !== input.headSha)
                throw new CollectorError('ObservationScopeMismatch');
        }
        assertNoCredentials(input, [...this.#exchangeCredentials, this.#token.accessToken]);
        const proposedBody = JSON.stringify(input);
        if (Buffer.byteLength(proposedBody, 'utf8') > maximumSyncBodyBytes)
            throw new CollectorError('ObservationTooLarge');
        const previousBody = this.#syncBodies.get(idempotencyKey);
        if (previousBody !== undefined && previousBody !== proposedBody)
            throw new CollectorError('SyncRetryChanged');
        const body = previousBody ?? proposedBody;
        this.#syncBodies.set(idempotencyKey, body);
        return validateWire('SyncResult', await requestJson(this.fetcher, new URL('/v1/action/sync', this.origin), {
            method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json',
                Authorization: `Bearer ${this.#token.accessToken}`, 'Idempotency-Key': idempotencyKey }, body, signal: this.options.signal,
        }));
    }
    signal(scope, deadline = Infinity) {
        if (this.options.signal?.aborted)
            throw new CollectorError('CollectorCancelled');
        if (!this.#token || Date.parse(this.#token.expiresAt) <= this.now())
            throw new CollectorError('CollectorTokenExpired');
        if (!this.#token.scopes.includes(scope))
            throw new CollectorError('CollectorCapabilityInvalid');
        const remaining = Math.min(30000, Date.parse(this.#token.expiresAt) - this.now(), deadline - this.now());
        if (remaining <= 0)
            throw new CollectorError('InputDeadlineExpired');
        const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(remaining)));
        return this.options.signal ? AbortSignal.any([this.options.signal, timeout]) : timeout;
    }
    async scoped(path, scope, responseSchema, input, idempotencyKey, deadline = Infinity) {
        let body;
        if (input !== undefined) {
            if (!idempotencyKey || !/^[a-zA-Z0-9._:-]{1,128}$/.test(idempotencyKey))
                throw new CollectorError('IdempotencyKeyInvalid');
            assertNoCredentials(input, [...this.#exchangeCredentials, this.#token?.accessToken ?? '']);
            body = JSON.stringify(input);
            if (Buffer.byteLength(body) > 65536)
                throw new CollectorError('InputLimitExceeded');
            const key = `${path}:${idempotencyKey}`;
            const previous = this.#mutationBodies.get(key);
            if (previous !== undefined && previous !== body)
                throw new CollectorError('MutationRetryChanged');
            this.#mutationBodies.set(key, body);
        }
        for (let attempt = 0; attempt < 3; attempt++) {
            const signal = this.signal(scope, deadline);
            let retry = false;
            try {
                const response = await this.fetcher(new URL(path, this.origin), { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal,
                    headers: { Accept: 'application/json', Authorization: `Bearer ${this.#token.accessToken}`,
                        ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }) }, body });
                if (response.redirected)
                    throw new CollectorError('HttpRequestRejected');
                if ([408, 429, 500, 502, 503, 504].includes(response.status)) {
                    await response.body?.cancel().catch(() => { });
                    retry = true;
                }
                else {
                    const value = validateWire(responseSchema, await readJson(response));
                    assertNoCredentials(value, [...this.#exchangeCredentials, this.#token.accessToken]);
                    return value;
                }
            }
            catch (error) {
                if (this.options.signal?.aborted)
                    throw new CollectorError('CollectorCancelled');
                if (error instanceof CollectorError)
                    throw error;
                if (signal.aborted)
                    throw new CollectorError('HttpRequestTimedOut');
                retry = true;
            }
            if (retry && attempt < 2) {
                try {
                    const waitSignal = this.signal(scope, deadline);
                    await (this.options.wait ?? ((milliseconds, signal) => delay(milliseconds, undefined, { signal })))(250 * 2 ** attempt, waitSignal);
                }
                catch (error) {
                    if (error instanceof CollectorError)
                        throw error;
                    throw new CollectorError(this.options.signal?.aborted ? 'CollectorCancelled' : 'HttpRequestTimedOut');
                }
            }
        }
        throw new CollectorError('HttpRetryExhausted');
    }
    async claimRequest(requestId, expectedVersion, expectedGeneration, idempotencyKey, deadline = Infinity) {
        requireUuid(requestId);
        const body = validateWire('ClaimRequest', { expectedVersion, expectedGeneration });
        return validateClaimedManualRequest(await this.scoped(`/v1/action/requests/${requestId}/claim`, 'collector:requests', 'ClaimedManualRequestMetadata', body, idempotencyKey, deadline));
    }
    async createJob(input, idempotencyKey, deadline = Infinity) {
        return this.scoped('/v1/action/jobs', 'collector:jobs', 'Job', validateWire('ActionJobCreate', input), idempotencyKey, deadline);
    }
    async uploadTicket(jobId, input, idempotencyKey, deadline = Infinity) {
        requireUuid(jobId);
        return this.scoped(`/v1/action/jobs/${jobId}/upload`, 'collector:input', 'UploadTicket', validateWire('UploadRequest', input), idempotencyKey, deadline);
    }
    async completeInput(jobId, input, idempotencyKey, deadline = Infinity) {
        requireUuid(jobId);
        return this.scoped(`/v1/action/jobs/${jobId}/input/complete`, 'collector:input', 'Job', validateWire('InputComplete', input), idempotencyKey, deadline);
    }
    async job(jobId, deadline = Infinity) {
        requireUuid(jobId);
        return this.scoped(`/v1/action/jobs/${jobId}`, 'jobs:read', 'Job', undefined, undefined, deadline);
    }
    validateInput(bytes) {
        if (bytes.byteLength > 10485760)
            throw new CollectorError('InputLimitExceeded');
        let payload;
        try {
            payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        }
        catch {
            throw new CollectorError('WireContractInvalid');
        }
        validateWire('AnalysisInputPayload', payload);
        assertNoCredentials(payload, [...this.#exchangeCredentials, this.#token?.accessToken ?? '']);
    }
    async putInput(ticket, input, job, deadline = Infinity) {
        validateWire('UploadTicket', ticket);
        validateWire('Job', job);
        this.validateInput(input.bytes);
        if (input.size !== input.bytes.byteLength || createHash('sha256').update(input.bytes).digest('hex') !== input.sha256)
            throw new CollectorError('InputHashMismatch');
        let url;
        const headers = new Headers();
        const expected = { 'content-type': 'application/json', 'content-length': String(input.size),
            'if-none-match': '*', 'x-amz-checksum-sha256': Buffer.from(input.sha256, 'hex').toString('base64'), 'x-amz-server-side-encryption': 'AES256',
            'x-amz-meta-bq-tenant': job.organizationId, 'x-amz-meta-bq-job': job.id, 'x-amz-meta-bq-object': ticket.objectId,
            'x-amz-meta-bq-bytes': String(input.size), 'x-amz-meta-bq-policy': '1' };
        try {
            url = new URL(ticket.uploadUrl);
            if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port && url.port !== '443' ||
                !/^[0-9a-f]{64}$/i.test(url.searchParams.get('X-Amz-Signature') ?? ''))
                throw new Error();
            const signed = new Set((url.searchParams.get('X-Amz-SignedHeaders') ?? '').split(';'));
            for (const [name, value] of Object.entries(ticket.requiredHeaders)) {
                const normalized = name.toLowerCase();
                if (!Object.hasOwn(expected, normalized) || headers.has(normalized) || expected[normalized] !== value || !signed.has(normalized))
                    throw new Error();
                headers.set(normalized, value);
            }
            if (Object.keys(expected).some(name => !headers.has(name)))
                throw new Error();
            assertNoCredentials(ticket, [...this.#exchangeCredentials, this.#token?.accessToken ?? '']);
        }
        catch {
            throw new CollectorError('UploadTicketInvalid');
        }
        for (let attempt = 0; attempt < 3; attempt++) {
            const signal = this.signal('collector:input', Math.min(deadline, Date.parse(ticket.expiresAt)));
            try {
                const response = await this.fetcher(url, { method: 'PUT', headers, body: Uint8Array.from(input.bytes), redirect: 'error', signal, credentials: 'omit' });
                await response.body?.cancel().catch(() => { });
                if (response.redirected)
                    throw new CollectorError('InputUploadRejected');
                if (response.ok)
                    return 'Stored';
                if (response.status === 412)
                    return 'AlreadyPresent';
                if (![408, 429, 500, 502, 503, 504].includes(response.status))
                    throw new CollectorError('InputUploadRejected');
            }
            catch (error) {
                if (this.options.signal?.aborted)
                    throw new CollectorError('CollectorCancelled');
                if (error instanceof CollectorError)
                    throw error;
                if (signal.aborted)
                    throw new CollectorError('InputUploadFailed');
            }
            if (attempt < 2) {
                try {
                    const waitSignal = this.signal('collector:input', Math.min(deadline, Date.parse(ticket.expiresAt)));
                    await (this.options.wait ?? ((milliseconds, signal) => delay(milliseconds, undefined, { signal })))(250 * 2 ** attempt, waitSignal);
                }
                catch (error) {
                    if (error instanceof CollectorError)
                        throw error;
                    throw new CollectorError(this.options.signal?.aborted ? 'CollectorCancelled' : 'InputUploadFailed');
                }
            }
        }
        throw new CollectorError('InputUploadFailed');
    }
}
