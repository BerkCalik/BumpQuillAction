import { appendFile } from 'node:fs/promises';
import { runCollector } from './collector.js';
import { readCollectorInputs } from './inputs.js';
import { collectorOutput } from './collector-output.js';
import { runPublisher } from './publisher.js';
try {
    if (process.env.INPUT_MODE === 'Publisher') {
        const result = await runPublisher(process.env);
        if (process.env.GITHUB_OUTPUT)
            await appendFile(process.env.GITHUB_OUTPUT, `publisher-status=${result.status}\npublications-reported=${result.publicationsReported}\n`);
        process.stdout.write(`BumpQuill Publisher: ${result.status}; publications reported: ${result.publicationsReported}.\n`);
    }
    else {
        const inputs = await readCollectorInputs(process.env);
        const result = await runCollector(inputs, { env: process.env });
        const output = collectorOutput(result);
        if (process.env.GITHUB_OUTPUT)
            await appendFile(process.env.GITHUB_OUTPUT, output.githubOutput);
        process.stdout.write(output.stdout);
        process.exitCode = output.exitCode;
    }
}
catch {
    const mode = process.env.INPUT_MODE === 'Publisher' ? 'Publisher' : 'Collector';
    process.stderr.write(`BumpQuill ${mode} failed. No completed analysis or publication is reported.\n`);
    process.exitCode = 1;
}
