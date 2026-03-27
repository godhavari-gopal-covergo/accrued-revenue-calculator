/**
 * Stage 2 — Calculate earned premium from intermediate staging JSONs
 *
 * Reads staging documents from a specific run folder (runs/<runId>/),
 * runs the JSONata earned premium transformation on each, and writes
 * per-policy report JSONs and a combined JSONL back into the same run folder.
 *
 * Usage:
 *   npx ts-node calculate-earned-premium.ts --run <runId> [--year 2026] [--month 3]
 *
 * Reuses the JSONata expression from:
 *   ../src/transformation/earned-premium.jsonata
 */

import * as fs from 'fs';
import * as path from 'path';
import jsonata from 'jsonata';
import { policyNumberFilePrefix } from './policy-filename';

// ═══════════════════════════════════════════════════════════════
//  CLI
// ═══════════════════════════════════════════════════════════════

function parseArgs(): { year: number; month: number; run: string } {
  const args = process.argv.slice(2);
  const now = new Date();
  let year = now.getFullYear(), month = now.getMonth() + 1;
  let run = '';

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--year':  year  = parseInt(args[++i], 10); break;
      case '--month': month = parseInt(args[++i], 10); break;
      case '--run':   run   = args[++i]; break;
    }
  }
  if (!run) {
    console.error('Required: --run <runId>  (printed by Stage 1 after extraction)');
    process.exit(1);
  }
  return { year, month, run };
}

// ═══════════════════════════════════════════════════════════════
//  Custom date functions for JSONata (same as jsonata-runner.ts)
// ═══════════════════════════════════════════════════════════════

