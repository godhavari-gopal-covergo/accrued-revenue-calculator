# Stage 1 GraphQL → staging → Stage 2 JSONata field map

This document lists **every GraphQL field requested in `extract-policy.ts`**, where it lands in the **staging JSON**, and whether / how **`earned-premium.jsonata`** (Stage 2) uses it.

**Important**

- Stage 2 **does not** receive `_raw`. `calculate-earned-premium.ts` removes `_raw` before evaluation. Anything that exists **only** under `_raw` is **not** available to the calculation (audit / replay only if you keep full staging files).
- Stage 2 loads logic from **`AccruedRevenue/src/transformation/earned-premium.jsonata`**. Paths below refer to that expression.
- **`contractHolder.contractHolderEmail`** is queried but **not written** into the staging document (dropped in extract).

Legend for Stage 2 column:

| Tag | Meaning |
|-----|---------|
| **Calc** | Drives earned premium, paid logic, refunds, or nets |
| **Out** | Copied into the final report object for display / traceability |
| **Meta** | Metadata / flags only |
| **Pass** | Array/object passed through to output unchanged |
| **—** | Present in staging (or only in `_raw`) but **not read** by JSONata |

---

## 1. Synthetic / non-GraphQL staging fields

| Staging path | Source | Stage 2 usage |
|--------------|--------|---------------|
| `_id` | `{policyId}_{period}` | **Meta** — `metadata.stagingDocId` |
| `reportingPeriod` (`year`, `month`, `startDate`, `endDate`) | CLI `--year` / `--month` | **Calc** — report window, overlap, `$daysInReportMonth`; **Out** — `reportingPeriod*` fields |
| `extractedAt` | `new Date().toISOString()` | **Meta** — `metadata.extractedAt` |
| `members` | Always `[]` | **—** (not referenced in JSONata) |
| `payments` | Always `[]` | **Calc** — `$isPaid` check 4 (`payments[...]`) is always empty for this extractor |
| `priorPeriodAdjustments` | Always `[]` | **Calc** — would map to `priorPeriodAdjustments` / `totalPriorPeriodAdjustments` if populated |
| `productId`, `productName` (under `policy`) | Hard-coded `null` | **Out** — echoed in `policy` |

---

## 2. `policyPremiums` — `Q_POLICY_PREMIUMS`

GraphQL path: `policyPremiums.items[]` → primary row `pp` drives `policy`, `contractHolder`, `premiumTimeline` (via `buildPremiumTimeline`), and currency fallbacks elsewhere.

| GraphQL field | Staging path | Stage 2 usage |
|---------------|--------------|---------------|
| `id` | Only in `_raw.policyPremiums[]` | **—** (`_raw` stripped) |
| `policyId` | `policy.policyId` | **Out** — `policy.policyId` |
| `policyIssuerNumber` | `policy.policyNumber` | **Out** — `policy.policyNumber` |
| `status` | `policy.status` | **Out** — `policy.status` |
| `startDate` | `policy.startDate` | **Calc** — policy window / overlap with report; **Out** |
| `endDate` | `policy.endDate` | **Calc** — default policy end if not cancelled; **Out** |
| `billingFrequency` | `policy.billingFrequency` | **Out** — `policy.billingFrequency` |
| `paidToDate` | `policy.paidToDate` | **Out** — `policy.paidToDate`; **Meta** — `paidToDateCurrent` flag |
| `billedToDate` | `policy.billedToDate` | **—** |
| `cancellationDate` | `policy.cancellationDate` | **Calc** — policy end override; **Out**; **Meta** — `hasCancellation` |
| `terminationDate` | `policy.terminationDate` | **Calc** — policy end fallback; **Out** |
| `policyCurrency` | `policy.currency` | **Out** — `policy.currency`; also default for invoices/refunds normalization (not separately read as “default” in JSONata beyond echoed policy) |
| `contractHolder.contractHolderId` | `contractHolder.payorId` | **Out** — `contractHolder.payorId` |
| `contractHolder.contractHolderName` | `contractHolder.name` | **Out** — `contractHolder.name` |
| `contractHolder.contractHolderEmail` | *(not stored)* | **—** |
| `premiumSummary.totalBilled` | Feeds `premiumTimeline[]` base segment (`annualPremium` / `dailyRate`) via `buildPremiumTimeline(pp, …)` | **Calc** — when timeline non-empty, segment `dailyRate`; **Pass** — segments in `premiumTimeline` on report |
| `premiumSummary.totalCollected` | Only in `_raw` | **—** |
| `premiumSummary.totalReceived` | Only in `_raw` | **—** |
| `premiumSummary.totalOutstanding` | Only in `_raw` | **—** |
| `premiumSummary.totalRefund` | Only in `_raw` | **—** |
| `premiumSummary.totalWaived` | Only in `_raw` | **—** |

