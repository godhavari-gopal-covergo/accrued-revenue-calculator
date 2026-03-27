/**
 * Stage 1 — Extract policy data from GraphQL API
 *
 * Queries all billing/premium/invoice/receipt/endorsement data for a single
 * policy and writes a normalised staging JSON into runs/<runId>/.
 *
 * Usage:
 *   npx ts-node extract-policy.ts \
 *     --policyId <uuid> \
 *     --endpoint <graphql-url> \
 *     --token <bearer-token> \
 *     [--year 2026] [--month 3]
 *
 * If --policyId, --endpoint, or --token is omitted, falls back to
 * COVERGO_POLICY_ID, COVERGO_GRAPHQL_ENDPOINT, COVERGO_BEARER_TOKEN.
 */

import * as fs from 'fs';
import * as path from 'path';
import { policyNumberFilePrefix } from './policy-filename';

// ═══════════════════════════════════════════════════════════════
//  CLI
// ═══════════════════════════════════════════════════════════════

interface Config {
  policyId: string;
  endpoint: string;
  token: string;
  year: number;
  month: number;
}

function parseArgs(): Config {
  const args = process.argv.slice(2);
  const now = new Date();
  let policyId = '', endpoint = '', token = '';
  let year = now.getFullYear(), month = now.getMonth() + 1;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--policyId': policyId = args[++i]; break;
      case '--endpoint': endpoint = args[++i]; break;
      case '--token':    token    = args[++i]; break;
      case '--year':     year     = parseInt(args[++i], 10); break;
      case '--month':    month    = parseInt(args[++i], 10); break;
    }
  }
  if (!policyId) policyId = process.env.COVERGO_POLICY_ID ?? '';
  if (!endpoint) endpoint = process.env.COVERGO_GRAPHQL_ENDPOINT ?? '';
  if (!token) token = process.env.COVERGO_BEARER_TOKEN ?? '';
  if (!policyId || !endpoint || !token) {
    console.error('Required: --policyId, --endpoint, --token (or COVERGO_POLICY_ID, COVERGO_GRAPHQL_ENDPOINT, COVERGO_BEARER_TOKEN)');
    process.exit(1);
  }
  return { policyId, endpoint, token, year, month };
}

// ═══════════════════════════════════════════════════════════════
//  GraphQL helpers
// ═══════════════════════════════════════════════════════════════

