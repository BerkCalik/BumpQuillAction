import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CollectorError, assertNoCredentials, validateWire } from './contracts.js';
import { serializeCollectorInput } from './collector-source-proof.js';
export function continuousJobId(binding) {
    if (binding.mode !== 'Continuous')
        throw new CollectorError('JobBindingInvalid');
    validateWire('Job', { ...binding, id: binding.repositoryId, status: 'AwaitingInput', settlementStatus: 'Pending', version: 0 });
    const identity = `analysis-job/v1/${binding.organizationId.toLowerCase()}/${binding.repositoryId.toLowerCase()}/${binding.branchId.toLowerCase()}/${binding.generation}/${binding.configSnapshotId.toLowerCase()}/${binding.fromSha}/${binding.toSha}/Continuous`;
    const bytes = createHash('sha256').update(identity, 'utf8').digest().subarray(0, 16);
    return `${Buffer.from(bytes.subarray(0, 4)).reverse().toString('hex')}-${Buffer.from(bytes.subarray(4, 6)).reverse().toString('hex')}-${Buffer.from(bytes.subarray(6, 8)).reverse().toString('hex')}-${bytes.subarray(8, 10).toString('hex')}-${bytes.subarray(10).toString('hex')}`;
}
export function assertJobBinding(job, binding) {
    validateWire('Job', job);
    for (const field of ['id', 'organizationId', 'repositoryId', 'branchId', 'generation', 'configSnapshotId', 'mode', 'fromSha', 'toSha']) {
        if (job[field] !== binding[field])
            throw new CollectorError('JobScopeMismatch');
    }
    if (binding.mode !== 'Continuous' && (!binding.manualRequestId || !binding.requestedByUserId || job.requestedByUserId !== binding.requestedByUserId))
        throw new CollectorError('JobScopeMismatch');
}
export async function routeAnalysisInput(backend, binding, sources, pullRequests, idempotencyKey, options = {}) {
    binding = structuredClone(binding);
    const validateJob = (job) => {
        assertJobBinding(job, binding);
        assertNoCredentials(job, options.excludedValues ?? []);
    };
    const now = options.now ?? Date.now;
    const deadline = Math.min(now() + 60000, binding.expiresAt === undefined ? Infinity : Date.parse(binding.expiresAt));
    const checkDeadline = () => {
        if (options.signal?.aborted)
            throw new CollectorError('CollectorCancelled');
        if (!Number.isFinite(deadline) || now() >= deadline)
            throw new CollectorError('InputDeadlineExpired');
    };
    const maximumPolls = options.maximumPolls ?? 20;
    const interval = options.pollIntervalMs ?? 1000;
    if (!Number.isSafeInteger(maximumPolls) || maximumPolls < 0 || maximumPolls > 60 ||
        !Number.isSafeInteger(interval) || interval < 1 || interval > 5000)
        throw new CollectorError('PollingLimitInvalid');
    checkDeadline();
    if (!/^[a-zA-Z0-9._:-]{1,119}$/.test(idempotencyKey))
        throw new CollectorError('IdempotencyKeyInvalid');
    if (binding.mode !== 'Continuous' && (!binding.manualRequestId || !binding.requestedByUserId))
        throw new CollectorError('JobBindingInvalid');
    if (sources.fromSha !== binding.fromSha || sources.toSha !== binding.toSha)
        throw new CollectorError('SourceRangeMismatch');
    if (sources.references.length)
        throw new CollectorError('InputLimitExceeded');
    if (binding.mode === 'Continuous' && (binding.manualRequestId || binding.requestedByUserId || continuousJobId({
        organizationId: binding.organizationId, repositoryId: binding.repositoryId, branchId: binding.branchId,
        generation: binding.generation, configSnapshotId: binding.configSnapshotId, mode: binding.mode,
        fromSha: binding.fromSha, toSha: binding.toSha,
    }) !== binding.id))
        throw new CollectorError('JobBindingInvalid');
    const input = serializeCollectorInput(binding, sources, pullRequests, options.excludedValues);
    backend.validateInput(input.bytes);
    let job = await backend.createJob({ branchId: binding.branchId, expectedGeneration: binding.generation,
        fromSha: binding.fromSha, toSha: binding.toSha, mode: binding.mode, configSnapshotId: binding.configSnapshotId,
        ...(binding.manualRequestId ? { manualRequestId: binding.manualRequestId } : {}), inputSha256: input.sha256, inputBytes: input.size }, `${idempotencyKey}:create`, deadline);
    validateJob(job);
    if (job.status === 'AwaitingInput') {
        checkDeadline();
        const ticket = await backend.uploadTicket(job.id, { sha256: input.sha256, bytes: input.size, contentType: 'application/json' }, `${idempotencyKey}:upload`, deadline);
        checkDeadline();
        await backend.putInput(ticket, input, job, deadline);
        checkDeadline();
        job = await backend.completeInput(job.id, { objectId: ticket.objectId, sha256: input.sha256, bytes: input.size,
            ...(input.sourceProof ? { sourceProof: input.sourceProof } : {}) }, `${idempotencyKey}:complete`, deadline);
        validateJob(job);
        if (job.status === 'AwaitingInput')
            throw new CollectorError('InputNotFinalized');
    }
    const terminal = new Set(['Succeeded', 'NoChanges', 'Failed', 'Cancelled', 'Blocked', 'CancelRequested']);
    for (let poll = 0; !terminal.has(job.status) && poll < maximumPolls; poll++) {
        if (now() >= deadline)
            return { status: 'PollingTimedOut', jobsDispatched: 1, job };
        try {
            await (options.wait ?? ((milliseconds, signal) => delay(milliseconds, undefined, { signal })))(Math.min(interval, deadline - now()), options.signal);
        }
        catch {
            throw new CollectorError(options.signal?.aborted ? 'CollectorCancelled' : 'PollingInterrupted');
        }
        if (options.signal?.aborted)
            throw new CollectorError('CollectorCancelled');
        if (now() >= deadline)
            return { status: 'PollingTimedOut', jobsDispatched: 1, job };
        const previous = job;
        job = await backend.job(binding.id, deadline);
        validateJob(job);
        if (job.version < previous.version)
            throw new CollectorError('JobVersionRegressed');
    }
    return { status: terminal.has(job.status) ? job.status : 'PollingTimedOut', jobsDispatched: job.status === 'AwaitingInput' ? 0 : 1, job };
}