---

## 3. `policies_policyInstallments` — `Q_INSTALLMENTS_POLICIES`

Merged into `installments[]` (with premium module + member rows). Below is **per merged installment** staging shape.

| GraphQL field | Staging path (`installments[]`) | Stage 2 usage |
|---------------|----------------------------------|---------------|
| `id` | `installmentId` | **Calc** — `$isPaid` joins to `invoices` / **Out** — `installmentDetails` |
| `policyId` | `policyId` | **—** |
| `endorsementId` | `endorsementId` | **Out** — `installmentDetails` |
| `order` | `order` | **—** |
| `fromDate` | `fromDate` | **Calc** — overlap, effective days, refund rows |
| `toDate` | `toDate` | **Calc** — same |
| `billedDate` | `billedDate` | **—** |
| `status` | `status` (pref. premium module) | **Calc** — `$isPaid` check 1 (`COLLECTED`); **Out** — `installmentStatus` |
| `installmentType` | `installmentType` | **Calc** — CHARGE vs REFUND branches; **Meta** — `hasAdhocCharges` filter |
| `installmentTimingType` | `installmentTimingType` | **Calc** — metadata AD_HOC filter; **Out** — `installmentDetails` |
| `premium` | Merged into `totalPremium` when premium module missing | **Calc** — `totalPremium` / refund daily rate |
| `premiumBeforeTax` | `premiumBeforeTax` | **Calc** — earned before tax, daily rate |
| `tax` | `tax` | **Calc** — `earnedTax` |
| `fee` | `fee` | **Calc** — `earnedFee` |

---

## 4. `installments` (premium module) — `Q_INSTALLMENTS_PREMIUM`

Merged by **`id`** with `policies_policyInstallments`. Fields below override or fill the same staging paths as in §3 where noted.

| GraphQL field | Staging path | Stage 2 usage |
|---------------|--------------|---------------|
| `id` | Maps to same installment as `installmentId` | **Calc** / **Out** (via merged row) |
| `policyId` | `policyId` | **—** |
| `from` | `fromDate` | Same as `fromDate` |
| `to` | `toDate` | Same as `toDate` |
| `status` | Overrides `status` when present | **Calc** — `$isPaid`; **Out** |
| `installmentType` | Overrides `installmentType` | **Calc** |
| `installmentTiming` | Mapped to `installmentTimingType` in merge | **Calc** / **Out** |
| `premiumRequired` | Part of `totalPremium` | **Calc** |
| `finalAmount` | Preferred for `totalPremium` | **Calc** |
| `premiumBeforeTax` | `premiumBeforeTax` | **Calc** |
| `tax` | `tax` | **Calc** |
| `fee` | `fee` | **Calc** |
| `premiumIncludingTax` | Not copied to staging | **—** |
| `invoiceNumber` | `invoiceNumber` | **—** |

---

## 5. `policies_policyMemberInstallments` — `Q_MEMBER_INSTALLMENTS`

| GraphQL field | Staging path | Stage 2 usage |
|---------------|--------------|---------------|
| All row fields | `installments[].memberInstallments[]` (nested) | **—** — JSONata does not read `memberInstallments` |

---

## 6. `invoices` — `Q_INVOICES`

Normalized to `invoices[]`.

