#!/usr/bin/env node
import { runApply } from './apply.js';
import type { ApplyArgs } from './apply.js';
import { runDev } from './dev.js';
import type { DevArgs } from './dev.js';
import { runGenerate } from './generate.js';
import type { GenerateArgs } from './generate.js';
import { runPlan } from './plan.js';
import type { PlanArgs } from './plan.js';
import { runScan } from './scan.js';
import type { ScanArgs } from './scan.js';

/**
 * The `insler` binary entry point. Parses `argv`, dispatches to the matching
 * command, and sets the process exit code. Commands today are `scan`,
 * `generate`, `plan`, and `apply`; unknown or missing commands print usage and
 * exit non-zero.
 */

const USAGE = `insler — fleet tooling

Usage:
  insler scan [dir] [--json]          Scan a directory for service declarations
                                      and build the fleet manifest.
  insler generate [dir] [options]     Generate deployment artifacts from the
                                      fleet manifest.
    --out <dir>                       Output directory (default: ./out).
    --target <kubernetes|serverless>  Deployment target (default: kubernetes).
    --env <name>                      Environment name (default: dev).
    --dry-run                         Print artifacts to stdout, write nothing.
  insler plan [dir] [options]         Show the reconciliation plan (diff between
                                      desired and actual state).
    --state <file>                    Actual-state JSON snapshot (default: none).
    --env <name>                      Environment name (default: dev).
    --comment                         Emit a Markdown CI PR comment (blast
                                      radius + diff) instead of the plain plan.
  insler apply [dir] [options]        Execute the reconciliation plan, converging
                                      actual state to desired.
    --state <file>                    Actual-state JSON snapshot (default: none).
    --env <name>                      Environment name (default: dev).
    --dry-run                         Print the plan, change nothing.
    --audit <file>                    Audit-trail JSONL path for --env production
                                      (default: ./insler-audit.jsonl).
    --operator <id>                   Operator identity for the audit trail
                                      (default: $INSLER_OPERATOR or $USER).
  insler dev [dir] [options]          Development auto-converge: watch service
                                      declarations and auto-apply on every change
                                      (ungated). Development-only.
    --state <file>                    Actual-state JSON snapshot (default: none).
    --env <name>                      Environment name (default: dev). Refuses
                                      'production'.
`;

/**
 * The value of a trailing-value flag at `rest[i + 1]`, or `undefined` when the
 * next token is missing or itself flag-like — so `--state --env dev` never
 * swallows `--env` as a state path and a dangling `--state` is ignored rather
 * than consuming nothing.
 */
function flagValue(rest: readonly string[], i: number): string | undefined {
  const next = rest[i + 1];
  return next !== undefined && !next.startsWith('-') ? next : undefined;
}

/** Parse the args following `insler scan` into a {@link ScanArgs}. */
function parseScanArgs(rest: readonly string[]): ScanArgs {
  let cwd: string | undefined;
  let json = false;
  for (const arg of rest) {
    if (arg === '--json') {
      json = true;
    } else if (!arg.startsWith('-')) {
      cwd = arg;
    }
  }
  return { ...(cwd !== undefined ? { cwd } : {}), json };
}

/** Parse the args following `insler generate` into a {@link GenerateArgs}. */
function parseGenerateArgs(rest: readonly string[]): GenerateArgs {
  let cwd: string | undefined;
  let outputDir: string | undefined;
  let target: GenerateArgs['target'];
  let environment: string | undefined;
  let dryRun = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--out') {
      const value = flagValue(rest, i);
      if (value !== undefined) {
        outputDir = value;
        i += 1;
      }
    } else if (arg === '--target') {
      const value = flagValue(rest, i);
      if (value !== undefined) {
        if (value === 'kubernetes' || value === 'serverless') {
          target = value;
        }
        i += 1;
      }
    } else if (arg === '--env') {
      const value = flagValue(rest, i);
      if (value !== undefined) {
        environment = value;
        i += 1;
      }
    } else if (arg !== undefined && !arg.startsWith('-')) {
      cwd = arg;
    }
  }
  return {
    ...(cwd !== undefined ? { cwd } : {}),
    ...(outputDir !== undefined ? { outputDir } : {}),
    ...(target !== undefined ? { target } : {}),
    ...(environment !== undefined ? { environment } : {}),
    dryRun,
  };
}

