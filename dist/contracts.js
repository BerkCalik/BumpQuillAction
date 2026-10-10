import { createHash } from 'node:crypto';
import { wireSchemas } from './wire-schemas.js';
import { validateObservation } from './observation-report.js';
const uuidSchema = { type: 'string', format: 'uuid' };
const integerSchema = { type: 'integer', minimum: 0, maximum: 9007199254740991 };
const sourceShaSchema = { type: 'string', minLength: 40, maxLength: 64, pattern: '^[0-9a-f]+$' };
const digestSchema = { type: 'string', pattern: '^[0-9a-f]{64}$' };
const inputBytesSchema = { type: 'integer', minimum: 0, maximum: 10485760 };
const nullableUuidSchema = { anyOf: [uuidSchema, { type: 'null' }] };
export const inputRoutingSchemas = {
    JobMode: { type: 'string', enum: ['Continuous', 'Preview', 'HistoryBackfill', 'Reanalysis'] },
    JobStatus: { type: 'string', enum: ['AwaitingInput', 'Queued', 'Blocked', 'Running', 'CancelRequested', 'Succeeded', 'NoChanges', 'Failed', 'Cancelled'] },
    Job: { type: 'object', properties: {
            id: uuidSchema, organizationId: uuidSchema, repositoryId: uuidSchema, branchId: uuidSchema, generation: integerSchema,
            mode: { $ref: '#/components/schemas/JobMode' }, status: { $ref: '#/components/schemas/JobStatus' },
            reason: { anyOf: [{ type: 'string' }, { type: 'null' }] }, fromSha: sourceShaSchema, toSha: sourceShaSchema,
            configSnapshotId: uuidSchema, settlementStatus: { type: 'string', enum: ['Pending', 'Finalized'] },
            creditsUsed: { anyOf: [integerSchema, { type: 'null' }] }, publishOperationIds: { type: 'array', items: uuidSchema },
            version: integerSchema, requestedByUserId: nullableUuidSchema, allowedActions: { type: 'array', items: { type: 'string' } },
        }, required: ['id', 'organizationId', 'repositoryId', 'branchId', 'generation', 'mode', 'status', 'configSnapshotId', 'settlementStatus', 'version'], additionalProperties: false },
    ActionJobCreate: { type: 'object', properties: {
            branchId: uuidSchema, expectedGeneration: integerSchema, fromSha: sourceShaSchema, toSha: sourceShaSchema,
            mode: { $ref: '#/components/schemas/JobMode' }, manualRequestId: nullableUuidSchema,
            inputSha256: digestSchema, inputBytes: inputBytesSchema, configSnapshotId: uuidSchema,
        }, required: ['branchId', 'expectedGeneration', 'fromSha', 'toSha', 'mode', 'inputSha256', 'inputBytes', 'configSnapshotId'], additionalProperties: false,
        allOf: [{ if: { properties: { mode: { enum: ['Preview', 'HistoryBackfill', 'Reanalysis'] } }, required: ['mode'] },
                then: { required: ['manualRequestId'], properties: { manualRequestId: uuidSchema } } }] },
    ClaimRequest: { type: 'object', properties: { expectedVersion: integerSchema, expectedGeneration: integerSchema }, required: ['expectedVersion', 'expectedGeneration'], additionalProperties: false },
    UploadRequest: { type: 'object', properties: { sha256: digestSchema, bytes: inputBytesSchema, contentType: { type: 'string', enum: ['application/json'] } }, required: ['sha256', 'bytes', 'contentType'], additionalProperties: false },
    UploadTicket: { type: 'object', properties: { objectId: uuidSchema, uploadUrl: { type: 'string', format: 'uri' }, expiresAt: { type: 'string', format: 'date-time' }, requiredHeaders: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['objectId', 'uploadUrl', 'expiresAt', 'requiredHeaders'], additionalProperties: false },
    InputComplete: { type: 'object', properties: { sourceProof: { $ref: '#/components/schemas/CollectorSourceProof' }, objectId: uuidSchema, sha256: digestSchema, bytes: inputBytesSchema }, required: ['objectId', 'sha256', 'bytes'], additionalProperties: false },
};
export class CollectorError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = 'CollectorError';
    }
}
export function isSha(value) {
    return typeof value === 'string' && /^[0-9a-f]{40,64}$/.test(value);
}
export function isDateTime(value) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))
        return false;
    const parsed = Date.parse(value);
    const day = Number(value.slice(8, 10));
    const month = Number(value.slice(5, 7));
    const year = Number(value.slice(0, 4));
    return Number.isFinite(parsed) && month >= 1 && month <= 12 && day >= 1 &&
        day <= new Date(Date.UTC(year, month, 0)).getUTCDate() && Number(value.slice(11, 13)) < 24 &&
        Number(value.slice(14, 16)) < 60 && Number(value.slice(17, 19)) < 60;
}
function matches(value, schema, depth = 0) {
    if (depth > 32)
        return false;
    if (schema.$ref) {
        const name = schema.$ref.split('/').at(-1);
        return matches(value, (wireSchemas[name] ?? inputRoutingSchemas[name]), depth + 1);
    }
    if (schema.allOf && !schema.allOf.every(candidate => matches(value, candidate, depth + 1)))
        return false;
    if (schema.not && matches(value, schema.not, depth + 1))
        return false;
    if (schema.if) {
        const branch = matches(value, schema.if, depth + 1) ? schema.then : schema.else;
        if (branch && !matches(value, branch, depth + 1))
            return false;
    }
    if (schema.anyOf)
        return schema.anyOf.some(candidate => matches(value, candidate, depth + 1));
    if ('const' in schema && value !== schema.const)
        return false;
    if (schema.enum && !schema.enum.includes(value))
        return false;
    if (schema.type === 'null')
        return value === null;
    if (schema.type === 'boolean')
        return typeof value === 'boolean';
    if (schema.type === 'integer')
        return typeof value === 'number' && Number.isSafeInteger(value) &&
            (schema.minimum === undefined || value >= schema.minimum) && (schema.maximum === undefined || value <= schema.maximum);
    if (schema.type === 'string') {
        if (typeof value !== 'string' || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value))
            return false;
        const length = Array.from(value).length;
        if (schema.minLength !== undefined && length < schema.minLength || schema.maxLength !== undefined && length > schema.maxLength)
            return false;
        if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value))
            return false;
        if (schema.format === 'uuid' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
            return false;
        if (schema.format === 'date-time' && !isDateTime(value))
            return false;
        return true;
    }
    if (schema.type === 'array')
        return Array.isArray(value) &&
            (schema.minItems === undefined || value.length >= schema.minItems) &&
            (schema.maxItems === undefined || value.length <= schema.maxItems) && value.every(item => matches(item, schema.items, depth + 1));
    if (schema.type === 'object' || schema.type === undefined && (schema.properties || schema.required)) {
        if (value === null || typeof value !== 'object' || Array.isArray(value))
            return false;
        const object = value;
        if (schema.required?.some(key => !Object.hasOwn(object, key)))
            return false;
        return Object.entries(object).every(([key, entry]) => {
            if (Object.hasOwn(schema.properties ?? {}, key))
                return matches(entry, schema.properties[key], depth + 1);
            if (schema.additionalProperties === false)
                return false;
            return typeof schema.additionalProperties !== 'object' || matches(entry, schema.additionalProperties, depth + 1);
        });
    }
    return schema.type === undefined;
}
export function validateWire(name, value) {
    const schema = wireSchemas[name] ?? inputRoutingSchemas[name];
    if (!schema || !matches(value, schema))
        throw new CollectorError('WireContractInvalid');
    return value;
}
export function validateClaimedManualRequest(value) {
    const metadata = validateWire('ManualRequestMetadata', value);
    if (!metadata.jobId || !metadata.organizationId || !metadata.repositoryId || metadata.generation === undefined ||
        !metadata.requestedByUserId || !metadata.configuration)
        throw new CollectorError('ManualBindingMissing');
    return validateWire('ClaimedManualRequestMetadata', metadata);
}
export function constructExchange(projectKey, oidcToken) {
    if (!projectKey || !oidcToken || projectKey.length > 8192 || oidcToken.length > 32768)
        throw new CollectorError('CredentialsInvalid');
    return validateWire('ActionExchange', { projectKey, oidcToken, mode: 'Collector', actionVersion: '0.0.0' });
}
export function constructSync(githubRepositoryId, refName, headSha, observation) {
    return validateActionSync({ githubRepositoryId, refName, headSha, ...(observation === undefined ? {} : { observation }) });
}
export function validateActionSync(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new CollectorError('WireContractInvalid');
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).some(key => typeof key !== 'string') ||
        Object.values(Object.getOwnPropertyDescriptors(value)).some(descriptor => !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')))
        throw new CollectorError('WireContractInvalid');
    const object = value;
    validateWire('ActionSync', object);
    if (Object.hasOwn(object, 'observation'))
        validateObservation(object.observation);
    return object;
}
export function assertNoCredentials(value, excludedValues) {
    if (typeof value === 'string' && excludedValues.some(secret => secret.length > 0 && value.includes(secret)))
        throw new CollectorError('CredentialContentRejected');
    if (Array.isArray(value))
        for (const entry of value)
            assertNoCredentials(entry, excludedValues);
    else if (value !== null && typeof value === 'object')
        for (const [key, entry] of Object.entries(value)) {
            assertNoCredentials(key, excludedValues);
            assertNoCredentials(entry, excludedValues);
        }
}
export function serializeAnalysisInput(value, excludedValues = []) {
    validateWire('AnalysisInputPayload', value);
    assertNoCredentials(value, excludedValues);
    const bytes = Buffer.from(JSON.stringify(value), 'utf8');
    if (bytes.byteLength > 10485760)
        throw new CollectorError('InputLimitExceeded');
    const serialized = JSON.parse(bytes.toString('utf8'));
    validateWire('AnalysisInputPayload', serialized);
    assertNoCredentials(serialized, excludedValues);
    return { bytes, size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
}