| GraphQL field | Staging path | Stage 2 usage |
|---------------|--------------|---------------|
| `id` | `invoiceId` | **Calc** — `$isPaid` receipt check (`entities[entityId in $linkedInvoiceIds]`) |
| `invoiceNumber` | `invoiceNumber` | **Calc** — `$isPaid` payment check / invoice link |
| `policyId` | *(not in normalized)* | **—** |
| `installmentId` | `installmentId` | **Calc** — link installment → invoices |
| `invoiceType` | *(not in normalized)* | **—** |
| `issueDate` | `issueDate` | **—** |
| `dueDate` | `dueDate` | **—** |
| `status` | `status` | **Calc** — `$isPaid` check 2 (`PAID`, `OVERPAID`) |
| `total` | `total` | **—** |
| `totalPaidAmount` | `totalPaidAmount` | **—** |
| `totalOutstandingAmount` | `totalOutstandingAmount` | **—** |
| `paidDate` | `paidDate` | **—** |
| `currency` | `currency` | **—** |
| `amountBeforeTax` | *(not in normalized)* | **—** |
| `amountIncludingTax` | *(not in normalized)* | **—** |
| `totalFeeAmount` | *(not in normalized)* | **—** |

---

## 7. `receipts` — `Q_RECEIPTS`

Normalized to `receipts[]`; nested `entities` trimmed to listed fields.

| GraphQL field | Staging path | Stage 2 usage |
|---------------|--------------|---------------|
| `id` | `receiptId` | **—** (not used in expression) |
| `receiptNumber` | `receiptNumber` | **—** |
| `receiptDate` | `receiptDate` | **—** |
| `amount` | `amount` | **—** |
| `currency` | `currency` | **—** |
| `status` | `status` | **Calc** — receipt filter `status = "CREATED"` |
| `internalPaymentReference` | *(not in normalized)* | **—** |
| `externalPaymentReference` | *(not in normalized)* | **—** |
| `entities.entityId` | `entities[].entityId` | **Calc** — matched to `invoiceId` (see note below) |
| `entities.entityType` | `entities[].entityType` | **—** |
| `entities.policyId` | `entities[].policyId` | **—** |
| `entities.policyNumber` | *(not in normalized)* | **—** |
| `entities.invoiceNumber` | `entities[].invoiceNumber` | **—** in JSONata *(not used in filter)* |
| `entities.installmentId` | `entities[].installmentId` | **—** |
| `entities.amount` | `entities[].amount` | **—** |

**Note:** JSONata uses `entities[entityId in $linkedInvoiceIds]` where `$linkedInvoiceIds` comes from `invoices[].invoiceId`. This only works if receipt entities use invoice **IDs** as `entityId`; if the API uses another id, paid detection via receipts may not fire.

---

## 8. `refundNotes` — `Q_REFUND_NOTES`

Normalized to `refunds[]`.

| GraphQL field | Staging path | Stage 2 usage |
|---------------|--------------|---------------|
| `id` | `refundId` | **Out** — adhoc refund details |
| `refundNumber` | `refundNumber` | **Out** |
| `policyId` | *(not in normalized)* | **—** |
| `installmentId` | `installmentId` | **Calc** — adhoc filter (`null` / empty only) |
| `total` | `total` | **Calc** — `$adhocRefunds` sum → `totalRefunds` |
| `tax` | `tax` | **Out** — adhoc line |
| `premiumBeforeTax` | `premiumBeforeTax` | **Out** |
| `currency` | `currency` | **—** |
| `status` | `status` | **Out** |
| `dueDate` | `dueDate` | **—** |
| `createdAt` | `createdAt` | **Calc** — adhoc window vs `reportStart` / `reportEnd` |
| `cancellationDate` | *(not in normalized)* | **—** |

---

## 9. `policies_endorsementBillingPlans` — `Q_ENDORSEMENT_BILLING_PLANS`

Each item is merged with `Q_ENDORSEMENT_PREMIUM` into `_raw.endorsementPremiums[]` and drives **`buildPremiumTimeline`**. Normalized **`endorsements[]`** keep structure for the report.

| GraphQL field | Staging path | Stage 2 usage |
|---------------|--------------|---------------|
| `id` | `_raw` + nested in `billingPlan` | **—** in JSONata on normalized path |
| `policyId` | `_raw` / nested | **—** |
| `endorsementId` | `endorsements[].endorsementId` | **Out** — `endorsementsSummary`; **Meta** — `hasEndorsements` |
| `effectiveDate` | `endorsements[].effectiveDate` | **Out** — summary + `hasBackdatedImpact` vs `reportStart` |
| `isAdhocBillingWithFutureInstallments` | Inside `billingPlan` source objects | **—** |
| `createdAt` | `endorsements[].endorsementDate` | **—** |
| `lastModifiedAt` | Nested / `_raw` | **—** |
| `newInstallments` (full object) | `endorsements[].billingPlan.newInstallments` | **Out** — count only in `endorsementsSummary.billingImpact` |
| `beforeInstallments` | `…billingPlan.beforeInstallments` | **—** — not counted in summary |
| `afterInstallments` | `…billingPlan.afterInstallments` | **—** |
| `cancelledInstallments` | `…billingPlan.cancelledInstallments` | **Out** — count |
| `reversedInstallments` | `…billingPlan.reversedInstallments` | **—** |
| `adhocInstallments` | `…billingPlan.adhocInstallments` | **Out** — count |

