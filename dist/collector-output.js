const successfulStatuses = new Set(['Untracked', 'NoChanges', 'OwnChangeSkipped', 'Queued', 'Running', 'PollingTimedOut', 'Succeeded']);
export function collectorOutput(result) {
    if (!Number.isSafeInteger(result.jobsDispatched) || result.jobsDispatched < 0)
        throw new Error('CollectorCountInvalid');
    const exitCode = successfulStatuses.has(result.status) ? 0 : 1;
    return {
        githubOutput: `collector-status=${result.status}\njobs-dispatched=${result.jobsDispatched}\n`,
        stdout: `BumpQuill Collector: ${result.status}; jobs dispatched: ${result.jobsDispatched}.\n`,
        exitCode,
    };
}
