import { CollectorError, assertNoCredentials, isSha } from './contracts.js';
import { httpsOrigin, requestGitHubOidc } from './http.js';
import { isBranchName } from './inputs.js';
import { GitHubPublisher, contentSha256, publicationIdentity, publicationPath } from './github-publisher.js';
import { PublisherBackendClient, requirePublisherUuid, validatePublicationWire } from './publisher-http.js';
export function readPublisherInputs(env) {
    if (env.GITHUB_ACTIONS !== 'true' || env.INPUT_MODE !== 'Publisher')
        throw new CollectorError('PublisherEnvironmentRequired');
    if (!['workflow_dispatch', 'schedule'].includes(env.GITHUB_EVENT_NAME ?? ''))
        throw new CollectorError('PublisherEventUnsupported');
    const backendOrigin = httpsOrigin(env['INPUT_BACKEND-URL'] ?? '');
    const projectKey = env['INPUT_PROJECT-KEY'] ?? '', githubToken = env['INPUT_GITHUB-TOKEN'] ?? env.GITHUB_TOKEN ?? '', oidcAudience = env['INPUT_OIDC-AUDIENCE'] ?? '';
    if (!projectKey || projectKey.length > 8192 || !/^[\x21-\x7e]{1,4096}$/.test(githubToken) || !oidcAudience || oidcAudience.length > 512 ||
        /[\u0000-\u001f\u007f]/u.test(oidcAudience))
        throw new CollectorError('PublisherInputsInvalid');
    const parts = (env.GITHUB_REPOSITORY ?? '').split('/');
    const refName = (env.GITHUB_REF ?? '').slice('refs/heads/'.length);
    if (parts.length !== 2 || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(parts[0]) || !/^[a-zA-Z0-9_.-]{1,100}$/.test(parts[1]) || parts[1] === '.' || parts[1] === '..' ||
        !/^[1-9][0-9]{0,31}$/.test(env.GITHUB_REPOSITORY_ID ?? '') || !env.GITHUB_REF?.startsWith('refs/heads/') || !isBranchName(refName) ||
        !isSha(env.GITHUB_SHA) || env.GITHUB_SHA.length !== 40)
        throw new CollectorError('PublicationScopeInvalid');
    if (!/^[1-9][0-9]{0,31}$/.test(env.GITHUB_RUN_ID ?? '') || !/^[1-9][0-9]{0,15}$/.test(env.GITHUB_RUN_ATTEMPT ?? ''))
        throw new CollectorError('RunContextInvalid');
    return { backendOrigin, projectKey, githubToken, oidcAudience, owner: parts[0], repository: parts[1],
        githubRepositoryId: env.GITHUB_REPOSITORY_ID, refName, headSha: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT };
}
function contextScope(operation, inputs) {
    if (!operation.organizationId || !operation.jobId || !operation.refName || !operation.headRef)
        throw new CollectorError('PublicationContextMissing');
    requirePublisherUuid(operation.organizationId);
    requirePublisherUuid(operation.jobId);
    if (operation.refName !== inputs.refName)
        throw new CollectorError('PublicationContextMismatch');
    const scope = { organizationId: operation.organizationId, repositoryId: operation.repositoryId, branchId: operation.branchId, generation: operation.generation,
        githubRepositoryId: inputs.githubRepositoryId, owner: inputs.owner, repository: inputs.repository, refName: inputs.refName, targetHeadSha: inputs.headSha, headRef: operation.headRef };
    publicationIdentity(scope);
    return scope;
}
function boundManifest(manifest, operation, outputPath) {
    validatePublicationWire('PublicationManifest', manifest);
    if (manifest.operationId !== operation.id || manifest.repositoryId !== operation.repositoryId || manifest.branchId !== operation.branchId ||
        manifest.generation !== operation.generation || manifest.revision < 1 || manifest.files.length !== 1 || manifest.files[0].path !== outputPath ||
        contentSha256(manifest.files[0].markdown) !== manifest.files[0].sha256 || new Set(manifest.entries.map(entry => entry.entryId)).size !== manifest.entries.length ||
        manifest.entries.some(entry => entry.revision < 1))
        throw new CollectorError('PublicationManifestBindingInvalid');
    publicationPath(outputPath);
}
function operationBinding(confirmed, original) {
    if (confirmed.id !== original.id || confirmed.repositoryId !== original.repositoryId || confirmed.branchId !== original.branchId || confirmed.generation !== original.generation ||
        confirmed.organizationId !== original.organizationId || confirmed.jobId !== original.jobId || confirmed.refName !== original.refName || confirmed.headRef !== original.headRef ||
        confirmed.version <= original.version)
        throw new CollectorError('PublicationReportBindingInvalid');
}
function manifestBinding(manifest) {
    return JSON.stringify([manifest.id, manifest.operationId, manifest.revision, manifest.repositoryId, manifest.branchId, manifest.generation, manifest.phase,
        manifest.files.map(file => [file.path, file.markdown, file.sha256, file.expectedBaseSha]),
        [...manifest.entries].sort((left, right) => left.entryId.localeCompare(right.entryId)).map(entry => [entry.entryId, entry.revision])]);
}
export async function runPublisher(env, dependencies = {}) {
    const inputs = readPublisherInputs(env), now = dependencies.now ?? Date.now, fetcher = dependencies.fetcher ?? fetch;
    const backend = dependencies.backend ?? new PublisherBackendClient(inputs.backendOrigin, fetcher, now, { signal: dependencies.signal });
    const oidc = await requestGitHubOidc(env, inputs.oidcAudience, fetcher, dependencies.signal);
    const token = await backend.exchange(inputs.projectKey, oidc);
    const operations = [];
    const seen = new Set();
    for (const kind of ['reconcile', 'ready']) {
        let cursor;
        const cursors = new Set();
        for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
            const page = await backend.page(kind, cursor);
            if (page.items.length > 25)
                throw new CollectorError('PublicationPageTooLarge');
            for (const operation of page.items) {
                validatePublicationWire('PublishOperation', operation);
                requirePublisherUuid(operation.id);
                if (seen.has(operation.id) || kind === 'ready' && !['Ready', 'Claimed'].includes(operation.status) || kind === 'reconcile' && operation.status === 'Ready')
                    throw new CollectorError('PublicationQueueInvalid');
                seen.add(operation.id);
                operations.push({ operation, kind });
            }
            if (page.nextCursor === null)
                break;
            if (!page.nextCursor || cursors.has(page.nextCursor) || pageNumber === 9)
                throw new CollectorError('PublicationPaginationExceeded');
            cursors.add(page.nextCursor);
            cursor = page.nextCursor;
        }
    }
    let publicationsReported = 0;
    for (const { operation, kind } of operations) {
        const scope = contextScope(operation, inputs);
        const key = (stage) => `publisher:${inputs.runId}:${inputs.runAttempt}:${operation.id}:${stage}`;
        const beforeClaim = dependencies.github ?? new GitHubPublisher(inputs.githubToken, fetcher, undefined, { signal: dependencies.signal });
        const freshHead = kind === 'ready' && operation.pullRequestNumber ? await beforeClaim.currentPullRequestHead(scope, operation.pullRequestNumber) : undefined;
        let claim = await backend.claim(operation.id, { expectedVersion: operation.version, expectedGeneration: operation.generation,
            intent: kind === 'ready' ? 'Publish' : 'Observe', ...(freshHead ? { pullRequestHeadSha: freshHead } : {}) }, key('claim'));
        const assertLive = () => {
            if (dependencies.signal?.aborted)
                throw new CollectorError('PublisherCancelled');
            if (Date.parse(claim.expiresAt) <= now() || Date.parse(token.expiresAt) <= now())
                throw new CollectorError('PublisherTokenOrLeaseExpired');
        };
        assertLive();
        let intent = kind === 'ready' ? 'Publish' : 'Observe';
        const forClaim = () => {
            const remaining = Math.min(Date.parse(claim.expiresAt), Date.parse(token.expiresAt)) - now();
            if (remaining <= 0)
                throw new CollectorError('PublisherTokenOrLeaseExpired');
            const deadline = AbortSignal.timeout(Math.max(1, Math.min(900000, Math.ceil(remaining))));
            return dependencies.github ?? new GitHubPublisher(inputs.githubToken, fetcher, undefined, {
                signal: dependencies.signal ? AbortSignal.any([dependencies.signal, deadline]) : deadline, beforeWrite: () => {
                    assertLive();
                    if (intent !== 'Publish')
                        throw new CollectorError('PublicationObserveReadOnly');
                },
            });
        };
        let github = forClaim();
        let manifest = await backend.manifest(claim);
        assertNoCredentials(manifest, [inputs.projectKey, inputs.githubToken, oidc, token.accessToken, claim.leaseToken]);
        const outputPath = manifest.files[0]?.path;
        if (!outputPath)
            throw new CollectorError('PublicationManifestBindingInvalid');
        boundManifest(manifest, operation, outputPath);
        let observed = await github.observe(scope, [outputPath], operation.pullRequestNumber);
        assertNoCredentials(observed, [inputs.projectKey, inputs.githubToken, oidc, token.accessToken, claim.leaseToken]);
        if (claim.readOnlyRecovery) {
            if (intent !== 'Observe' || claim.recovery || manifest.phase !== 'Prepared')
                throw new CollectorError('PublicationRecoveryClaimInvalid');
            const observation = await github.readOnlyRecoveryObservation(scope, manifest, observed, { ...inputs, intent: 'Observe' }, now);
            assertNoCredentials(observation, [inputs.projectKey, inputs.githubToken, oidc, token.accessToken, claim.leaseToken]);
            assertLive();
            const pullRequestNumber = observed.pullRequest?.number ?? observed.missingKnownPullRequest;
            const confirmed = await backend.report(operation.jobId, claim, { operationId: operation.id, manifestId: manifest.id, manifestRevision: manifest.revision,
                fencingVersion: claim.fencingVersion, outcome: 'Conflict', ...(pullRequestNumber ? { pullRequestNumber } : {}),
                githubCommitSha: observation.merged ? observation.mergeCommitSha : observation.commitSha, contentSha256: manifest.files[0].sha256,
                observedEntryRevisions: manifest.entries, observation }, key('read-only-report'));
            operationBinding(confirmed, operation);
            if (confirmed.status !== 'Conflict' || operation.pullRequestNumber != null && confirmed.pullRequestNumber !== operation.pullRequestNumber ||
                confirmed.pullRequestNumber != null && confirmed.pullRequestNumber !== pullRequestNumber)
                throw new CollectorError('PublicationReadOnlyReportInvalid');
            continue;
        }
        if (observed.missingKnownPullRequest !== undefined) {
            if (intent !== 'Observe' || operation.pullRequestNumber !== observed.missingKnownPullRequest)
                throw new CollectorError('PublicationCustomerDecisionRequired');
            const observation = await github.deletedPullRequestObservation(scope, manifest, observed, { ...inputs, intent: 'Observe' }, now);
            assertNoCredentials(observation, [inputs.projectKey, inputs.githubToken, oidc, token.accessToken, claim.leaseToken]);
            assertLive();
            const closed = await backend.report(operation.jobId, claim, { operationId: operation.id, manifestId: manifest.id, manifestRevision: manifest.revision,
                fencingVersion: claim.fencingVersion, outcome: 'ClosedAwaitingDecision', pullRequestNumber: observed.missingKnownPullRequest,
                githubCommitSha: observation.commitSha, contentSha256: manifest.files[0].sha256, observedEntryRevisions: manifest.entries, observation }, key('deleted-pr-report'));
            operationBinding(closed, operation);
            if (closed.status !== 'ClosedAwaitingDecision' || closed.pullRequestNumber !== observed.missingKnownPullRequest)
                throw new CollectorError('PublicationReportBindingInvalid');
            publicationsReported++;
            continue;
        }
        let write;
        if (kind === 'ready') {
            if (manifest.phase === 'Prepared') {
                if (!claim.recovery)
                    throw new CollectorError('PublicationRecoveryClaimRequired');
                write = await github.finishRecovery(scope, manifest, claim.recovery, observed, inputs, assertLive);
            }
            else {
                if (claim.recovery || operation.version >= Number.MAX_SAFE_INTEGER)
                    throw new CollectorError('PublicationCandidateRequired');
                assertLive();
                manifest = await backend.prepare(claim, { expectedVersion: operation.version + 1, fencingVersion: claim.fencingVersion, targetHeadSha: observed.targetHeadSha,
                    pullRequestHeadSha: observed.pullRequest?.headSha ?? null, files: observed.files }, key('prepare'));
                assertNoCredentials(manifest, [inputs.projectKey, inputs.githubToken, oidc, token.accessToken, claim.leaseToken]);
                boundManifest(manifest, operation, outputPath);
                if (manifest.phase !== 'Prepared')
                    throw new CollectorError('PublicationPreparedRequired');
                write = await github.write(scope, manifest, observed, assertLive);
            }
        }
        else {
            assertLive();
            if (observed.pullRequest)
                write = await github.verifyObserved(scope, manifest, observed);
            else {
                const immutable = manifestBinding(manifest);
                const orphan = await github.orphanObservation(scope, manifest, observed, { ...inputs, intent: 'Observe' }, now);
                assertNoCredentials(orphan, [inputs.projectKey, inputs.githubToken, oidc, token.accessToken, claim.leaseToken]);
                assertLive();
                const progress = await backend.report(operation.jobId, claim, { operationId: operation.id, manifestId: manifest.id, manifestRevision: manifest.revision,
                    fencingVersion: claim.fencingVersion, outcome: 'Ready', githubCommitSha: orphan.commitSha, contentSha256: manifest.files[0].sha256,
                    observedEntryRevisions: manifest.entries, observation: orphan }, key('orphan-report'));
                operationBinding(progress, operation);
                if (progress.status !== 'Ready' || progress.pullRequestNumber != null)
                    throw new CollectorError('PublicationRecoveryProgressInvalid');
                const observedFence = claim.fencingVersion;
                claim = await backend.claim(operation.id, { expectedVersion: progress.version, expectedGeneration: operation.generation, intent: 'Publish' }, key('recovery-claim'));
                if (claim.fencingVersion <= observedFence || !claim.recovery || claim.recovery.manifestId !== manifest.id || claim.recovery.manifestRevision !== manifest.revision ||
                    claim.recovery.commitSha !== orphan.branchHeadSha)
                    throw new CollectorError('PublicationRecoveryClaimInvalid');
                assertLive();
                const retained = await backend.manifest(claim);
                assertNoCredentials(retained, [inputs.projectKey, inputs.githubToken, oidc, token.accessToken, claim.leaseToken]);
                boundManifest(retained, operation, outputPath);
                if (manifestBinding(retained) !== immutable)
                    throw new CollectorError('PublicationRecoveryManifestChanged');
                manifest = retained;
                github = forClaim();
                intent = 'Publish';
                observed = await github.observe(scope, [outputPath]);
                assertNoCredentials(observed, [inputs.projectKey, inputs.githubToken, oidc, token.accessToken, claim.leaseToken]);
                write = await github.finishRecovery(scope, manifest, claim.recovery, observed, inputs, assertLive);
            }
        }
        assertLive();
        const observation = await github.reportObservation(scope, manifest, write, { runId: inputs.runId, runAttempt: inputs.runAttempt,
            intent }, now);
        assertNoCredentials(observation, [inputs.projectKey, inputs.githubToken, oidc, token.accessToken, claim.leaseToken]);
        assertLive();
        const outcome = write.pullRequest.merged ? 'Merged' : write.pullRequest.state === 'closed' ? 'ClosedAwaitingDecision' : 'OpenPR';
        const report = { operationId: operation.id, manifestId: manifest.id, manifestRevision: manifest.revision, fencingVersion: claim.fencingVersion,
            outcome, pullRequestNumber: write.pullRequest.number, githubCommitSha: write.commitSha, contentSha256: write.contentSha256, observedEntryRevisions: manifest.entries, observation };
        const confirmed = await backend.report(operation.jobId, claim, report, key('report'));
        operationBinding(confirmed, operation);
        if (confirmed.pullRequestNumber !== write.pullRequest.number || confirmed.status !== outcome)
            throw new CollectorError('PublicationReportBindingInvalid');
        publicationsReported++;
    }
    return { status: publicationsReported ? 'Reported' : 'Idle', publicationsReported };
}
