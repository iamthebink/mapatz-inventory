import { caseFold } from './unicode-case-fold.js';
/** Browser-safe profile normalization shared by commands, imports and SQLite. */
export interface BorrowerProfile {
  playaName: string;
  fullName: string;
  phoneNumber: string;
  campDepartment: string;
}

export const BORROWER_PROFILE_MAX_LENGTH = 100;

export function normalizeBorrowerText(value: string): string {
  return caseFold(value.normalize('NFKC').trim().replace(/\s+/gu, ' '));
}

export function normalizeBorrowerPhone(value: string): string {
  return normalizeBorrowerText(value).replace(/[\s().+\-–—/]/gu, '');
}

export function borrowerIdentity(profile: BorrowerProfile): string {
  return JSON.stringify([
    normalizeBorrowerText(profile.playaName),
    normalizeBorrowerText(profile.fullName),
    normalizeBorrowerPhone(profile.phoneNumber),
    normalizeBorrowerText(profile.campDepartment),
  ]);
}

export function trimBorrowerProfile(profile: BorrowerProfile): BorrowerProfile {
  return {
    playaName: profile.playaName.trim(),
    fullName: profile.fullName.trim(),
    phoneNumber: profile.phoneNumber.trim(),
    campDepartment: profile.campDepartment.trim(),
  };
}

export function isValidBorrowerProfile(profile: BorrowerProfile): boolean {
  return (
    profile != null &&
    ['playaName', 'fullName', 'phoneNumber', 'campDepartment'].every((field) => {
      const value = profile[field as keyof BorrowerProfile];
      return typeof value === 'string' && value.trim().length <= BORROWER_PROFILE_MAX_LENGTH;
    }) &&
    normalizeBorrowerText(profile.fullName).length > 0
  );
}

export function borrowerMatchKind(
  profile: BorrowerProfile,
  existing: BorrowerProfile,
): 'playa_name' | 'phone_number' | 'full_name' | undefined {
  const playa = normalizeBorrowerText(profile.playaName);
  const phone = normalizeBorrowerPhone(profile.phoneNumber);
  if (playa && playa === normalizeBorrowerText(existing.playaName)) return 'playa_name';
  if (phone && phone === normalizeBorrowerPhone(existing.phoneNumber)) return 'phone_number';
  if (normalizeBorrowerText(profile.fullName) === normalizeBorrowerText(existing.fullName))
    return 'full_name';
  return undefined;
}

/** Validate attributed rejection evidence without trusting the transport's type assertion. */
export function isBorrowerValidationEvidence(value: unknown, profile: BorrowerProfile): boolean {
  if (!value || typeof value !== 'object') return false;
  const evidence = value as Record<string, unknown>;
  if (!Array.isArray(evidence.matches) || !Array.isArray(evidence.fieldErrors)) return false;
  const ids = new Set<number>();
  let exact = false;
  for (const candidate of evidence.matches) {
    if (!candidate || typeof candidate !== 'object') return false;
    const match = candidate as Record<string, unknown>;
    if (
      Object.keys(match).some((key) => !['borrower', 'status', 'matchedBy'].includes(key)) ||
      !match.borrower ||
      typeof match.borrower !== 'object'
    )
      return false;
    const borrower = match.borrower as BorrowerProfile & { id: number; archived: boolean };
    if (
      !isValidBorrowerProfile(borrower) ||
      Object.keys(borrower).some(
        (key) =>
          !['id', 'playaName', 'fullName', 'phoneNumber', 'campDepartment', 'archived'].includes(
            key,
          ),
      ) ||
      !Number.isSafeInteger(borrower.id) ||
      borrower.id <= 0 ||
      typeof borrower.archived !== 'boolean' ||
      ids.has(borrower.id)
    )
      return false;
    ids.add(borrower.id);
    if (
      match.status !== (borrower.archived ? 'archived' : 'active') ||
      match.matchedBy !== borrowerMatchKind(profile, borrower)
    )
      return false;
    if (!match.matchedBy) return false;
    exact ||= borrowerIdentity(profile) === borrowerIdentity(borrower);
  }
  const expected = exact
    ? [{ field: 'fullName', code: 'duplicate_profile', message: 'כבר קיים שואל עם אותם פרטים' }]
    : [];
  return exact && JSON.stringify(evidence.fieldErrors) === JSON.stringify(expected);
}
