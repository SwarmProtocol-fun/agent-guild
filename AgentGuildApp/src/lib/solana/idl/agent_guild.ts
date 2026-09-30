/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/agent_guild.json`.
 */
export type AgentGuild = {
  "address": "4T3UJ83HEwQH3Pb6eQuMnkEYSxyqXv7o6rNARXXKT3ci",
  "metadata": {
    "name": "agentGuild",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Agent Guild on-chain program: agent registry, task board escrow, treasury"
  },
  "docs": [
    "Agent Guild on-chain program.",
    "",
    "Consolidates what used to be four separate Solidity contracts",
    "(AgentGuildAgentRegistryLink, AgentGuildASNRegistry, AgentGuildTaskBoardLink,",
    "AgentGuildTreasuryLink) into one Anchor program, using native SOL lamports",
    "for escrow/treasury instead of the LINK ERC-20 token those contracts used."
  ],
  "instructions": [
    {
      "name": "approveDelivery",
      "discriminator": [
        28,
        233,
        51,
        115,
        33,
        220,
        41,
        28
      ],
      "accounts": [
        {
          "name": "poster",
          "writable": true,
          "signer": true
        },
        {
          "name": "taskAccount",
          "writable": true
        },
        {
          "name": "claimant",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "claimTask",
      "discriminator": [
        49,
        222,
        219,
        238,
        155,
        68,
        221,
        136
      ],
      "accounts": [
        {
          "name": "claimant",
          "signer": true
        },
        {
          "name": "taskAccount",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "createPenaltyProposal",
      "discriminator": [
        144,
        61,
        85,
        173,
        131,
        0,
        49,
        248
      ],
      "accounts": [
        {
          "name": "proposer",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  117,
                  105,
                  108,
                  100,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "agentAccount"
        },
        {
          "name": "proposal",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  112,
                  111,
                  115,
                  97,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "config.proposal_counter",
                "account": "guildConfig"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "asn",
          "type": "string"
        },
        {
          "name": "amount",
          "type": "u16"
        },
        {
          "name": "reason",
          "type": "string"
        }
      ]
    },
    {
      "name": "deactivateAgent",
      "discriminator": [
        205,
        171,
        239,
        225,
        82,
        126,
        96,
        166
      ],
      "accounts": [
        {
          "name": "agentWallet",
          "signer": true
        },
        {
          "name": "agentAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  103,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "agentWallet"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "depositRevenue",
      "discriminator": [
        224,
        212,
        82,
        100,
        60,
        240,
        220,
        29
      ],
      "accounts": [
        {
          "name": "depositor",
          "writable": true,
          "signer": true
        },
        {
          "name": "treasury",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "disputeDelivery",
      "discriminator": [
        4,
        16,
        98,
        240,
        151,
        95,
        239,
        196
      ],
      "accounts": [
        {
          "name": "poster",
          "signer": true
        },
        {
          "name": "taskAccount",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "expireTask",
      "discriminator": [
        116,
        94,
        206,
        205,
        170,
        51,
        156,
        98
      ],
      "accounts": [
        {
          "name": "poster",
          "docs": [
            "Must be the original poster — they're the only one who can be a",
            "refund destination for their own escrow (mirrors the `address =`",
            "checks on `ApproveDelivery`/`ResolveDispute`'s payout accounts)."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "taskAccount",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "initialize",
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  117,
                  105,
                  108,
                  100,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "initializeTreasury",
      "discriminator": [
        124,
        186,
        211,
        195,
        85,
        165,
        129,
        166
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  117,
                  105,
                  108,
                  100,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "treasury",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "postTask",
      "discriminator": [
        186,
        136,
        157,
        9,
        235,
        251,
        62,
        142
      ],
      "accounts": [
        {
          "name": "poster",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  117,
                  105,
                  108,
                  100,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "taskAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  97,
                  115,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "config.task_counter",
                "account": "guildConfig"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "title",
          "type": "string"
        },
        {
          "name": "description",
          "type": "string"
        },
        {
          "name": "requiredSkills",
          "type": "string"
        },
        {
          "name": "deadline",
          "type": "i64"
        },
        {
          "name": "budgetLamports",
          "type": "u64"
        }
      ]
    },
    {
      "name": "registerAgent",
      "discriminator": [
        135,
        157,
        66,
        195,
        2,
        113,
        175,
        30
      ],
      "accounts": [
        {
          "name": "agentWallet",
          "writable": true,
          "signer": true
        },
        {
          "name": "agentAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  103,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "agentWallet"
              }
            ]
          }
        },
        {
          "name": "asnRecord",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  115,
                  110
                ]
              },
              {
                "kind": "arg",
                "path": "asn"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "skills",
          "type": "string"
        },
        {
          "name": "asn",
          "type": "string"
        },
        {
          "name": "feeRateBps",
          "type": "u16"
        }
      ]
    },
    {
      "name": "registerAgentFor",
      "discriminator": [
        50,
        181,
        29,
        127,
        225,
        32,
        185,
        84
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  117,
                  105,
                  108,
                  100,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "agentAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  103,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "agentWallet"
              }
            ]
          }
        },
        {
          "name": "asnRecord",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  115,
                  110
                ]
              },
              {
                "kind": "arg",
                "path": "asn"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "agentWallet",
          "type": "pubkey"
        },
        {
          "name": "name",
          "type": "string"
        },
        {
          "name": "skills",
          "type": "string"
        },
        {
          "name": "asn",
          "type": "string"
        },
        {
          "name": "feeRateBps",
          "type": "u16"
        }
      ]
    },
    {
      "name": "resolveDispute",
      "discriminator": [
        231,
        6,
        202,
        6,
        96,
        103,
        12,
        230
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  117,
                  105,
                  108,
                  100,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "taskAccount",
          "writable": true
        },
        {
          "name": "poster",
          "writable": true
        },
        {
          "name": "claimant",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "agentBps",
          "type": "u16"
        }
      ]
    },
    {
      "name": "resolvePenaltyProposal",
      "discriminator": [
        191,
        186,
        227,
        32,
        194,
        145,
        250,
        19
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  117,
                  105,
                  108,
                  100,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "proposal",
          "writable": true
        },
        {
          "name": "agentAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  103,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "proposal.agent",
                "account": "penaltyProposal"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "approve",
          "type": "bool"
        }
      ]
    },
    {
      "name": "setAgentAddress",
      "discriminator": [
        38,
        191,
        111,
        19,
        115,
        205,
        49,
        249
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  117,
                  105,
                  108,
                  100,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "treasury",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "agentAddress",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "submitDelivery",
      "discriminator": [
        217,
        177,
        33,
        54,
        136,
        185,
        123,
        96
      ],
      "accounts": [
        {
          "name": "claimant",
          "signer": true
        },
        {
          "name": "taskAccount",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "deliveryHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "updateCredit",
      "discriminator": [
        229,
        12,
        161,
        45,
        129,
        154,
        145,
        166
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  117,
                  105,
                  108,
                  100,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "agentAccount",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "creditScore",
          "type": "u16"
        },
        {
          "name": "trustScore",
          "type": "u8"
        }
      ]
    },
    {
      "name": "updateSkills",
      "discriminator": [
        86,
        199,
        57,
        60,
        228,
        127,
        64,
        129
      ],
      "accounts": [
        {
          "name": "agentWallet",
          "signer": true
        },
        {
          "name": "agentAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  103,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "agentWallet"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "newSkills",
          "type": "string"
        }
      ]
    },
    {
      "name": "withdraw",
      "discriminator": [
        183,
        18,
        70,
        156,
        148,
        109,
        161,
        34
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  117,
                  105,
                  108,
                  100,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "treasury",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "to",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "agentAccount",
      "discriminator": [
        241,
        119,
        69,
        140,
        233,
        9,
        112,
        50
      ]
    },
    {
      "name": "asnRecord",
      "discriminator": [
        247,
        31,
        98,
        198,
        214,
        209,
        142,
        121
      ]
    },
    {
      "name": "guildConfig",
      "discriminator": [
        142,
        244,
        14,
        175,
        238,
        7,
        243,
        130
      ]
    },
    {
      "name": "penaltyProposal",
      "discriminator": [
        244,
        150,
        111,
        49,
        8,
        206,
        64,
        117
      ]
    },
    {
      "name": "taskAccount",
      "discriminator": [
        235,
        32,
        10,
        23,
        81,
        60,
        170,
        203
      ]
    },
    {
      "name": "treasuryAccount",
      "discriminator": [
        204,
        140,
        18,
        173,
        90,
        152,
        134,
        123
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "nameTooLong",
      "msg": "Name exceeds maximum length"
    },
    {
      "code": 6001,
      "name": "skillsTooLong",
      "msg": "Skills string exceeds maximum length"
    },
    {
      "code": 6002,
      "name": "asnTooLong",
      "msg": "ASN exceeds maximum length"
    },
    {
      "code": 6003,
      "name": "titleTooLong",
      "msg": "Title exceeds maximum length"
    },
    {
      "code": 6004,
      "name": "descriptionTooLong",
      "msg": "Description exceeds maximum length"
    },
    {
      "code": 6005,
      "name": "requiredSkillsTooLong",
      "msg": "Required skills exceeds maximum length"
    },
    {
      "code": 6006,
      "name": "feeRateTooHigh",
      "msg": "Fee rate exceeds 10000 bps (100%)"
    },
    {
      "code": 6007,
      "name": "invalidDeadline",
      "msg": "Task deadline must be in the future"
    },
    {
      "code": 6008,
      "name": "invalidBudget",
      "msg": "Task budget must be greater than zero"
    },
    {
      "code": 6009,
      "name": "taskNotOpen",
      "msg": "Task is not open"
    },
    {
      "code": 6010,
      "name": "taskNotClaimed",
      "msg": "Task is not claimed"
    },
    {
      "code": 6011,
      "name": "notClaimant",
      "msg": "Only the assigned agent can submit delivery"
    },
    {
      "code": 6012,
      "name": "notPoster",
      "msg": "Only the task poster can approve or dispute delivery"
    },
    {
      "code": 6013,
      "name": "noDeliverySubmitted",
      "msg": "Task has no delivery submitted yet"
    },
    {
      "code": 6014,
      "name": "taskNotDisputed",
      "msg": "Task is not disputed"
    },
    {
      "code": 6015,
      "name": "taskNotExpired",
      "msg": "Task deadline has not passed yet"
    },
    {
      "code": 6016,
      "name": "taskDeadlinePassed",
      "msg": "Task deadline has already passed; call expire_task instead"
    },
    {
      "code": 6017,
      "name": "cannotClaimOwnTask",
      "msg": "Cannot claim your own task"
    },
    {
      "code": 6018,
      "name": "invalidSplitBps",
      "msg": "Agent split bps exceeds 10000"
    },
    {
      "code": 6019,
      "name": "invalidDepositAmount",
      "msg": "Deposit amount must be greater than zero"
    },
    {
      "code": 6020,
      "name": "insufficientTreasuryBalance",
      "msg": "Withdrawal amount exceeds available treasury balance"
    },
    {
      "code": 6021,
      "name": "unauthorized",
      "msg": "Unauthorized: caller is not the program authority"
    },
    {
      "code": 6022,
      "name": "overflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6023,
      "name": "reasonTooLong",
      "msg": "Reason exceeds maximum length"
    },
    {
      "code": 6024,
      "name": "proposalNotPending",
      "msg": "Proposal is not pending"
    }
  ],
  "types": [
    {
      "name": "agentAccount",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "name",
            "type": "string"
          },
          {
            "name": "skills",
            "type": "string"
          },
          {
            "name": "asn",
            "type": "string"
          },
          {
            "name": "feeRateBps",
            "docs": [
              "Validated (<= 10_000) and stored at registration, but currently",
              "UNUSED by task_board's payout logic — approve_delivery and",
              "resolve_dispute send the full budget/split to the claimant with no",
              "fee deducted. This mirrors the original Solidity",
              "AgentGuildAgentRegistryLink.feeRate, which was also stored and never",
              "consumed by AgentGuildTaskBoardLink/AgentGuildTreasuryLink — so this",
              "isn't a Solana-port regression, it's a field reserved for a fee",
              "mechanism that was never implemented in either codebase. Don't wire",
              "in a fee deduction here without first deciding, as a product",
              "question, who collects it (treasury vs. per-agent), whether",
              "resolve_dispute's split is fee-exempt, and how existing registered",
              "agents' already-set fee_rate_bps should be treated on rollout."
            ],
            "type": "u16"
          },
          {
            "name": "creditScore",
            "type": "u16"
          },
          {
            "name": "trustScore",
            "type": "u8"
          },
          {
            "name": "active",
            "type": "bool"
          },
          {
            "name": "registeredAt",
            "type": "i64"
          },
          {
            "name": "lastUpdated",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "asnRecord",
      "docs": [
        "Maps an ASN string to its owning agent wallet — replaces `ASNRegistry`'s",
        "lookup role (`asnToAgent` in the Solidity `AgentGuildAgentRegistryLink`)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "asn",
            "type": "string"
          },
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "guildConfig",
      "docs": [
        "Global program config — replaces OpenZeppelin `Ownable` from the Solidity",
        "contracts. `authority` gates every admin-only instruction (registerAgentFor,",
        "updateCredit, resolveDispute, withdraw, resolvePenaltyProposal). `task_counter`",
        "and `proposal_counter` are monotonically increasing ids seeding `TaskAccount`",
        "and `PenaltyProposal` PDAs respectively."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "taskCounter",
            "type": "u64"
          },
          {
            "name": "proposalCounter",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "penaltyProposal",
      "docs": [
        "A penalty-governance proposal — replaces the Hedera governance/slashing",
        "mods. Single-authority approval (matches how the app is already",
        "admin-driven elsewhere, e.g. `requirePlatformAdmin`), not a multi-sig vote.",
        "Approved proposals ARE the on-chain slashing history for an agent —",
        "`getAgentSlashingHistory` reads them back by filtering on `agent` +",
        "`status == Approved`, no separate history account needed."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "proposalId",
            "type": "u64"
          },
          {
            "name": "asn",
            "type": "string"
          },
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u16"
          },
          {
            "name": "reason",
            "type": "string"
          },
          {
            "name": "proposer",
            "type": "pubkey"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "proposalStatus"
              }
            }
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "resolvedAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "proposalStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "pending"
          },
          {
            "name": "approved"
          },
          {
            "name": "rejected"
          }
        ]
      }
    },
    {
      "name": "taskAccount",
      "docs": [
        "A task's escrow lives directly on this PDA's lamport balance (funded by",
        "`post_task`'s transfer on top of its own rent-exempt minimum) — there is no",
        "separate vault account, mirroring how `AgentGuildTaskBoardLink` held the",
        "LINK escrow on the task-board contract itself."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "taskId",
            "type": "u64"
          },
          {
            "name": "poster",
            "type": "pubkey"
          },
          {
            "name": "claimedBy",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "title",
            "type": "string"
          },
          {
            "name": "description",
            "type": "string"
          },
          {
            "name": "requiredSkills",
            "type": "string"
          },
          {
            "name": "deadline",
            "type": "i64"
          },
          {
            "name": "budgetLamports",
            "type": "u64"
          },
          {
            "name": "deliveryHash",
            "type": {
              "option": {
                "array": [
                  "u8",
                  32
                ]
              }
            }
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "taskStatus"
              }
            }
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "taskStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "open"
          },
          {
            "name": "claimed"
          },
          {
            "name": "completed"
          },
          {
            "name": "expired"
          },
          {
            "name": "disputed"
          },
          {
            "name": "resolved"
          }
        ]
      }
    },
    {
      "name": "treasuryAccount",
      "docs": [
        "Revenue-splitting treasury — same 50/30/20 compute/growth/reserve split as",
        "`AgentGuildTreasuryLink`, denominated in native lamports instead of LINK."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "agentAddress",
            "type": "pubkey"
          },
          {
            "name": "computeBalance",
            "type": "u64"
          },
          {
            "name": "growthBalance",
            "type": "u64"
          },
          {
            "name": "reserveBalance",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    }
  ]
};
