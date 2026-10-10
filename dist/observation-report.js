import { createHash } from 'node:crypto';
import { CollectorError, assertNoCredentials, isSha } from './contracts.js';
import { isBranchName } from './inputs.js';
export const maximumSyncBodyBytes = 98304;
export const observationYamlBytes = 65536;
function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) &&
        [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
        Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => Object.hasOwn(descriptor, 'value'));
}
function exactKeys(value, required, optional = []) {
    const keys = Reflect.ownKeys(value);
    return required.every(key => Object.keys(value).includes(key)) && keys.every(key => typeof key === 'string' && (required.includes(key) || optional.includes(key)));
}
function text(value, maximumBytes) {
    return typeof value === 'string' && value.isWellFormed() && Buffer.byteLength(value, 'utf8') <= maximumBytes;
}
export function sha256Text(value) {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}
export function validateObservation(value) {
    if (!record(value) || !exactKeys(value, ['schemaVersion', 'oidcSha256', 'accessTokenSha256', 'githubRepositoryId',
        'repositoryFullName', 'ref', 'headSha', 'runId', 'runAttempt', 'defaultBranch', 'permissionObservation', 'yaml']) || value.schemaVersion !== 1 ||
        !text(value.oidcSha256, 64) || !/^[0-9a-f]{64}$/.test(value.oidcSha256) ||
        !text(value.accessTokenSha256, 64) || !/^[0-9a-f]{64}$/.test(value.accessTokenSha256) ||
        !text(value.githubRepositoryId, 32) || !/^[1-9][0-9]*$/.test(value.githubRepositoryId) ||
        !text(value.repositoryFullName, 140) || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(value.repositoryFullName) ||
        !text(value.ref, 1035) || !value.ref.startsWith('refs/heads/') || !isBranchName(value.ref.slice(11)) || !isSha(value.headSha) || ![40, 64].includes(value.headSha.length) || !/[1-9a-f]/.test(value.headSha) ||
        !text(value.runId, 32) || !/^[0-9]+$/.test(value.runId) || !text(value.runAttempt, 32) || !/^[0-9]+$/.test(value.runAttempt) ||
        !text(value.defaultBranch, 1024) || !isBranchName(value.defaultBranch))
        throw new CollectorError('ObservationInvalid');
    const permissions = value.permissionObservation;
    if (!record(permissions) || !exactKeys(permissions, ['status'], ['permissions']) ||
        !['Observed', 'Unavailable'].includes(String(permissions.status)))
        throw new CollectorError('ObservationInvalid');
    if (permissions.status === 'Unavailable' && Object.hasOwn(permissions, 'permissions'))
        throw new CollectorError('ObservationInvalid');
    if (permissions.status === 'Observed' && (!record(permissions.permissions) || !Object.keys(permissions.permissions).length ||
        Object.entries(permissions.permissions).some(([key, permitted]) => !['admin', 'maintain', 'push', 'triage', 'pull'].includes(key) || typeof permitted !== 'boolean')))
        throw new CollectorError('ObservationInvalid');
    const yaml = value.yaml;
    if (!record(yaml) || !exactKeys(yaml, ['path', 'headSha', 'presence', 'sha256', 'bytes', 'content']) ||
        yaml.path !== '.bumpquill.yml' || yaml.headSha !== value.headSha || !text(yaml.sha256, 64) || !/^[0-9a-f]{64}$/.test(yaml.sha256) ||
        typeof yaml.bytes !== 'number' || !Number.isSafeInteger(yaml.bytes) || yaml.bytes < 0 || yaml.bytes > observationYamlBytes)
        throw new CollectorError('ObservationInvalid');
    if (yaml.presence === 'Absent') {
        if (yaml.content !== null || yaml.bytes !== 0 || yaml.sha256 !== sha256Text(''))
            throw new CollectorError('ObservationInvalid');
    }
    else if (yaml.presence === 'Present') {
        if (!text(yaml.content, observationYamlBytes) || Buffer.byteLength(yaml.content, 'utf8') !== yaml.bytes || yaml.sha256 !== sha256Text(yaml.content))
            throw new CollectorError('ObservationInvalid');
    }
    else
        throw new CollectorError('ObservationInvalid');
    return value;
}
export function constructObservation(inputs, repository, yaml, oidcToken, accessToken, excludedValues = []) {
    if (repository.id !== inputs.githubRepositoryId || repository.fullName.toLowerCase() !== `${inputs.owner}/${inputs.repository}`.toLowerCase())
        throw new CollectorError('ObservationScopeMismatch');
    const report = validateObservation({ schemaVersion: 1, oidcSha256: sha256Text(oidcToken), accessTokenSha256: sha256Text(accessToken),
        githubRepositoryId: inputs.githubRepositoryId, repositoryFullName: repository.fullName, ref: `refs/heads/${inputs.refName}`,
        headSha: inputs.headSha, runId: inputs.runId, runAttempt: inputs.runAttempt, defaultBranch: repository.defaultBranch,
        permissionObservation: repository.permissionObservation, yaml });
    assertNoCredentials(report, [oidcToken, accessToken, ...excludedValues]);
    return report;
}
