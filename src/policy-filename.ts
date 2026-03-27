/**
 * Safe filename prefix from policy issuer number (human-readable policy number).
 */

export function policyNumberFilePrefix(policyNumber: string | null | undefined): string {
  const raw = policyNumber != null && String(policyNumber).trim() !== ''
    ? String(policyNumber).trim()
    : 'NO_POLICY_NUMBER';
  return raw.replace(/[/\\:*?"<>|\s]/g, '-');
}