/** Parse the args following `insler plan` into a {@link PlanArgs}. */
function parsePlanArgs(rest: readonly string[]): PlanArgs {
  let cwd: string | undefined;
  let environment: string | undefined;
  let statePath: string | undefined;
  let comment = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--comment') {
      comment = true;
    } else if (arg === '--state') {
      const value = flagValue(rest, i);
      if (value !== undefined) {
        statePath = value;
        i += 1;
      }
    } else if (arg === '--env') {
      const value = flagValue(rest, i);
      if (value !== undefined) {
        environment = value;
        i += 1;
      }
    } else if (arg !== undefined && !arg.startsWith('-')) {
      cwd = arg;
    }
  }
  return {
    ...(cwd !== undefined ? { cwd } : {}),
    ...(environment !== undefined ? { environment } : {}),
    ...(statePath !== undefined ? { statePath } : {}),
    comment,
  };
}

/** Parse the args following `insler apply` into an {@link ApplyArgs}. */
function parseApplyArgs(rest: readonly string[]): ApplyArgs {
  let cwd: string | undefined;
  let environment: string | undefined;
  let statePath: string | undefined;
  let auditPath: string | undefined;
  let operator: string | undefined;
  let dryRun = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--state') {
      const value = flagValue(rest, i);
      if (value !== undefined) {
        statePath = value;
        i += 1;
      }
    } else if (arg === '--env') {
      const value = flagValue(rest, i);
      if (value !== undefined) {
        environment = value;
        i += 1;
      }
    } else if (arg === '--audit') {
      const value = flagValue(rest, i);
      if (value !== undefined) {
        auditPath = value;
        i += 1;
      }
    } else if (arg === '--operator') {
      const value = flagValue(rest, i);
      if (value !== undefined) {
        operator = value;
        i += 1;
      }
    } else if (arg !== undefined && !arg.startsWith('-')) {
      cwd = arg;
    }
  }
  return {
    ...(cwd !== undefined ? { cwd } : {}),
    ...(environment !== undefined ? { environment } : {}),
    ...(statePath !== undefined ? { statePath } : {}),
    ...(auditPath !== undefined ? { auditPath } : {}),
    ...(operator !== undefined ? { operator } : {}),
    dryRun,
  };
}

/** Parse the args following `insler dev` into a {@link DevArgs}. */
function parseDevArgs(rest: readonly string[]): DevArgs {
  let cwd: string | undefined;
  let environment: string | undefined;
  let statePath: string | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--state') {
      const value = flagValue(rest, i);
      if (value !== undefined) {
        statePath = value;
        i += 1;
      }
    } else if (arg === '--env') {
      const value = flagValue(rest, i);
      if (value !== undefined) {
        environment = value;
        i += 1;
      }
    } else if (arg !== undefined && !arg.startsWith('-')) {
      cwd = arg;
    }
  }
  return {
    ...(cwd !== undefined ? { cwd } : {}),
    ...(environment !== undefined ? { environment } : {}),
    ...(statePath !== undefined ? { statePath } : {}),
  };
}

/** Run the CLI for a given argv tail (everything after `node insler`). */
export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === 'scan') {
    return runScan(parseScanArgs(rest), {
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    });
  }

  if (command === 'generate') {
    return runGenerate(parseGenerateArgs(rest), {
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    });
  }

  if (command === 'plan') {
    return runPlan(parsePlanArgs(rest), {
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    });
  }

  if (command === 'apply') {
    return runApply(parseApplyArgs(rest), {
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    });
  }

  if (command === 'dev') {
    const session = await runDev(parseDevArgs(rest), {
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    });
    // A refused (production) session exits immediately; an accepted one keeps
    // the process alive watching declarations until interrupted (Ctrl-C).
    if (session.code !== 0) {
      session.stop();
    }
    return session.code;
  }

  console.error(USAGE);
  return command === undefined || command === '--help' || command === '-h' ? 0 : 1;
}

// Only auto-run when invoked as the binary, not when imported by a test. Avoid
// top-level await so the entry compiles to both ESM and CJS.
if (import.meta.main) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
