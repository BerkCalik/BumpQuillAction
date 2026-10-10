# BumpQuill Action

Public runtime and reusable workflows for BerkCalik/BumpQuillAction.

Requires Node 24 and GitHub Actions. The Collector reads repository data;
the Publisher uses GitHub HTTP APIs without checking out the customer repository.
Git is required on the Collector runner. No installed runtime packages are needed.

Caller examples are in workflow-templates/collector.yml and workflow-templates/publisher.yml.
Keep runtime and reusable workflow references pinned to their reviewed full commit SHAs.
Configure BUMPQUILL_BACKEND_URL and BUMPQUILL_OIDC_AUDIENCE as repository variables,
and BUMPQUILL_PROJECT_KEY as a repository secret. GitHub credentials remain local to the Action.
Collector permissions are contents/read, pull-requests/read, and id-token/write.
Publisher permissions are contents/write, pull-requests/write, and id-token/write.
The backend must authorize the exact reusable workflow identity and intent.