async function gql(endpoint: string, token: string, query: string, variables: Record<string, any> = {}): Promise<any> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GraphQL ${res.status}: ${(await res.text()).substring(0, 300)}`);
  const json = await res.json() as any;
  if (json.errors?.length) {
    const msgs = json.errors.map((e: any) => e.message).join('; ');
    console.warn(`  [gql warn] ${msgs.substring(0, 200)}`);
  }
  return json.data;
}

async function fetchAll(
  endpoint: string, token: string, query: string,
  variables: Record<string, any>, dataPath: string, pageSize = 50,
): Promise<any[]> {
  const all: any[] = [];
  let skip = 0;
  for (;;) {
    const vars = { ...variables, skip, take: pageSize };
    const data = await gql(endpoint, token, query, vars);
    const seg = dataPath.split('.').reduce((o: any, k) => o?.[k], data);
    if (!seg) break;
    const items: any[] = seg.items ?? (Array.isArray(seg) ? seg : []);
    all.push(...items);
    const total = seg.totalCount;
    if (total != null && all.length >= total) break;
    if (items.length < pageSize) break;
    skip += pageSize;
  }
  return all;
}

// ═══════════════════════════════════════════════════════════════
//  Queries — verified against live schema
// ═══════════════════════════════════════════════════════════════

const Q_POLICY_PREMIUMS = `query($where: PolicyPremiumFilterInput, $skip: Int, $take: Int) {
  policyPremiums(where: $where, skip: $skip, take: $take) {
    items {
      id policyId policyIssuerNumber status startDate endDate billingFrequency
      paidToDate billedToDate cancellationDate terminationDate policyCurrency
      contractHolder { contractHolderId contractHolderName contractHolderEmail }
      premiumSummary { totalBilled totalCollected totalReceived totalOutstanding totalRefund totalWaived }
    }
  }
}`;

const Q_INSTALLMENTS_POLICIES = `query($where: policies_PolicyInstallmentWhereInput, $skip: Int, $take: Int) {
  policies_policyInstallments(where: $where, skip: $skip, take: $take) {
    items {
      id policyId endorsementId order fromDate toDate billedDate
      status installmentType installmentTimingType
      premium premiumBeforeTax tax fee
    }
    totalCount
  }
}`;

const Q_INSTALLMENTS_PREMIUM = `query($where: PolicyPremiumInstallmentFilterInput, $skip: Int, $take: Int) {
  installments(where: $where, skip: $skip, take: $take) {
    items {
      id policyId from to status installmentType installmentTiming
      premiumRequired finalAmount premiumBeforeTax tax fee premiumIncludingTax
      invoiceNumber
    }
  }
}`;

const Q_MEMBER_INSTALLMENTS = `query($where: policies_PolicyMemberInstallmentWhereInput, $skip: Int, $take: Int) {
  policies_policyMemberInstallments(where: $where, skip: $skip, take: $take) {
    items {
      id policyId endorsementId policyMemberId order fromDate toDate
      status installmentType installmentTimingType
      premium premiumBeforeTax tax fee
    }
    totalCount
  }
}`;

const Q_INVOICES = `query($where: InvoiceFilterInput, $skip: Int, $take: Int) {
  invoices(where: $where, skip: $skip, take: $take) {
    items {
      id invoiceNumber policyId installmentId invoiceType
      issueDate dueDate status total totalPaidAmount totalOutstandingAmount
      paidDate currency amountBeforeTax amountIncludingTax totalFeeAmount
    }
  }
}`;

const Q_RECEIPTS = `query($where: ReceiptFilterInput, $skip: Int, $take: Int) {
  receipts(where: $where, skip: $skip, take: $take) {
    items {
      id receiptNumber receiptDate amount currency status
      internalPaymentReference externalPaymentReference
      entities { entityId entityType policyId policyNumber invoiceNumber installmentId amount }
    }
  }
}`;

const Q_REFUND_NOTES = `query($where: RefundNoteFilterInput, $skip: Int, $take: Int) {
  refundNotes(where: $where, skip: $skip, take: $take) {
    items {
      id refundNumber policyId installmentId total tax premiumBeforeTax
      currency status dueDate createdAt cancellationDate
    }
  }
}`;

const Q_ENDORSEMENT_BILLING_PLANS = `query($where: policies_EndorsementBillingPlanWhereInput, $skip: Int, $take: Int) {
  policies_endorsementBillingPlans(where: $where, skip: $skip, take: $take) {
    items {
      id policyId endorsementId effectiveDate
      isAdhocBillingWithFutureInstallments createdAt lastModifiedAt
      newInstallments { id fromDate toDate premium premiumBeforeTax tax fee status installmentType installmentTimingType }
      beforeInstallments { id fromDate toDate premium premiumBeforeTax tax fee status }
      afterInstallments { id fromDate toDate premium premiumBeforeTax tax fee status }
      cancelledInstallments { id fromDate toDate premium status }
      reversedInstallments { id fromDate toDate premium status }
      adhocInstallments { id fromDate toDate premium premiumBeforeTax tax fee status installmentType installmentTimingType }
    }
    totalCount
  }
}`;

const Q_ENDORSEMENT_PREMIUM = `query($policyId: String!, $endorsementId: String!) {
  policies_policyEndorsementPremium(policyId: $policyId, endorsementId: $endorsementId) {
    before { id policyId endorsementId effectiveDate summaries { annualPremium monthlyPremium } }
    after  { id policyId endorsementId effectiveDate summaries { annualPremium monthlyPremium } }
    adjustment { id policyId endorsementId effectiveDate summaries { annualPremium monthlyPremium } }
  }
}`;

// ═══════════════════════════════════════════════════════════════
//  Build staging document
// ═══════════════════════════════════════════════════════════════

function buildReportingPeriod(year: number, month: number) {
  const s = new Date(Date.UTC(year, month - 1, 1));
  const e = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
  return { year, month, startDate: s.toISOString(), endDate: e.toISOString() };
}

function mergeInstallments(policyInsts: any[], premiumInsts: any[], memberInsts: any[]) {
  const premiumById = new Map<string, any>();
  for (const pi of premiumInsts) premiumById.set(pi.id, pi);

  const memberByOrder = new Map<number, any[]>();
  for (const mi of memberInsts) {
    const key = mi.order ?? 0;
    if (!memberByOrder.has(key)) memberByOrder.set(key, []);
    memberByOrder.get(key)!.push(mi);
  }

  return policyInsts.map((inst: any) => {
    const pm = premiumById.get(inst.id);
    const memberInst = memberByOrder.get(inst.order) ?? [];

    return {
      installmentId: inst.id,
      policyId: inst.policyId,
      endorsementId: inst.endorsementId ?? null,
      order: inst.order,
      fromDate: inst.fromDate,
      toDate: inst.toDate,
      status: pm?.status ?? inst.status,
      installmentType: inst.installmentType ?? 'CHARGE',
      installmentTimingType: inst.installmentTimingType ?? 'REGULAR',
      billedDate: inst.billedDate ?? null,
      premiumBeforeTax: Number(pm?.premiumBeforeTax ?? inst.premiumBeforeTax ?? 0),
      tax: Number(pm?.tax ?? inst.tax ?? 0),
      fee: Number(pm?.fee ?? inst.fee ?? 0),
      totalPremium: Number(pm?.finalAmount ?? pm?.premiumRequired ?? inst.premium ?? 0),
      invoiceNumber: pm?.invoiceNumber ?? null,
      memberInstallments: memberInst.map((mi: any) => ({
        policyMemberId: mi.policyMemberId,
        fromDate: mi.fromDate,
        toDate: mi.toDate,
        premium: Number(mi.premium ?? 0),
        premiumBeforeTax: Number(mi.premiumBeforeTax ?? 0),
        tax: Number(mi.tax ?? 0),
      })),
    };
  });
}

function buildPremiumTimeline(pp: any, endorsements: any[]) {
  if (!pp?.startDate || !pp?.endDate) return [];

  const policyStart = pp.startDate;
  const policyEnd = pp.cancellationDate ?? pp.terminationDate ?? pp.endDate;

  const summary = pp.premiumSummary;
  const basePremium = Number(summary?.totalBilled ?? 0);
  if (basePremium <= 0) return [];

  const daysDiff = (a: string, b: string) => {
    const d1 = new Date(a), d2 = new Date(b);
    return Math.round((d2.getTime() - d1.getTime()) / 86400000) + 1;
  };

  let segments: any[] = [{
    effectiveFrom: policyStart,
    effectiveTo: policyEnd,
    endorsementId: null,
    annualPremium: basePremium,
    dailyRate: basePremium / Math.max(daysDiff(policyStart, policyEnd), 1),
    premiumBreakdown: [],
  }];

  const approved = endorsements
    .filter((e: any) => e.premiumData?.afterPremium != null && e.effectiveDate)
    .sort((a: any, b: any) => new Date(a.effectiveDate).getTime() - new Date(b.effectiveDate).getTime());

  for (const end of approved) {
    const effDate = typeof end.effectiveDate === 'string' && end.effectiveDate.includes('T')
      ? end.effectiveDate.split('T')[0]
      : end.effectiveDate;
    const newAP = Number(end.premiumData.afterPremium);
    const next: any[] = [];

    for (const seg of segments) {
      const segS = new Date(seg.effectiveFrom), segE = new Date(seg.effectiveTo), eD = new Date(effDate);
      if (eD <= segS || eD > segE) { next.push(seg); continue; }

      const dayBefore = new Date(eD);
      dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
      if (dayBefore >= segS) {
        const dayBeforeStr = dayBefore.toISOString().split('T')[0];
        next.push({ ...seg, effectiveTo: dayBeforeStr });
      }
      const totalDays = Math.max(daysDiff(effDate, policyEnd), 1);
      next.push({
        effectiveFrom: effDate,
        effectiveTo: seg.effectiveTo,
        endorsementId: end.endorsementId,
        annualPremium: newAP,
        dailyRate: newAP / totalDays,
        premiumBreakdown: [],
      });
    }
    segments = next;
  }
  return segments;
}

// ═══════════════════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════════════════

async function main() {
  const cfg = parseArgs();
  const period = buildReportingPeriod(cfg.year, cfg.month);
  const periodStr = `${cfg.year}-${String(cfg.month).padStart(2, '0')}`;
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const log = (m: string) => console.log(`  [extract] ${m}`);

  console.log(`\n  Stage 1 — Extracting policy ${cfg.policyId} for ${periodStr}\n`);

  // ── Fetch all data ──
  log('policyPremiums...');
  const policyPremiums = await fetchAll(cfg.endpoint, cfg.token, Q_POLICY_PREMIUMS,
    { where: { policyId: { eq: cfg.policyId } } }, 'policyPremiums');
  log(`  → ${policyPremiums.length} record(s)`);

  log('policies_policyInstallments...');
  const polInstallments = await fetchAll(cfg.endpoint, cfg.token, Q_INSTALLMENTS_POLICIES,
    { where: { policyId: cfg.policyId } }, 'policies_policyInstallments');
  log(`  → ${polInstallments.length}`);

  log('installments (premium module)...');
  const premInstallments = await fetchAll(cfg.endpoint, cfg.token, Q_INSTALLMENTS_PREMIUM,
    { where: { policyId: { eq: cfg.policyId } } }, 'installments');
  log(`  → ${premInstallments.length}`);

  log('policies_policyMemberInstallments...');
  const memberInsts = await fetchAll(cfg.endpoint, cfg.token, Q_MEMBER_INSTALLMENTS,
    { where: { policyId: cfg.policyId } }, 'policies_policyMemberInstallments');
  log(`  → ${memberInsts.length}`);

  log('invoices...');
  const invoices = await fetchAll(cfg.endpoint, cfg.token, Q_INVOICES,
    { where: { policyId: { eq: cfg.policyId } } }, 'invoices');
  log(`  → ${invoices.length}`);

  log('receipts...');
  const receipts = await fetchAll(cfg.endpoint, cfg.token, Q_RECEIPTS,
    { where: { entities: { some: { policyId: { eq: cfg.policyId } } } } }, 'receipts');
  log(`  → ${receipts.length}`);

  log('refundNotes...');
  const refunds = await fetchAll(cfg.endpoint, cfg.token, Q_REFUND_NOTES,
    { where: { policyId: { eq: cfg.policyId } } }, 'refundNotes');
  log(`  → ${refunds.length}`);

  log('endorsementBillingPlans...');
  const ebps = await fetchAll(cfg.endpoint, cfg.token, Q_ENDORSEMENT_BILLING_PLANS,
    { where: { policyId: cfg.policyId } }, 'policies_endorsementBillingPlans');
  log(`  → ${ebps.length}`);

  log('endorsementPremium details...');
  const endorsementPremiums: any[] = [];
  for (const ebp of ebps) {
    try {
      const d = await gql(cfg.endpoint, cfg.token, Q_ENDORSEMENT_PREMIUM,
        { policyId: cfg.policyId, endorsementId: ebp.endorsementId });
      const raw = d?.policies_policyEndorsementPremium;
      const afterSummary = raw?.after?.summaries;
      const beforeSummary = raw?.before?.summaries;
      endorsementPremiums.push({
        ...ebp,
        premiumData: {
          afterPremium: afterSummary?.annualPremium ?? afterSummary?.monthlyPremium ?? null,
          beforePremium: beforeSummary?.annualPremium ?? beforeSummary?.monthlyPremium ?? null,
          raw,
        },
      });
    } catch (err: any) {
      log(`  ⚠ ${ebp.endorsementId}: ${err.message}`);
      endorsementPremiums.push({ ...ebp, premiumData: null });
    }
  }
  log(`  → ${endorsementPremiums.length}`);

  // ── Assemble staging document ──
  const pp = policyPremiums[0];
  if (!pp) { console.error('  No policyPremium found — aborting'); process.exit(1); }

  const mergedInstallments = mergeInstallments(polInstallments, premInstallments, memberInsts);
  const premiumTimeline = buildPremiumTimeline(pp, endorsementPremiums);

  const normalizedInvoices = invoices.map((inv: any) => ({
    invoiceId: inv.id,
    invoiceNumber: inv.invoiceNumber,
    installmentId: inv.installmentId,
    issueDate: inv.issueDate,
    dueDate: inv.dueDate,
    status: inv.status,
    total: Number(inv.total ?? 0),
    totalPaidAmount: Number(inv.totalPaidAmount ?? 0),
    totalOutstandingAmount: Number(inv.totalOutstandingAmount ?? 0),
    paidDate: inv.paidDate ?? null,
    currency: inv.currency ?? pp.policyCurrency ?? 'CAD',
  }));

  const normalizedReceipts = receipts.map((r: any) => ({
    receiptId: r.id,
    receiptNumber: r.receiptNumber,
    receiptDate: r.receiptDate,
    amount: Number(r.amount ?? 0),
    currency: r.currency,
    status: r.status ?? 'CREATED',
    entities: (r.entities ?? []).map((e: any) => ({
      entityId: e.entityId,
      entityType: e.entityType,
      policyId: e.policyId,
      invoiceNumber: e.invoiceNumber,
      installmentId: e.installmentId,
      amount: Number(e.amount ?? 0),
    })),
  }));

  const normalizedRefunds = refunds.map((r: any) => ({
    refundId: r.id,
    refundNumber: r.refundNumber,
    installmentId: r.installmentId ?? null,
    total: Number(r.total ?? 0),
    premiumBeforeTax: Number(r.premiumBeforeTax ?? 0),
    tax: Number(r.tax ?? 0),
    currency: r.currency ?? pp.policyCurrency ?? 'CAD',
    status: r.status,
    dueDate: r.dueDate,
    createdAt: r.createdAt,
  }));

  const normalizedEndorsements = endorsementPremiums.map((ep: any) => ({
    endorsementId: ep.endorsementId,
    type: null,
    status: 'PASSED',
    effectiveDate: ep.effectiveDate,
    endorsementDate: ep.createdAt,
    billingPlan: {
      newInstallments: ep.newInstallments ?? [],
      beforeInstallments: ep.beforeInstallments ?? [],
      afterInstallments: ep.afterInstallments ?? [],
      adhocInstallments: ep.adhocInstallments ?? [],
      cancelledInstallments: ep.cancelledInstallments ?? [],
      reversedInstallments: ep.reversedInstallments ?? [],
    },
  }));

  const staging: any = {
    _id: `${cfg.policyId}_${periodStr}`,
    reportingPeriod: period,
    extractedAt: new Date().toISOString(),

    policy: {
      policyId: pp.policyId,
      policyNumber: pp.policyIssuerNumber ?? null,
      status: pp.status,
      startDate: pp.startDate,
      endDate: pp.endDate,
      cancellationDate: pp.cancellationDate ?? null,
      terminationDate: pp.terminationDate ?? null,
      billingFrequency: pp.billingFrequency,
      paidToDate: pp.paidToDate ?? null,
      billedToDate: pp.billedToDate ?? null,
      currency: pp.policyCurrency ?? 'CAD',
      productId: null,
      productName: null,
    },

    contractHolder: {
      payorId: pp.contractHolder?.contractHolderId ?? null,
      name: pp.contractHolder?.contractHolderName ?? null,
    },

    members: [],
    installments: mergedInstallments,
    invoices: normalizedInvoices,
    receipts: normalizedReceipts,
    payments: [],
    refunds: normalizedRefunds,
    endorsements: normalizedEndorsements,
    premiumTimeline,
    priorPeriodAdjustments: [],

    _raw: {
      policyPremiums,
      polInstallments,
      premInstallments,
      memberInsts,
      invoices,
      receipts,
      refunds,
      endorsementBillingPlans: ebps,
      endorsementPremiums,
    },
  };

  // ── Write to runs/<runId>/ ──
  const runId = ts;
  const runDir = path.resolve(__dirname, 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  const filePrefix = policyNumberFilePrefix(pp.policyIssuerNumber);
  const filename = `${filePrefix}_${periodStr}_${ts}.json`;
  const outPath = path.join(runDir, filename);
  fs.writeFileSync(outPath, JSON.stringify(staging, null, 2), 'utf-8');

  // ── Summary ──
  console.log(`\n  ┌─────────────────────────────────────────────────────┐`);
  console.log(`  │  Extraction complete                                │`);
  console.log(`  ├─────────────────────────────────────────────────────┤`);
  console.log(`  │  Policy:          ${pp.policyId}`);
  console.log(`  │  Policy number:   ${pp.policyIssuerNumber ?? '(none)'}`);
  console.log(`  │  Status:          ${pp.status}`);
  console.log(`  │  Period:          ${pp.startDate} → ${pp.endDate}`);
  console.log(`  │  Billing:         ${pp.billingFrequency}`);
  console.log(`  │  Paid To Date:    ${pp.paidToDate}`);
  console.log(`  │  Installments:    ${mergedInstallments.length}`);
  console.log(`  │  Invoices:        ${normalizedInvoices.length}`);
  console.log(`  │  Receipts:        ${normalizedReceipts.length}`);
  console.log(`  │  Refunds:         ${normalizedRefunds.length}`);
  console.log(`  │  Endorsements:    ${normalizedEndorsements.length}`);
  console.log(`  │  Timeline segs:   ${premiumTimeline.length}`);
  console.log(`  ├─────────────────────────────────────────────────────┤`);
  console.log(`  │  Run ID:  ${runId}`);
  console.log(`  │  Output:  runs/${runId}/${filename}`);
  console.log(`  └─────────────────────────────────────────────────────┘`);
  console.log(`\n  Use this for Stage 2:  --run ${runId}\n`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
