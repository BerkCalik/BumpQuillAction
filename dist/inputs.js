import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { CollectorError, isSha } from './contracts.js';
import { httpsOrigin } from './http.js';
export function isBranchName(value) {
    return value.length > 0 && Buffer.byteLength(value) <= 1024 && value !== '@' && !value.startsWith('refs/') &&
        !value.startsWith('-') && !value.startsWith('/') && !value.endsWith('/') && !value.endsWith('.') &&
        !/[\u0000-\u0020\u007f~^:?*\[\\]/u.test(value) && !value.includes('..') && !value.includes('@{') &&
        value.split('/').every(part => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock')) && value.isWellFormed();
}
export async function readCollectorInputs(env) {
    if (env.GITHUB_ACTIONS !== 'true')
        throw new CollectorError('ActionEnvironmentRequired');
    const mode = env.INPUT_MODE || 'Collector';
    if (mode === 'Publisher')
        throw new CollectorError('PendingPublisher019');
    if (mode !== 'Collector')
        throw new CollectorError('CollectorModeRequired');
    if (!['push', 'workflow_dispatch', 'schedule'].includes(env.GITHUB_EVENT_NAME ?? ''))
        throw new CollectorError('CollectorEventUnsupported');
    const backendOrigin = httpsOrigin(env['INPUT_BACKEND-URL'] ?? '');
    const projectKey = env['INPUT_PROJECT-KEY'] ?? '';
    const githubToken = env['INPUT_GITHUB-TOKEN'] ?? env.GITHUB_TOKEN ?? '';
    const oidcAudience = env['INPUT_OIDC-AUDIENCE'] ?? '';
    if (!projectKey || projectKey.length > 8192 || !githubToken || githubToken.length > 8192 ||
        /[\r\n]/u.test(githubToken) || !oidcAudience || oidcAudience.length > 512)
        throw new CollectorError('CollectorInputsInvalid');
    const repositoryParts = (env.GITHUB_REPOSITORY ?? '').split('/');
    if (repositoryParts.length !== 2 || repositoryParts.some(part => !/^[a-zA-Z0-9_.-]{1,100}$/.test(part) || part === '.' || part === '..'))
        throw new CollectorError('RepositoryContextInvalid');
    const githubRepositoryId = env.GITHUB_REPOSITORY_ID ?? '';
    const refName = (env.GITHUB_REF ?? '').slice('refs/heads/'.length);
    if (!env.GITHUB_REF?.startsWith('refs/heads/') || !isBranchName(refName) || !/^[1-9][0-9]*$/.test(githubRepositoryId) ||
        githubRepositoryId.length > 32 || !isSha(env.GITHUB_SHA))
        throw new CollectorError('RepositoryContextInvalid');
    if (!env.GITHUB_WORKSPACE)
        throw new CollectorError('CheckoutBoundaryInvalid');
    let checkoutDir;
    try {
        const workspace = await realpath(env.GITHUB_WORKSPACE);
        checkoutDir = await realpath(resolve(workspace, env['INPUT_CHECKOUT-DIR'] || '.'));
        const inside = relative(workspace, checkoutDir);
        if (isAbsolute(inside) || inside === '..' || inside.startsWith('../'))
            throw new Error();
        const gitEnvironment = Object.fromEntries(Object.entries(env).filter(([key, value]) => !key.startsWith('GIT_') && value !== undefined));
        const execute = promisify(execFile);
        const options = { cwd: checkoutDir, encoding: 'utf8', timeout: 10000, maxBuffer: 8192,
            env: { ...gitEnvironment, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' } };
        const top = await execute('git', ['rev-parse', '--show-toplevel'], options);
        if (await realpath(top.stdout.trim()) !== checkoutDir)
            throw new Error();
        const head = await execute('git', ['rev-parse', '--verify', 'HEAD^{commit}'], options);
        if (head.stdout.trim() !== env.GITHUB_SHA)
            throw new Error();
    }
    catch {
        throw new CollectorError('CheckoutBoundaryInvalid');
    }
    if (!/^\d+$/.test(env.GITHUB_RUN_ID ?? '') || !/^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? ''))
        throw new CollectorError('RunContextInvalid');
    const idempotencyKey = `collector:${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT}`;
    if (idempotencyKey.length > 128)
        throw new CollectorError('RunContextInvalid');
    return { backendOrigin, projectKey, githubToken, oidcAudience, checkoutDir, owner: repositoryParts[0],
        repository: repositoryParts[1], githubRepositoryId, refName, headSha: env.GITHUB_SHA,
        runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, idempotencyKey };
}
