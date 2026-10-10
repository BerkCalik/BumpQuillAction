import { CollectorError, assertNoCredentials, isDateTime, validateWire } from './contracts.js';
import { httpsOrigin, readJson } from './http.js';
import { createHash } from 'node:crypto';
export const maximumPublicationReportBytes = 6 * 10485760 + 65536;
const uuid = { type: 'string', format: 'uuid' };
const integer = { type: 'integer', minimum: 0, maximum: 9007199254740991 };
const sourceSha = { type: 'string', minLength: 40, maxLength: 64, pattern: '^[0-9a-f]+$' };
const digest = { type: 'string', pattern: '^[0-9a-f]{64}$' };
const string = { type: 'string' };
const reference = (name) => ({ $ref: `#/components/schemas/${name}` });
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const array = (schema) => ({ type: 'array', items: schema });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
export const publicationSchemas = {
    PublishStatus: { type: 'string', enum: ['Ready', 'Claimed', 'Publishing', 'OpenPR', 'Merged', 'ClosedAwaitingDecision', 'Conflict', 'Failed'] },
    PublishOperation: object({ id: uuid, repositoryId: uuid, branchId: uuid, generation: integer, status: reference('PublishStatus'),
        pullRequestNumber: nullable({ type: 'integer', minimum: 1 }), version: integer, organizationId: uuid, jobId: uuid, refName: string, headRef: string,
        decisionEntries: { ...array(object({ entryId: uuid, sourceJobId: uuid, selectedRevision: { ...integer, minimum: 1 },
                currentRevision: { ...integer, minimum: 1 }, decisionRequired: { type: 'boolean' }, carried: { type: 'boolean' } })), maxItems: 1000 }
    }, ['id', 'repositoryId', 'branchId', 'generation', 'status', 'version']),
    PublishOperationPage: object({ items: array(reference('PublishOperation')), nextCursor: nullable(string) }),
    PublisherClaimRequest: object({ expectedVersion: integer, expectedGeneration: integer, intent: { type: 'string', enum: ['Publish', 'Observe'] }, pullRequestHeadSha: nullable(sourceSha) }, ['expectedVersion', 'expectedGeneration', 'intent']),
    PublishClaim: { ...object({ operationId: uuid, leaseToken: string, fencingVersion: integer, expiresAt: { type: 'string', format: 'date-time' },
            readOnlyRecovery: { type: 'boolean', const: true },
            recovery: { ...object({ manifestId: uuid, manifestRevision: integer, commitSha: nullable(sourceSha),
                    writeFromHeadSha: { type: 'string', minLength: 40, maxLength: 64, pattern: '^(?:[0-9a-f]{40}|[0-9a-f]{64})$' } }, ['manifestId', 'manifestRevision', 'commitSha']), allOf: [{ if: { required: ['writeFromHeadSha'] }, then: { properties: { commitSha: { type: 'null' } } } }] }
        }, ['operationId', 'leaseToken', 'fencingVersion', 'expiresAt']), not: { required: ['readOnlyRecovery', 'recovery'] } },
    ManifestEntry: object({ entryId: uuid, revision: integer }),
    ManifestFile: object({ path: string, markdown: string, sha256: digest, expectedBaseSha: nullable(sourceSha) }),
    CurrentChangelogFile: object({ path: string, content: string, githubContentSha: nullable(sourceSha) }),
    PublicationManifest: object({ id: uuid, operationId: uuid, revision: integer, repositoryId: uuid, branchId: uuid, generation: integer,
        files: array(reference('ManifestFile')), entries: array(reference('ManifestEntry')), phase: { type: 'string', enum: ['Candidate', 'Prepared'] } }),
    PublicationPrepare: { ...object({ expectedVersion: integer, fencingVersion: integer, targetHeadSha: sourceSha, pullRequestHeadSha: nullable(sourceSha),
            files: array(reference('CurrentChangelogFile')) }, ['expectedVersion', 'fencingVersion', 'targetHeadSha', 'files']), 'x-total-byte-limit': 10485760 },
    PublicationReport: object({ operationId: uuid, manifestId: uuid, manifestRevision: integer, fencingVersion: integer,
        outcome: { type: 'string', enum: ['Ready', 'OpenPR', 'Merged', 'ClosedAwaitingDecision', 'Conflict', 'Failed'] }, pullRequestNumber: { type: 'integer', minimum: 1 },
        githubCommitSha: sourceSha, contentSha256: digest, observedEntryRevisions: array(reference('ManifestEntry')), reason: string, observation: reference('PublicationObservation') }, ['operationId', 'manifestId', 'manifestRevision', 'fencingVersion', 'outcome']),
    PublicationObservedFile: object({ path: { type: 'string', minLength: 1, maxLength: 1024 }, content: { type: 'string', maxLength: 10485760 }, blobSha: sourceSha }),
    PublicationObservation: object({ schemaVersion: { type: 'integer', const: 1 },
        runId: { type: 'string', pattern: '^[1-9][0-9]{0,31}$' }, runAttempt: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' }, intent: { type: 'string', enum: ['Publish', 'Observe'] },
        githubRepositoryId: { type: 'string', pattern: '^[1-9][0-9]{0,31}$' }, repositoryFullName: { type: 'string', minLength: 3, maxLength: 140 },
        targetRef: { type: 'string', minLength: 12, maxLength: 1035 }, headRef: { type: 'string', minLength: 12, maxLength: 1035 },
        targetHeadSha: sourceSha, commitSha: sourceSha, parentShas: { ...array(sourceSha), maxItems: 2 }, baseFileBlobSha: nullable(sourceSha),
        pullRequestState: { type: 'string', enum: ['open', 'closed', 'absent'] }, merged: { type: 'boolean' }, mergeCommitSha: nullable(sourceSha),
        files: { ...array(reference('PublicationObservedFile')), maxItems: 1 }, changedPaths: { ...array({ type: 'string', minLength: 1, maxLength: 1024 }), maxItems: 1 },
        observedAt: { type: 'string', format: 'date-time' }, mergedFiles: nullable({ ...array(reference('PublicationObservedFile')), maxItems: 1 }), mergeCommitOnTargetRef: { type: 'boolean' },
        branchHeadSha: nullable(sourceSha) }, ['schemaVersion', 'runId', 'runAttempt', 'intent', 'githubRepositoryId', 'repositoryFullName', 'targetRef', 'headRef', 'targetHeadSha',
        'commitSha', 'parentShas', 'baseFileBlobSha', 'pullRequestState', 'merged', 'mergeCommitSha', 'files', 'changedPaths', 'observedAt', 'mergedFiles', 'mergeCommitOnTargetRef']),
};
function publicationMatches(value, schema, depth = 0) {
    if (depth > 32)
        return false;
    if ('const' in schema && value !== schema.const)
        return false;
    if (schema.not && publicationMatches(value, schema.not, depth + 1) || schema.allOf && !schema.allOf.every(part => publicationMatches(value, part, depth + 1)) ||
        schema.if && publicationMatches(value, schema.if, depth + 1) && schema.then && !publicationMatches(value, schema.then, depth + 1))
        return false;
    if (schema.type === undefined && !schema.$ref && !schema.anyOf) {
        if (value === null || typeof value !== 'object' || Array.isArray(value))
            return false;
        const object = value;
        return (schema.required ?? []).every(key => Object.hasOwn(object, key)) && Object.entries(schema.properties ?? {}).every(([key, property]) => !Object.hasOwn(object, key) || publicationMatches(object[key], property, depth + 1));
    }
    if (schema.$ref) {
        const resolved = publicationSchemas[schema.$ref.split('/').at(-1)];
        return resolved !== undefined && publicationMatches(value, resolved, depth + 1);
    }
    if (schema.anyOf)
        return schema.anyOf.some(candidate => publicationMatches(value, candidate, depth + 1));
    if (schema.type === 'null')
        return value === null;
    if (schema.type === 'boolean')
        return typeof value === 'boolean';
    if (schema.type === 'string')
        return typeof value === 'string' && value.isWellFormed() &&
            (schema.minLength === undefined || Array.from(value).length >= schema.minLength) && (schema.maxLength === undefined || Array.from(value).length <= schema.maxLength) &&
            (!schema.enum || schema.enum.includes(value)) && (!schema.pattern || new RegExp(schema.pattern).test(value)) &&
            (schema.format !== 'uuid' || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) && (schema.format !== 'date-time' || isDateTime(value));
    if (schema.type === 'integer')
        return typeof value === 'number' && Number.isSafeInteger(value) &&
            (schema.minimum === undefined || value >= schema.minimum) && (schema.maximum === undefined || value <= schema.maximum);
    if (schema.type === 'array')
        return Array.isArray(value) && (schema.maxItems === undefined || value.length <= schema.maxItems) && value.every(item => publicationMatches(item, schema.items, depth + 1));
    if (schema.type !== 'object' || value === null || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        return false;
    if (Reflect.ownKeys(value).some(key => typeof key !== 'string') || Object.values(Object.getOwnPropertyDescriptors(value)).some(descriptor => !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')))
        return false;
    const input = value;
    return schema.required.every(key => Object.hasOwn(input, key)) && Object.entries(input).every(([key, field]) => Object.hasOwn(schema.properties, key) && publicationMatches(field, schema.properties[key], depth + 1));
}
export function validatePublicationWire(name, value) {
    const schema = publicationSchemas[name];
    if (!schema || !publicationMatches(value, schema))
        throw new CollectorError('WireContractInvalid');
    return value;
}
export function requirePublisherUuid(value) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value))
        throw new CollectorError('PublicationScopeInvalid');
}
export class PublisherBackendClient {
    fetcher;
    now;
    options;
    origin;
    #token;
    #credentials = [];
    #bodies = new Map();
    #claims = new Map();
    #claimIntents = new Map();
    #readOnlyManifests = new Map();
    constructor(origin, fetcher = fetch, now = Date.now, options = {}) {
        this.fetcher = fetcher;
        this.now = now;
        this.options = options;
        this.origin = httpsOrigin(origin);
    }
    async exchange(projectKey, oidcToken) {
        if (!projectKey || projectKey.length > 8192 || !oidcToken || oidcToken.length > 32768)
            throw new CollectorError('CredentialsInvalid');
        const body = validateWire('ActionExchange', { projectKey, oidcToken, mode: 'Publisher', actionVersion: '0.0.0' });
        const response = await this.request('/v1/action/auth/exchange', 'ActionToken', undefined, body);
        const token = validateWire('ActionToken', response);
        if (!/^[\x21-\x7e]{1,32768}$/.test(token.accessToken) || !isDateTime(token.expiresAt) || Date.parse(token.expiresAt) <= this.now() ||
            !['publisher:ready', 'publisher:observe', 'publisher:claim', 'publisher:result', 'publisher:prepare', 'publisher:report'].every(scope => token.scopes.includes(scope)))
            throw new CollectorError('PublisherCapabilityInvalid');
        this.#token = token;
        this.#credentials = [projectKey, oidcToken, token.accessToken];
        this.#bodies.clear();
        this.#claims.clear();
        this.#claimIntents.clear();
        this.#readOnlyManifests.clear();
        return structuredClone(token);
    }
    async page(kind, cursor) {
        if (kind !== 'ready' && kind !== 'reconcile' || cursor !== undefined && (!cursor || cursor.length > 4096 || /[\u0000-\u001f\u007f]/u.test(cursor)))
            throw new CollectorError('PublicationCursorInvalid');
        const query = new URLSearchParams({ limit: '25', ...(cursor === undefined ? {} : { cursor }) });
        return this.request(`/v1/action/publications/${kind}?${query}`, 'PublishOperationPage', kind === 'ready' ? 'publisher:ready' : 'publisher:observe');
    }
    async claim(operationId, input, key) {
        requirePublisherUuid(operationId);
        validatePublicationWire('PublisherClaimRequest', input);
        const claim = await this.request(`/v1/action/publications/${operationId}/claim`, 'PublishClaim', 'publisher:claim', input, key);
        if (claim.operationId !== operationId || !/^[\x21-\x7e]{1,8192}$/.test(claim.leaseToken) || claim.fencingVersion < 1 ||
            Date.parse(claim.expiresAt) <= this.now())
            throw new CollectorError('PublicationClaimInvalid');
        if (claim.recovery && (input.intent !== 'Publish' || claim.recovery.manifestRevision < 1))
            throw new CollectorError('PublicationRecoveryClaimInvalid');
        if (claim.readOnlyRecovery && (input.intent !== 'Observe' || claim.recovery) || claim.recovery?.writeFromHeadSha !== undefined &&
            (claim.recovery.commitSha !== null || claim.recovery.writeFromHeadSha !== input.pullRequestHeadSha))
            throw new CollectorError('PublicationRecoveryClaimInvalid');
        this.#claims.set(claim.operationId, JSON.stringify(claim));
        this.#claimIntents.set(claim.operationId, input.intent);
        this.#readOnlyManifests.delete(claim.operationId);
        return structuredClone(claim);
    }
    async manifest(claim) {
        const manifest = await this.leased(claim, 'manifest', 'PublicationManifest', 'publisher:result');
        if (claim.readOnlyRecovery) {
            const file = manifest.files[0];
            if (manifest.phase !== 'Prepared' || manifest.operationId !== claim.operationId || manifest.files.length !== 1 ||
                createHash('sha256').update(file.markdown).digest('hex') !== file.sha256)
                throw new CollectorError('PublicationManifestBindingInvalid');
            this.#readOnlyManifests.set(claim.operationId, { id: manifest.id, revision: manifest.revision, path: file.path, sha256: file.sha256,
                blobSha: createHash('sha1').update(`blob ${Buffer.byteLength(file.markdown)}\0`).update(file.markdown).digest('hex'),
                baseSha: file.expectedBaseSha, entries: JSON.stringify(manifest.entries) });
        }
        return manifest;
    }
    async prepare(claim, input, key) {
        if (this.#claimIntents.get(claim.operationId) !== 'Publish')
            throw new CollectorError('PublicationObserveReadOnly');
        validatePublicationWire('PublicationPrepare', input);
        if (input.fencingVersion !== claim.fencingVersion)
            throw new CollectorError('PublicationFenceMismatch');
        return this.leased(claim, 'prepare', 'PublicationManifest', 'publisher:prepare', input, key);
    }
    async report(jobId, claim, input, key) {
        requirePublisherUuid(jobId);
        validatePublicationWire('PublicationReport', input);
        if (input.operationId !== claim.operationId || input.fencingVersion !== claim.fencingVersion)
            throw new CollectorError('PublicationFenceMismatch');
        if (claim.readOnlyRecovery) {
            const observation = validatePublicationWire('PublicationObservation', input.observation);
            const manifest = this.#readOnlyManifests.get(claim.operationId), file = observation.files[0];
            const originalBase = observation.changedPaths.length === 0 && observation.baseFileBlobSha === manifest?.baseSha &&
                (file ? observation.files.length === 1 && file.blobSha === manifest?.baseSha : observation.files.length === 0 && manifest?.baseSha === null);
            const written = observation.files.length === 1 && file.blobSha === manifest?.blobSha &&
                createHash('sha256').update(file.content).digest('hex') === manifest?.sha256 &&
                observation.parentShas.length === 1 && observation.changedPaths.length === 1 && observation.changedPaths[0] === manifest?.path && observation.baseFileBlobSha === manifest?.baseSha;
            if (input.outcome !== 'Conflict' || !manifest || input.manifestId !== manifest.id || input.manifestRevision !== manifest.revision ||
                input.contentSha256 !== manifest.sha256 || JSON.stringify(input.observedEntryRevisions) !== manifest.entries ||
                observation.intent !== 'Observe' || this.#claimIntents.get(claim.operationId) !== 'Observe' || !Object.hasOwn(observation, 'branchHeadSha') ||
                observation.branchHeadSha !== null && observation.branchHeadSha !== observation.commitSha ||
                observation.branchHeadSha === null && observation.pullRequestState === 'absent' && observation.commitSha !== observation.targetHeadSha ||
                file && file.path !== manifest.path || !originalBase && !written ||
                (observation.merged ? observation.mergeCommitSha : observation.commitSha) !== input.githubCommitSha ||
                observation.pullRequestState !== 'absent' && !input.pullRequestNumber ||
                observation.merged && (observation.pullRequestState !== 'closed' || !observation.mergeCommitSha || !observation.mergeCommitOnTargetRef ||
                    observation.mergedFiles?.length !== observation.files.length || JSON.stringify(observation.mergedFiles) !== JSON.stringify(observation.files)) ||
                !observation.merged && (observation.mergeCommitSha !== null || observation.mergedFiles !== null || observation.mergeCommitOnTargetRef))
                throw new CollectorError('PublicationReadOnlyObservationInvalid');
            for (const observed of [...observation.files, ...(observation.mergedFiles ?? [])]) {
                if (Buffer.byteLength(observed.content) > 10485760)
                    throw new CollectorError('PublicationObservationTooLarge');
                if (createHash('sha1').update(`blob ${Buffer.byteLength(observed.content)}\0`).update(observed.content).digest('hex') !== observed.blobSha)
                    throw new CollectorError('PublicationReadOnlyObservationInvalid');
            }
            const observedAt = Date.parse(observation.observedAt);
            if (observedAt > this.now() || this.now() - observedAt > 30000)
                throw new CollectorError('PublicationObservationExpired');
        }
        if (['Ready', 'OpenPR', 'Merged', 'ClosedAwaitingDecision'].includes(input.outcome)) {
            const observation = validatePublicationWire('PublicationObservation', input.observation);
            const absentBranch = input.outcome === 'Ready' && observation.branchHeadSha === null;
            const file = observation.files[0];
            const deletedNoOp = input.outcome === 'ClosedAwaitingDecision' && observation.pullRequestState === 'absent' && observation.intent === 'Observe';
            const boundNoOp = input.outcome !== 'Ready' && !!input.pullRequestNumber && (observation.pullRequestState !== 'absent' || deletedNoOp) &&
                Object.hasOwn(observation, 'branchHeadSha') && observation.branchHeadSha === observation.commitSha && observation.changedPaths.length === 0 &&
                observation.files.length === 1 && observation.baseFileBlobSha === file.blobSha &&
                createHash('sha1').update(`blob ${Buffer.byteLength(file.content)}\0`).update(file.content).digest('hex') === file.blobSha;
            if ((!absentBranch && !boundNoOp && (observation.files.length !== 1 || observation.parentShas.length !== 1 || observation.changedPaths.length !== 1 ||
                observation.changedPaths[0] !== observation.files[0].path)) || observation.intent !== this.#claimIntents.get(claim.operationId) ||
                (input.outcome === 'Merged' ? observation.mergeCommitSha : observation.commitSha) !== input.githubCommitSha)
                throw new CollectorError('PublicationObservationBindingInvalid');
            if (input.outcome === 'Ready' && (observation.intent !== 'Observe' || observation.pullRequestState !== 'absent' || !Object.hasOwn(observation, 'branchHeadSha') ||
                input.pullRequestNumber !== undefined || observation.merged || observation.mergeCommitSha !== null || observation.mergedFiles !== null || observation.mergeCommitOnTargetRef ||
                !absentBranch && observation.branchHeadSha !== observation.commitSha || absentBranch && (observation.commitSha !== observation.targetHeadSha || observation.changedPaths.length !== 0)))
                throw new CollectorError('PublicationRecoveryObservationInvalid');
            if (input.outcome === 'ClosedAwaitingDecision' && observation.pullRequestState === 'absent' && (observation.intent !== 'Observe' ||
                !input.pullRequestNumber || !Object.hasOwn(observation, 'branchHeadSha') || observation.branchHeadSha !== observation.commitSha ||
                observation.merged || observation.mergeCommitSha !== null || observation.mergedFiles !== null || observation.mergeCommitOnTargetRef))
                throw new CollectorError('PublicationDeletedPullRequestInvalid');
            for (const file of [...observation.files, ...(observation.mergedFiles ?? [])])
                if (Buffer.byteLength(file.content) > 10485760)
                    throw new CollectorError('PublicationObservationTooLarge');
            if (!absentBranch && createHash('sha256').update(observation.files[0].content).digest('hex') !== input.contentSha256)
                throw new CollectorError('PublicationObservationBindingInvalid');
            const observed = Date.parse(observation.observedAt);
            if (observed > this.now() || this.now() - observed > 30000)
                throw new CollectorError('PublicationObservationExpired');
        }
        this.checkClaim(claim);
        return this.request(`/v1/action/jobs/${jobId}/publication`, 'PublishOperation', 'publisher:report', input, key, claim);
    }
    checkClaim(claim) {
        validatePublicationWire('PublishClaim', claim);
        requirePublisherUuid(claim.operationId);
        if (this.#claims.get(claim.operationId) !== JSON.stringify(claim))
            throw new CollectorError('PublicationClaimBindingInvalid');
        if (claim.fencingVersion < 1 || !/^[\x21-\x7e]{1,8192}$/.test(claim.leaseToken) || Date.parse(claim.expiresAt) <= this.now())
            throw new CollectorError('PublicationLeaseExpired');
    }
    leased(claim, route, schema, scope, body, key) {
        this.checkClaim(claim);
        return this.request(`/v1/action/publications/${claim.operationId}/${route}`, schema, scope, body, key, claim);
    }
    async request(path, schema, scope, input, key, claim) {
        const body = input === undefined ? undefined : JSON.stringify(input);
        if (body !== undefined && Buffer.byteLength(body) > (path.endsWith('/publication') ? maximumPublicationReportBytes : 10485760))
            throw new CollectorError('PublicationBodyTooLarge');
        if (scope) {
            assertNoCredentials(input, [...this.#credentials, claim?.leaseToken ?? '']);
            if (body !== undefined) {
                if (!key || !/^[a-zA-Z0-9._:-]{1,128}$/.test(key))
                    throw new CollectorError('IdempotencyKeyInvalid');
                const identity = `${path}:${key}`;
                const bodyHash = createHash('sha256').update(body).digest('hex');
                const previous = this.#bodies.get(identity);
                if (previous !== undefined && previous !== bodyHash)
                    throw new CollectorError('PublicationRetryChanged');
                this.#bodies.set(identity, bodyHash);
            }
        }
        for (let attempt = 0; attempt < 3; attempt++) {
            if (this.options.signal?.aborted)
                throw new CollectorError('PublisherCancelled');
            if (scope && (!this.#token || !this.#token.scopes.includes(scope)))
                throw new CollectorError('PublisherCapabilityInvalid');
            const deadline = Math.min(this.#token ? Date.parse(this.#token.expiresAt) : Infinity, claim ? Date.parse(claim.expiresAt) : Infinity);
            const remaining = Math.min(30000, deadline - this.now());
            if (remaining <= 0)
                throw new CollectorError('PublisherTokenOrLeaseExpired');
            const signal = AbortSignal.timeout(Math.max(1, Math.ceil(remaining)));
            try {
                const response = await this.fetcher(new URL(path, this.origin), { method: body === undefined ? 'GET' : 'POST',
                    redirect: 'error', signal: this.options.signal ? AbortSignal.any([this.options.signal, signal]) : signal,
                    headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                        ...(scope ? { Authorization: `Bearer ${this.#token.accessToken}` } : {}),
                        ...(key ? { 'Idempotency-Key': key } : {}), ...(claim ? { 'X-Lease-Token': claim.leaseToken } : {}) }, body });
                if (response.redirected)
                    throw new CollectorError('HttpRequestRejected');
                if (![408, 429, 500, 502, 503, 504].includes(response.status)) {
                    const result = await readJson(response, 16777216);
                    return scope ? validatePublicationWire(schema, result) : validateWire(schema, result);
                }
                await response.body?.cancel().catch(() => { });
            }
            catch (error) {
                if (error instanceof CollectorError)
                    throw error;
            }
            if (attempt < 2)
                await (this.options.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))))(100 * (attempt + 1));
        }
        throw new CollectorError('PublicationHttpUnavailable');
    }
}