Nested installment fields under those arrays (id, dates, premium, tax, fee, status, types, etc.) are **stored** for transparency but JSONata only uses **`.length`** for three buckets above.

---

## 10. `policies_policyEndorsementPremium` — `Q_ENDORSEMENT_PREMIUM`

Used in TypeScript only to set `premiumData` on items in `_raw.endorsementPremiums[]` and to feed **`buildPremiumTimeline`** (`afterPremium` / `beforePremium`).

| GraphQL field | Staging path | Stage 2 usage |
|---------------|--------------|---------------|
| `before` / `after` / `adjustment` (incl. `id`, `policyId`, `endorsementId`, `effectiveDate`, `summaries`) | `premiumData.raw` in `_raw` only; `afterPremium`/`beforePremium` used in TS for timeline | **Calc** — **indirect**: built `premiumTimeline[].dailyRate` / segment bounds; **Pass** — `premiumTimeline` on report |
| `summaries.annualPremium` / `monthlyPremium` | Coerced to `premiumData.afterPremium` / `beforePremium` in TS | **—** on staging root (not serialized on `endorsements[]`); timeline already encodes effect |

If the schema returns **warnings** for `annualPremium` / `monthlyPremium` on nested types, `afterPremium` may be missing → **empty `premiumTimeline`** for endorsement-driven segments (your current UAT behaviour).

---

## 11. `premiumTimeline[]` (derived in Stage 1)

Not raw GraphQL — built from `policyPremiums[0]` + endorsement premium data.

| Staging field | Stage 2 usage |
|---------------|---------------|
| `effectiveFrom`, `effectiveTo` | **Calc** — intersection with installment + report month; **Pass** — echoed in report |
| `endorsementId` | **Pass** |
| `annualPremium` | **Pass** |
| `dailyRate` | **Calc** — `$round($seg.dailyRate, 2) × days` when timeline non-empty |
| `premiumBreakdown` | **Pass** — always `[]` from extractor |

---

## 12. Summary: pulled for “context” but unused in Stage 2 calculation

| Category | Detail |
|----------|--------|
| **Entire `_raw` tree** | Stripped before JSONata — **no calculation use** |
| **`members[]`** | Always empty; never read |
| **`payments[]`** | Always empty; check 4 never succeeds |
| **`priorPeriodAdjustments[]`** | Always empty from this extractor |
| **`installments[].policyId`, `order`, `billedDate`, `invoiceNumber`, `memberInstallments`** | Not read |
| **`policy.billedToDate`** | Not read |
| **Most invoice & receipt amount / date fields** | Only `installmentId`, `status`, `invoiceId`, `invoiceNumber` (and receipt `status` / `entityId`) participate in `$isPaid` |
| **`refunds`**: `currency`, `dueDate`** | Not used in filters / sums shown |
| **Endorsement billing nested rows** | Full arrays stored; JSONata only **counts** `newInstallments`, `cancelledInstallments`, `adhocInstallments` |
| **`premiumTimeline[].annualPremium`, `endorsementId`, `premiumBreakdown`** | Passed through; **not** used in earned math (only `effectiveFrom`, `effectiveTo`, `dailyRate`) |

---

## 13. File reference

| Artifact | Path |
|----------|------|
| Stage 1 queries & mapping | `AccruedRevenue/src/extract-policy.ts` |
| Stage 2 expression | `AccruedRevenue/src/transformation/earned-premium.jsonata` |
| Stage 2 loader (strips `_raw`) | `AccruedRevenue/src/calculate-earned-premium.ts` |

Regenerate this document if you add GraphQL selections or change the staging schema / JSONata.
