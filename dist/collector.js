import { createHash } from 'node:crypto';
import { CollectorError, assertNoCredentials, constructSync, isSha, serializeAnalysisInput } from './contracts.js';
import { GitHubReader } from './github.js';
import { BackendClient, requestGitHubOidc } from './http.js';
import { readRepositoryYaml } from './observations.js';
import { constructObservation } from './observation-report.js';
import { CollectorSourceProofReader } from './collector-source-proof.js';
import { continuousJobId, routeAnalysisInput } from './input-routing.js';
export function isPureOwnChange(sources, scope, manifest) {
    if (!manifest || Object.entries(scope).some(([key, value]) => manifest[key] !== value) ||
        !Array.isArray(manifest.files) || !sources.changedPaths.length)
        return false;
    const owned = new Map(manifest.files.map(file => [file.path, file.diffSha256]));
    if (owned.size !== manifest.files.length || owned.size !== sources.changedPaths.length || sources.changedPaths.some(path => !owned.has(path)))
        return false;
    return sources.changedPaths.every(path => {
        const file = sources.files.find(candidate => candidate.path === path);
        const reference = sources.references.find(candidate => candidate.path === path && candidate.kind === 'Diff');
        const hash = reference?.sha256 ?? (file ? createHash('sha256').update(file.diff, 'utf8').digest('hex') : undefined);
        return /^[0-9a-f]{64}$/.test(owned.get(path)) && owned.get(path) === hash;
    });
}
export function prepareAnalysisInput(binding, sources, pullRequests, excludedValues = []) {
    if (sources.references.length)
        throw new CollectorError('InputLimitExceeded');
    if (sources.fromSha !== binding.fromSha || sources.toSha !== binding.toSha)
        throw new CollectorError('SourceRangeMismatch');
    const payload = { schemaVersion: 1, ...binding, commits: sources.commits, files: sources.files, pullRequests };
    return serializeAnalysisInput(payload, excludedValues);
}
export async function runCollector(inputs, options) {
    const fetcher = options.fetcher ?? fetch;
    const checkCancellation = () => { if (options.signal?.aborted)
        throw new CollectorError('CollectorCancelled'); };
    checkCancellation();
    const oidcToken = await requestGitHubOidc(options.env, inputs.oidcAudience, fetcher, options.signal);
    const backend = new BackendClient(inputs.backendOrigin, fetcher, options.now, { signal: options.signal, wait: options.wait });
    const token = await backend.exchange(inputs.projectKey, oidcToken);
    const github = new GitHubReader(inputs.githubToken, fetcher);
    const repository = await github.repository(inputs.owner, inputs.repository);
    if (repository.id !== inputs.githubRepositoryId || repository.fullName.toLowerCase() !== `${inputs.owner}/${inputs.repository}`.toLowerCase())
        throw new CollectorError('RepositoryIdentityMismatch');
    const excludedValues = [inputs.githubToken, inputs.projectKey, oidcToken, token.accessToken,
        ...Object.entries(options.env).filter(([key, value]) => value && /(?:^|[_-])(?:TOKEN|PAT|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)(?:$|[_-])/i.test(key))
            .map(([, value]) => value)];
    assertNoCredentials(repository, excludedValues);
    const yaml = await (options.yamlReader ?? readRepositoryYaml)(inputs.checkoutDir, inputs.headSha, excludedValues);
    const observation = constructObservation(inputs, repository, yaml, oidcToken, token.accessToken, excludedValues);
    const sync = await backend.sync(constructSync(repository.id, inputs.refName, inputs.headSha, observation), inputs.idempotencyKey);
    assertNoCredentials(sync, excludedValues);
    if (!sync.tracked)
        return { status: 'Untracked', jobsDispatched: 0 };
    const { branch, configuration, repositoryId, organizationId } = sync;
    if (!organizationId)
        throw new CollectorError('SyncBindingMissing');
    if (!branch || !configuration || !repositoryId)
        return { status: 'NeedInput', jobsDispatched: 0 };
    if (branch.repositoryId !== repositoryId || branch.name !== inputs.refName || branch.observedHead && branch.observedHead !== inputs.headSha)
        throw new CollectorError('SyncScopeMismatch');
    if (sync.manualRequests.some(request => request.branchId !== branch.id))
        throw new CollectorError('SyncScopeMismatch');
    if (branch.status === 'NeedsResync')
        return { status: 'NeedsResync', jobsDispatched: 0 };
    if (branch.status !== 'Ready')
        return { status: 'NeedInput', jobsDispatched: 0 };
    if (sync.manualRequests.length > 100 || new Set(sync.manualRequests.map(request => request.id)).size !== sync.manualRequests.length)
        throw new CollectorError('ManualRequestsInvalid');
    const plans = [];
    if (sync.manualRequests.length) {
        for (const pending of sync.manualRequests) {
            checkCancellation();
            if (Date.parse(pending.expiresAt) <= (options.now ?? Date.now)())
                throw new CollectorError('ManualRequestExpired');
            const claimed = structuredClone(await backend.claimRequest(pending.id, pending.version, branch.generation, `${inputs.idempotencyKey}:claim:${pending.id}`, Date.parse(pending.expiresAt)));
            assertNoCredentials(claimed, excludedValues);
            if (claimed.organizationId !== organizationId || claimed.repositoryId !== repositoryId || claimed.branchId !== branch.id ||
                claimed.generation !== branch.generation || claimed.id !== pending.id || claimed.mode !== pending.mode ||
                claimed.fromSha !== pending.fromSha || claimed.toSha !== pending.toSha || Date.parse(claimed.expiresAt) !== Date.parse(pending.expiresAt) ||
                claimed.version < pending.version)
                throw new CollectorError('ManualScopeMismatch');
            plans.push({ binding: { id: claimed.jobId, organizationId: claimed.organizationId, repositoryId: claimed.repositoryId,
                    branchId: claimed.branchId, generation: claimed.generation, configSnapshotId: claimed.configuration.snapshotId,
                    mode: claimed.mode, fromSha: claimed.fromSha, toSha: claimed.toSha, manualRequestId: claimed.id,
                    requestedByUserId: claimed.requestedByUserId, expiresAt: claimed.expiresAt }, configuration: claimed.configuration });
        }
    }
    else {
        const fromSha = branch.analysisCursor ?? branch.baselineSha;
        if (!isSha(fromSha))
            return { status: 'NeedInput', jobsDispatched: 0 };
        if (fromSha === inputs.headSha)
            return { status: 'NoChanges', jobsDispatched: 0 };
        const scope = { organizationId, repositoryId, branchId: branch.id, generation: branch.generation,
            configSnapshotId: configuration.snapshotId, mode: 'Continuous', fromSha, toSha: inputs.headSha };
        plans.push({ binding: { ...scope, id: continuousJobId(scope) }, configuration: structuredClone(configuration) });
    }
    const results = [];
    for (const plan of plans) {
        checkCancellation();
        const { binding, configuration: frozenConfiguration } = plan;
        assertNoCredentials(frozenConfiguration, excludedValues);
        const sourceReader = options.sourceReader ?? new CollectorSourceProofReader(inputs.checkoutDir, {
            excludedValues, ignorePatterns: frozenConfiguration.settings.ignorePatterns ?? [], headSha: inputs.headSha, signal: options.signal
        });
        let sources = await sourceReader.collect(binding.fromSha, binding.toSha);
        if (sources.fromSha !== binding.fromSha || sources.toSha !== binding.toSha)
            throw new CollectorError('SourceRangeMismatch');
        assertNoCredentials({ commits: sources.commits, files: sources.files, references: sources.references }, excludedValues);
        if (binding.mode === 'Continuous') {
            const scope = { repositoryId: binding.repositoryId, branchId: binding.branchId, generation: binding.generation,
                fromSha: binding.fromSha, toSha: binding.toSha };
            const manifest = options.manifestReader ? await options.manifestReader.read(scope) : null;
            if (isPureOwnChange(sources, scope, manifest))
                return { status: 'OwnChangeSkipped', jobsDispatched: 0 };
        }
        const pullRequests = [];
        const effectiveCommits = new Set(sources.commits.map(commit => commit.sha));
        for (const commit of sources.commits) {
            checkCancellation();
            const associated = await github.pullRequestsForCommit(inputs.owner, inputs.repository, commit.sha);
            if ('sourceProof' in sources) {
                const proven = sources;
                const index = sources.commits.indexOf(commit);
                proven.sourceProof.commits[index].protectedEvidence = github.protectedEvidenceForCommit(inputs.owner, inputs.repository, commit.sha);
            }
            for (const request of associated) {
                if (!effectiveCommits.has(request.effectiveCommitSha))
                    continue;
                assertNoCredentials(request, excludedValues);
                if (!pullRequests.some(existing => existing.number === request.number))
                    pullRequests.push(request);
                if (pullRequests.length > 1000)
                    throw new CollectorError('InputLimitExceeded');
            }
        }
        if (!options.sourceReader && 'sourceProof' in sources) {
            const proven = sources;
            if (proven.sourceProof.commits.some(commit => commit.protectedEvidence.length > 0) &&
                proven.sourceProof.commits.some(commit => commit.excludedFiles?.some(file => file.reason === 'Ignored'))) {
                const evidence = new Map(proven.commits.map((commit, index) => [commit.sha, proven.sourceProof.commits[index].protectedEvidence]));
                const retained = await new CollectorSourceProofReader(inputs.checkoutDir, { excludedValues, headSha: inputs.headSha, signal: options.signal })
                    .collect(binding.fromSha, binding.toSha);
                for (let index = 0; index < retained.commits.length; index++)
                    retained.sourceProof.commits[index].protectedEvidence = evidence.get(retained.commits[index].sha) ?? [];
                sources = retained;
            }
        }
        results.push(await routeAnalysisInput(backend, binding, sources, pullRequests, `${inputs.idempotencyKey}:${binding.id}`, {
            excludedValues, signal: options.signal, now: options.now, wait: options.wait,
            maximumPolls: options.maximumPolls, pollIntervalMs: options.pollIntervalMs,
        }));
    }
    const precedence = ['Failed', 'Cancelled', 'CancelRequested', 'Blocked', 'PollingTimedOut', 'AwaitingInput', 'Queued', 'Running', 'Succeeded', 'NoChanges'];
    const status = precedence.find(candidate => results.some(result => result.status === candidate));
    return { status, jobsDispatched: results.reduce((count, result) => count + result.jobsDispatched, 0), jobs: results.map(result => result.job) };
}