function daysBetween(d1: string, d2: string): number {
  const a = new Date(d1); a.setUTCHours(0, 0, 0, 0);
  const b = new Date(d2); b.setUTCHours(0, 0, 0, 0);
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function maxDate(d1: string, d2: string): string {
  if (!d1) return d2;
  if (!d2) return d1;
  return new Date(d1) > new Date(d2) ? d1 : d2;
}

function minDate(d1: string, d2: string): string {
  if (!d1) return d2;
  if (!d2) return d1;
  return new Date(d1) < new Date(d2) ? d1 : d2;
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

// ═══════════════════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════════════════

async function main() {
  const { year, month, run } = parseArgs();
  const periodStr = `${year}-${String(month).padStart(2, '0')}`;
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  console.log(`\n  Stage 2 — Earned Premium Calculation for ${periodStr}  (run: ${run})\n`);

  // ── Load JSONata expression from parent project ──
  const jsonataPath = path.resolve(__dirname, '..', 'src', 'transformation', 'earned-premium.jsonata');
  if (!fs.existsSync(jsonataPath)) {
    console.error(`  JSONata expression not found at: ${jsonataPath}`);
    process.exit(1);
  }
  const expressionText = fs.readFileSync(jsonataPath, 'utf-8');
  const expression = jsonata(expressionText);
  expression.registerFunction('daysBetween', daysBetween, '<ss:n>');
  expression.registerFunction('maxDate',     maxDate,     '<ss:s>');
  expression.registerFunction('minDate',     minDate,     '<ss:s>');
  expression.registerFunction('daysInMonth', daysInMonth, '<nn:n>');
  console.log(`  JSONata loaded from: ${path.relative(process.cwd(), jsonataPath)}\n`);

  // ── Discover staging files in the run folder ──
  const runDir = path.resolve(__dirname, 'runs', run);
  if (!fs.existsSync(runDir)) {
    console.error(`  Run folder not found: runs/${run}\n  Run extract-policy.ts first (Stage 1).`);
    process.exit(1);
  }
  const stagingFiles = fs.readdirSync(runDir)
    .filter(f =>
      f.endsWith('.json')
      && !f.startsWith('.')
      && !/_report_/.test(f),
    )
    .sort();

  if (stagingFiles.length === 0) {
    console.error(`  No staging files found in runs/${run}/`);
    process.exit(1);
  }
  console.log(`  Found ${stagingFiles.length} staging file(s) in runs/${run}/\n`);

  const jsonlNamePrefixes: string[] = [];

  // ── Process each staging document ──
  const jsonlLines: string[] = [];
  let totalPaidEarned = 0;
  let totalUnpaidDeferred = 0;
  let totalRefunds = 0;
  let totalPriorAdj = 0;
  let successCount = 0;
  let errorCount = 0;

  for (const file of stagingFiles) {
    const filePath = path.join(runDir, file);
    const stagingDoc = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

    const policyId = stagingDoc.policy?.policyId ?? 'unknown';
    const filePrefix = policyNumberFilePrefix(stagingDoc.policy?.policyNumber);

    // Strip _raw section before passing to JSONata (not needed for calculation)
    const { _raw, ...stagingForCalc } = stagingDoc;

    try {
      const result = await expression.evaluate(stagingForCalc);
      if (!result) {
        console.error(`  [FAIL] ${policyId}: JSONata returned null`);
        errorCount++;
        continue;
      }

      const reportFile = `${filePrefix}_${periodStr}_report_${ts}.json`;
      fs.writeFileSync(
        path.join(runDir, reportFile),
        JSON.stringify(result, null, 2) + '\n', 'utf-8',
      );

      jsonlLines.push(JSON.stringify(result));
      jsonlNamePrefixes.push(filePrefix);
      successCount++;

      const s = result.summary ?? {};
      totalPaidEarned     += s.totalPaidEarned ?? 0;
      totalUnpaidDeferred += s.totalUnpaidDeferred ?? 0;
      totalRefunds        += s.totalRefunds ?? 0;
      totalPriorAdj       += s.totalPriorPeriodAdjustments ?? 0;

      console.log(`  [OK] ${policyId.substring(0, 20).padEnd(20)}  gross=${s.totalGrossEarned}  paid=${s.totalPaidEarned}  unpaid=${s.totalUnpaidDeferred}  net=${s.netPaidEarnedPremium}`);

      // Print installment details
      const details: any[] = result.installmentDetails ?? [];
      for (const d of details) {
        console.log(`       └─ ${d.installmentId?.substring(0, 12)}  ${(d.fromDate ?? '').substring(0, 10)}→${(d.toDate ?? '').substring(0, 10)}  days=${d.effectiveDays}  rate=${d.dailyRate}  earned=${d.grossEarned}  paid=${d.isPaid}(${d.installmentStatus})`);
      }
    } catch (err: any) {
      console.error(`  [FAIL] ${policyId}: ${err.message}`);
      errorCount++;
    }
  }

  // ── Write combined JSONL into the run folder ──
  const singleConsistentPrefix =
    jsonlNamePrefixes.length === 1
      ? jsonlNamePrefixes[0]
      : (new Set(jsonlNamePrefixes).size === 1 ? jsonlNamePrefixes[0] : null);
  const jsonlFile = singleConsistentPrefix
    ? `${singleConsistentPrefix}_earned-premium_${periodStr}_${ts}.jsonl`
    : `earned-premium_${periodStr}_${ts}.jsonl`;
  const jsonlPath = path.join(runDir, jsonlFile);
  fs.writeFileSync(jsonlPath, jsonlLines.join('\n') + '\n', 'utf-8');

  // ── Summary ──
  const netPaidEarned = totalPaidEarned - totalRefunds + totalPriorAdj;

  console.log(`\n  ${'═'.repeat(56)}`);
  console.log(`  EARNED PREMIUM REPORT — ${periodStr}`);
  console.log(`  ${'═'.repeat(56)}`);
  console.log(`  Policies processed:       ${successCount}`);
  console.log(`  Errors:                   ${errorCount}`);
  console.log(`  ──────────────────────────────────────────────────────`);
  console.log(`  Total Paid Earned:        ${totalPaidEarned.toFixed(2)}`);
  console.log(`  Total Unpaid Deferred:    ${totalUnpaidDeferred.toFixed(2)}`);
  console.log(`  Total Refunds:            ${totalRefunds.toFixed(2)}`);
  console.log(`  Prior Period Adjustments: ${totalPriorAdj.toFixed(2)}`);
  console.log(`  ──────────────────────────────────────────────────────`);
  console.log(`  NET PAID EARNED PREMIUM:  ${netPaidEarned.toFixed(2)}`);
  console.log(`  ${'═'.repeat(56)}`);
  console.log(`\n  All outputs in: runs/${run}/`);
  console.log(`  JSONL → ${jsonlFile}\n`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
