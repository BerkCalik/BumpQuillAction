import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { CollectorError, assertNoCredentials, isSha } from './contracts.js';
export async function readRepositoryYaml(checkoutDir, headSha, excludedValues) {
    if (!isSha(headSha))
        throw new CollectorError('YamlObservationInvalid');
    const execute = promisify(execFile);
    const gitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const options = { cwd: checkoutDir, encoding: 'buffer', timeout: 10000, maxBuffer: 65537,
        env: { ...gitEnvironment, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' } };
    try {
        const directory = await realpath(checkoutDir);
        const top = await execute('git', ['rev-parse', '--show-toplevel'], options);
        if (await realpath(top.stdout.toString('utf8').trim()) !== directory)
            throw new CollectorError('YamlObservationInvalid');
        const tree = await execute('git', ['ls-tree', '-z', headSha, '--', '.bumpquill.yml'], options);
        let bytes = Buffer.alloc(0);
        let content = null;
        if (tree.stdout.length) {
            const match = /^(100644|100755) blob ([0-9a-f]{40,64})\t\.bumpquill\.yml\0$/.exec(tree.stdout.toString('utf8'));
            if (!match)
                throw new CollectorError('YamlObservationInvalid');
            const size = await execute('git', ['cat-file', '-s', match[2]], options);
            if (!/^\d+\n$/.test(size.stdout.toString('utf8')) || Number(size.stdout.toString('utf8')) > 65536)
                throw new CollectorError('YamlObservationTooLarge');
            bytes = (await execute('git', ['cat-file', 'blob', match[2]], options)).stdout;
            content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
            assertNoCredentials(content, excludedValues);
        }
        return { path: '.bumpquill.yml', headSha, presence: tree.stdout.length ? 'Present' : 'Absent',
            sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength, content };
    }
    catch (error) {
        if (error instanceof CollectorError)
            throw error;
        throw new CollectorError('YamlObservationInvalid');
    }
}
