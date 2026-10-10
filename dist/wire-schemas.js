export const wireSchemas = {
    "ActionExchange": {
        "type": "object",
        "properties": {
            "projectKey": {
                "type": "string",
                "writeOnly": true
            },
            "oidcToken": {
                "type": "string",
                "writeOnly": true
            },
            "mode": {
                "type": "string",
                "enum": [
                    "Collector",
                    "Publisher"
                ]
            },
            "actionVersion": {
                "type": "string"
            }
        },
        "required": [
            "projectKey",
            "oidcToken",
            "mode",
            "actionVersion"
        ],
        "additionalProperties": false
    },
    "ActionToken": {
        "type": "object",
        "properties": {
            "accessToken": {
                "type": "string"
            },
            "expiresAt": {
                "type": "string",
                "format": "date-time"
            },
            "scopes": {
                "type": "array",
                "items": {
                    "type": "string"
                }
            }
        },
        "required": [
            "accessToken",
            "expiresAt",
            "scopes"
        ],
        "additionalProperties": false
    },
    "ActionSync": {
        "type": "object",
        "description": "Collector sync. The entire HTTP request body is limited to 98304 UTF-8 bytes by the runtime. Optional observation is an authenticated JSON object, never an opaque full-size header or a source of machine roles. JSON Schema string lengths do not measure UTF-8 byte limits.",
        "x-max-request-body-bytes": 98304,
        "properties": {
            "githubRepositoryId": {
                "type": "string",
                "pattern": "^[0-9]+$"
            },
            "refName": {
                "type": "string"
            },
            "headSha": {
                "type": "string",
                "minLength": 40,
                "maxLength": 64,
                "pattern": "^[0-9a-f]+$"
            },
            "observation": {
                "$ref": "#/components/schemas/ActionObservation"
            }
        },
        "required": [
            "githubRepositoryId",
            "refName",
            "headSha"
        ],
        "additionalProperties": false
    },
    "ActionObservation": {
        "type": "object",
        "description": "Version 1 customer-workflow observation, accepted only with a current Collector bearer. The server matches token hashes and exact signed repository/ref/SHA/run scope, and derives session, organization, repository-key and workflow-policy authority itself. Reported metadata and permissions never grant or revoke machine roles. Unknown actor/source/issuer/type/runtime/role/workflow selectors are rejected.",
        "properties": {
            "schemaVersion": {
                "type": "integer",
                "const": 1
            },
            "oidcSha256": {
                "type": "string",
                "pattern": "^[0-9a-f]{64}$"
            },
            "accessTokenSha256": {
                "type": "string",
                "pattern": "^[0-9a-f]{64}$"
            },
            "githubRepositoryId": {
                "type": "string",
                "pattern": "^[0-9]+$"
            },
            "repositoryFullName": {
                "type": "string",
                "minLength": 1
            },
            "ref": {
                "type": "string",
                "pattern": "^refs/heads/.+$"
            },
            "headSha": {
                "type": "string",
                "pattern": "^(?!0+$)([0-9a-f]{40}|[0-9a-f]{64})$"
            },
            "runId": {
                "type": "string",
                "pattern": "^[0-9]+$"
            },
            "runAttempt": {
                "type": "string",
                "pattern": "^[0-9]+$"
            },
            "defaultBranch": {
                "type": "string",
                "minLength": 1,
                "description": "Customer-reported plain Git branch name; the runtime validates branch syntax."
            },
            "permissionObservation": {
                "$ref": "#/components/schemas/ActionPermissionObservation"
            },
            "yaml": {
                "$ref": "#/components/schemas/ActionYamlObservation"
            }
        },
        "required": [
            "schemaVersion",
            "oidcSha256",
            "accessTokenSha256",
            "githubRepositoryId",
            "repositoryFullName",
            "ref",
            "headSha",
            "runId",
            "runAttempt",
            "defaultBranch",
            "permissionObservation",
            "yaml"
        ],
        "additionalProperties": false
    },
    "ActionPermissionObservation": {
        "type": "object",
        "description": "Local GitHub API health observations only. Missing or null permission details remain unknown; none of these booleans changes server-pinned workflow roles.",
        "properties": {
            "status": {
                "type": "string",
                "enum": [
                    "Observed",
                    "Unavailable"
                ]
            },
            "permissions": {
                "anyOf": [
                    {
                        "$ref": "#/components/schemas/ActionReportedPermissions"
                    },
                    {
                        "type": "null"
                    }
                ]
            }
        },
        "required": [
            "status"
        ],
        "additionalProperties": false,
        "allOf": [
            {
                "if": {
                    "properties": {
                        "status": {
                            "const": "Unavailable"
                        }
                    },
                    "required": [
                        "status"
                    ]
                },
                "then": {
                    "properties": {
                        "permissions": {
                            "type": "null"
                        }
                    }
                }
            }
        ]
    },
    "ActionReportedPermissions": {
        "type": "object",
        "properties": {
            "admin": {
                "anyOf": [
                    {
                        "type": "boolean"
                    },
                    {
                        "type": "null"
                    }
                ]
            },
            "maintain": {
                "anyOf": [
                    {
                        "type": "boolean"
                    },
                    {
                        "type": "null"
                    }
                ]
            },
            "push": {
                "anyOf": [
                    {
                        "type": "boolean"
                    },
                    {
                        "type": "null"
                    }
                ]
            },
            "triage": {
                "anyOf": [
                    {
                        "type": "boolean"
                    },
                    {
                        "type": "null"
                    }
                ]
            },
            "pull": {
                "anyOf": [
                    {
                        "type": "boolean"
                    },
                    {
                        "type": "null"
                    }
                ]
            }
        },
        "additionalProperties": false
    },
    "ActionYamlObservation": {
        "type": "object",
        "description": "Original committed .bumpquill.yml observation. Runtime checks exact signed HEAD, original UTF-8 byte count <=65536 and SHA-256 (including BOM), and parses approved settings before any persistence. Raw YAML/comments remain transient request data; only normalized approved settings and separate original/normalized provenance hashes persist. Cross-field digest/byte equality and the whole request body byte limit are runtime rules, not character-count approximations.",
        "properties": {
            "path": {
                "type": "string",
                "const": ".bumpquill.yml"
            },
            "headSha": {
                "type": "string",
                "pattern": "^(?!0+$)([0-9a-f]{40}|[0-9a-f]{64})$"
            },
            "presence": {
                "type": "string",
                "enum": [
                    "Present",
                    "Absent"
                ]
            },
            "sha256": {
                "type": "string",
                "pattern": "^[0-9a-f]{64}$"
            },
            "bytes": {
                "type": "integer",
                "minimum": 0,
                "maximum": 65536
            },
            "content": {
                "anyOf": [
                    {
                        "type": "string"
                    },
                    {
                        "type": "null"
                    }
                ],
                "description": "Original UTF-8 text, including BOM, only in the request. At most 65536 UTF-8 bytes, enforced by runtime; no maxLength character approximation is used.",
                "x-max-utf8-bytes": 65536
            }
        },
        "required": [
            "path",
            "headSha",
            "presence",
            "sha256",
            "bytes",
            "content"
        ],
        "additionalProperties": false,
        "allOf": [
            {
                "if": {
                    "properties": {
                        "presence": {
                            "const": "Absent"
                        }
                    },
                    "required": [
                        "presence"
                    ]
                },
                "then": {
                    "properties": {
                        "content": {
                            "type": "null"
                        },
                        "bytes": {
                            "const": 0
                        },
                        "sha256": {
                            "const": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
                        }
                    }
                },
                "else": {
                    "properties": {
                        "content": {
                            "type": "string"
                        }
                    }
                }
            }
        ]
    },
    "SyncResult": {
        "type": "object",
        "description": "organizationId is derived from the authenticated Collector session. It supports the server-defined deterministic Continuous job identity and never grants authority supplied by the caller.",
        "properties": {
            "organizationId": {
                "type": "string",
                "format": "uuid"
            },
            "tracked": {
                "type": "boolean"
            },
            "repositoryId": {
                "anyOf": [
                    {
                        "type": "string",
                        "format": "uuid"
                    },
                    {
                        "type": "null"
                    }
                ]
            },
            "branch": {
                "anyOf": [
                    {
                        "$ref": "#/components/schemas/Branch"
                    },
                    {
                        "type": "null"
                    }
                ]
            },
            "configuration": {
                "anyOf": [
                    {
                        "$ref": "#/components/schemas/EffectiveConfig"
                    },
                    {
                        "type": "null"
                    }
                ]
            },
            "manualRequests": {
                "type": "array",
                "items": {
                    "$ref": "#/components/schemas/ManualRequestMetadata"
                }
            }
        },
        "required": [
            "tracked",
            "manualRequests"
        ],
        "additionalProperties": false
    },
    "Branch": {
        "type": "object",
        "properties": {
            "id": {
                "type": "string",
                "format": "uuid"
            },
            "repositoryId": {
                "type": "string",
                "format": "uuid"
            },
            "name": {
                "type": "string"
            },
            "generation": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
            },
            "status": {
                "type": "string",
                "enum": [
                    "PendingInstallation",
                    "Ready",
                    "NeedsResync",
                    "Disabled"
                ]
            },
            "baselineSha": {
                "anyOf": [
                    {
                        "type": "string",
                        "minLength": 40,
                        "maxLength": 64,
                        "pattern": "^[0-9a-f]+$"
                    },
                    {
                        "type": "null"
                    }
                ]
            },
            "analysisCursor": {
                "anyOf": [
                    {
                        "type": "string",
                        "minLength": 40,
                        "maxLength": 64,
                        "pattern": "^[0-9a-f]+$"
                    },
                    {
                        "type": "null"
                    }
                ]
            },
            "observedHead": {
                "anyOf": [
                    {
                        "type": "string",
                        "minLength": 40,
                        "maxLength": 64,
                        "pattern": "^[0-9a-f]+$"
                    },
                    {
                        "type": "null"
                    }
                ]
            },
            "outputPath": {
                "type": "string"
            },
            "version": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
            }
        },
        "required": [
            "id",
            "repositoryId",
            "name",
            "generation",
            "status",
            "version"
        ],
        "additionalProperties": false
    },
    "EffectiveConfig": {
        "type": "object",
        "properties": {
            "snapshotId": {
                "type": "string",
                "format": "uuid"
            },
            "version": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
            },
            "settings": {
                "$ref": "#/components/schemas/ConfigSettings"
            },
            "sources": {
                "type": "object",
                "additionalProperties": {
                    "type": "string"
                }
            },
            "policyVersionId": {
                "type": "string",
                "format": "uuid"
            }
        },
        "required": [
            "snapshotId",
            "version",
            "settings",
            "sources",
            "policyVersionId"
        ],
        "additionalProperties": false
    },
    "ConfigSettings": {
        "type": "object",
        "properties": {
            "language": {
                "type": "string"
            },
            "format": {
                "type": "string",
                "enum": [
                    "BumpQuillStandard",
                    "StrictKeepAChangelog",
                    "ConventionalChangelog",
                    "Custom"
                ]
            },
            "detail": {
                "type": "string",
                "enum": [
                    "Short",
                    "Balanced",
                    "Detailed"
                ]
            },
            "outputPath": {
                "type": "string"
            },
            "ignorePatterns": {
                "type": "array",
                "items": {
                    "type": "string"
                }
            },
            "aiInstructions": {
                "type": "string"
            },
            "showModules": {
                "type": "boolean"
            },
            "showReferences": {
                "type": "boolean"
            },
            "templateVersionId": {
                "anyOf": [
                    {
                        "type": "string",
                        "format": "uuid"
                    },
                    {
                        "type": "null"
                    }
                ]
            }
        },
        "required": [
            "language",
            "format",
            "detail"
        ],
        "additionalProperties": false
    },
    "ManualRequestMetadata": {
        "type": "object",
        "description": "Pending metadata has no job binding. A successful claim includes the server-issued job ID, tenant/repository/generation, frozen configuration and approved actor. A request ID is never a job ID; current sync configuration must not replace a claimed job snapshot.",
        "properties": {
            "jobId": {
                "type": "string",
                "format": "uuid"
            },
            "organizationId": {
                "type": "string",
                "format": "uuid"
            },
            "repositoryId": {
                "type": "string",
                "format": "uuid"
            },
            "generation": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
            },
            "requestedByUserId": {
                "type": "string",
                "format": "uuid"
            },
            "configuration": {
                "$ref": "#/components/schemas/EffectiveConfig"
            },
            "id": {
                "type": "string",
                "format": "uuid"
            },
            "branchId": {
                "type": "string",
                "format": "uuid"
            },
            "mode": {
                "type": "string",
                "enum": [
                    "Preview",
                    "HistoryBackfill",
                    "Reanalysis"
                ]
            },
            "fromSha": {
                "type": "string",
                "minLength": 40,
                "maxLength": 64,
                "pattern": "^[0-9a-f]+$"
            },
            "toSha": {
                "type": "string",
                "minLength": 40,
                "maxLength": 64,
                "pattern": "^[0-9a-f]+$"
            },
            "expiresAt": {
                "type": "string",
                "format": "date-time"
            },
            "version": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
            }
        },
        "required": [
            "id",
            "branchId",
            "mode",
            "fromSha",
            "toSha",
            "expiresAt",
            "version"
        ],
        "additionalProperties": false,
        "allOf": [
            {
                "if": {
                    "required": [
                        "jobId"
                    ]
                },
                "then": {
                    "required": [
                        "organizationId",
                        "repositoryId",
                        "generation",
                        "requestedByUserId",
                        "configuration"
                    ]
                }
            }
        ]
    },
    "ClaimedManualRequestMetadata": {
        "allOf": [
            {
                "$ref": "#/components/schemas/ManualRequestMetadata"
            },
            {
                "required": [
                    "jobId",
                    "organizationId",
                    "repositoryId",
                    "generation",
                    "requestedByUserId",
                    "configuration"
                ]
            }
        ]
    },
    "AnalysisInputPayload": {
        "type": "object",
        "properties": {
            "schemaVersion": {
                "type": "integer",
                "enum": [
                    1,
                    2
                ]
            },
            "jobId": {
                "type": "string",
                "format": "uuid"
            },
            "repositoryId": {
                "type": "string",
                "format": "uuid"
            },
            "branchId": {
                "type": "string",
                "format": "uuid"
            },
            "generation": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
            },
            "fromSha": {
                "type": "string",
                "minLength": 40,
                "maxLength": 64,
                "pattern": "^[0-9a-f]+$"
            },
            "toSha": {
                "type": "string",
                "minLength": 40,
                "maxLength": 64,
                "pattern": "^[0-9a-f]+$"
            },
            "commits": {
                "type": "array",
                "items": {
                    "$ref": "#/components/schemas/SourceCommit"
                },
                "maxItems": 1000
            },
            "files": {
                "type": "array",
                "items": {
                    "$ref": "#/components/schemas/SourceFile"
                },
                "maxItems": 200
            },
            "pullRequests": {
                "type": "array",
                "items": {
                    "$ref": "#/components/schemas/SourcePullRequest"
                },
                "maxItems": 1000
            }
        },
        "required": [
            "schemaVersion",
            "jobId",
            "repositoryId",
            "branchId",
            "generation",
            "fromSha",
            "toSha",
            "commits",
            "files",
            "pullRequests"
        ],
        "additionalProperties": false,
        "allOf": [
            {
                "if": {
                    "properties": {
                        "schemaVersion": {
                            "const": 2
                        }
                    },
                    "required": [
                        "schemaVersion"
                    ]
                },
                "then": {
                    "properties": {
                        "commits": {
                            "items": {
                                "required": [
                                    "message"
                                ]
                            }
                        }
                    }
                },
                "else": {
                    "properties": {
                        "commits": {
                            "items": {
                                "not": {
                                    "required": [
                                        "message"
                                    ]
                                }
                            }
                        }
                    }
                }
            }
        ]
    },
    "SourceCommit": {
        "type": "object",
        "properties": {
            "sha": {
                "type": "string",
                "minLength": 40,
                "maxLength": 64,
                "pattern": "^[0-9a-f]+$"
            },
            "subject": {
                "type": "string"
            },
            "message": {
                "type": "string",
                "maxLength": 65536
            },
            "pullRequestNumber": {
                "anyOf": [
                    {
                        "type": "integer",
                        "minimum": 1
                    },
                    {
                        "type": "null"
                    }
                ]
            }
        },
        "required": [
            "sha",
            "subject"
        ],
        "additionalProperties": false
    },
    "SourceFile": {
        "type": "object",
        "properties": {
            "path": {
                "type": "string"
            },
            "status": {
                "type": "string",
                "enum": [
                    "Added",
                    "Modified",
                    "Deleted",
                    "Renamed"
                ]
            },
            "diff": {
                "type": "string",
                "maxLength": 65536
            },
            "context": {
                "type": "string",
                "maxLength": 65536
            }
        },
        "required": [
            "path",
            "status",
            "diff"
        ],
        "additionalProperties": false
    },
    "SourcePullRequest": {
        "type": "object",
        "properties": {
            "number": {
                "type": "integer",
                "minimum": 1
            },
            "title": {
                "type": "string"
            },
            "description": {
                "type": "string"
            },
            "effectiveCommitSha": {
                "type": "string",
                "minLength": 40,
                "maxLength": 64,
                "pattern": "^[0-9a-f]+$"
            }
        },
        "required": [
            "number",
            "title",
            "effectiveCommitSha"
        ],
        "additionalProperties": false
    },
    "CollectorSourceProof": {
        "type": "object",
        "properties": {
            "schemaVersion": {
                "type": "integer",
                "const": 1
            },
            "completeness": {
                "type": "string",
                "enum": [
                    "Complete",
                    "Shallow",
                    "Truncated",
                    "Unavailable"
                ]
            },
            "commitCount": {
                "type": "integer",
                "minimum": 0,
                "maximum": 1000
            },
            "ancestry": {
                "type": "array",
                "minItems": 1,
                "maxItems": 2000,
                "items": {
                    "type": "object",
                    "properties": {
                        "sha": {
                            "type": "string",
                            "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
                        },
                        "parents": {
                            "type": "array",
                            "maxItems": 8,
                            "items": {
                                "type": "string",
                                "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
                            }
                        }
                    },
                    "required": [
                        "sha",
                        "parents"
                    ],
                    "additionalProperties": false
                }
            },
            "boundaries": {
                "type": "array",
                "minItems": 1,
                "maxItems": 2000,
                "items": {
                    "type": "object",
                    "properties": {
                        "root": {
                            "type": "string",
                            "enum": [
                                "From",
                                "To"
                            ]
                        },
                        "sha": {
                            "type": "string",
                            "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
                        },
                        "witnessPath": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": 2000,
                            "items": {
                                "type": "string",
                                "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
                            }
                        }
                    },
                    "required": [
                        "root",
                        "sha",
                        "witnessPath"
                    ],
                    "additionalProperties": false
                }
            },
            "commits": {
                "type": "array",
                "maxItems": 1000,
                "items": {
                    "type": "object",
                    "properties": {
                        "inputCommitIndex": {
                            "type": "integer",
                            "minimum": 0,
                            "maximum": 999
                        },
                        "fullMessageSha256": {
                            "type": "string",
                            "pattern": "^[0-9a-f]{64}$"
                        },
                        "excludedFiles": {
                            "type": "array",
                            "maxItems": 200,
                            "items": {
                                "type": "object",
                                "properties": {
                                    "path": {
                                        "type": "string",
                                        "minLength": 1,
                                        "maxLength": 1024
                                    },
                                    "blobSha": {
                                        "type": "string",
                                        "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
                                    },
                                    "status": {
                                        "type": "string",
                                        "enum": [
                                            "Added",
                                            "Modified",
                                            "Deleted",
                                            "Renamed"
                                        ]
                                    },
                                    "reason": {
                                        "type": "string",
                                        "enum": [
                                            "Ignored",
                                            "Sensitive",
                                            "Binary",
                                            "Unsupported"
                                        ]
                                    }
                                },
                                "required": [
                                    "path",
                                    "blobSha",
                                    "status",
                                    "reason"
                                ],
                                "additionalProperties": false
                            }
                        },
                        "files": {
                            "type": "array",
                            "maxItems": 200,
                            "items": {
                                "type": "object",
                                "properties": {
                                    "inputFileIndex": {
                                        "type": "integer",
                                        "minimum": 0,
                                        "maximum": 199
                                    },
                                    "blobSha": {
                                        "type": "string",
                                        "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
                                    },
                                    "state": {
                                        "type": "string",
                                        "enum": [
                                            "Readable",
                                            "Missing",
                                            "Unreadable"
                                        ]
                                    }
                                },
                                "required": [
                                    "inputFileIndex",
                                    "blobSha",
                                    "state"
                                ],
                                "additionalProperties": false
                            }
                        },
                        "protectedEvidence": {
                            "type": "array",
                            "maxItems": 1000,
                            "items": {
                                "type": "object",
                                "properties": {
                                    "kind": {
                                        "type": "string",
                                        "enum": [
                                            "BreakingChangeLabel",
                                            "SecurityLabel",
                                            "SecurityAdvisory"
                                        ]
                                    },
                                    "sourceReference": {
                                        "type": "string",
                                        "minLength": 1,
                                        "maxLength": 2048
                                    },
                                    "evidenceSha256": {
                                        "type": "string",
                                        "pattern": "^[0-9a-f]{64}$"
                                    }
                                },
                                "required": [
                                    "kind",
                                    "sourceReference",
                                    "evidenceSha256"
                                ],
                                "additionalProperties": false
                            }
                        }
                    },
                    "required": [
                        "inputCommitIndex",
                        "files",
                        "fullMessageSha256",
                        "protectedEvidence"
                    ],
                    "additionalProperties": false
                }
            },
            "pullRequests": {
                "type": "array",
                "maxItems": 1000,
                "items": {
                    "type": "object",
                    "properties": {
                        "inputPullRequestIndex": {
                            "type": "integer",
                            "minimum": 0,
                            "maximum": 999
                        },
                        "effectiveCommitSha": {
                            "type": "string",
                            "pattern": "^(?:[0-9a-f]{40}|[0-9a-f]{64})$"
                        }
                    },
                    "required": [
                        "inputPullRequestIndex",
                        "effectiveCommitSha"
                    ],
                    "additionalProperties": false
                }
            }
        },
        "required": [
            "schemaVersion",
            "completeness",
            "commitCount",
            "ancestry",
            "boundaries",
            "commits",
            "pullRequests"
        ],
        "additionalProperties": false
    }
};
