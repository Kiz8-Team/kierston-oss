import { BUNDLE } from "../../model_visible_text.ts";

/** Public identity claims. Specificity measures completeness, not uniqueness. */
export interface IdentityClaim {
  name?: string;
  dob?: string;
  ssn?: string;
}

/** v2: name and date of birth earn full credit for a person who holds no SSN. */
export const IDENTITY_POLICY = "identity-credit-30-60-100-signed-v2";

export function identityName(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function parseIdentity(value: unknown): {
  claim: IdentityClaim; credit: number; valid: boolean; key: string;
} {
  let raw: Record<string, unknown>;
  if (typeof value === "string") {
    raw = /^\d{3}-?\d{2}-?\d{4}$/.test(value.trim()) ? { ssn: value.trim() } : { name: value.trim() };
  } else if (value && typeof value === "object" && !Array.isArray(value)) {
    raw = value as Record<string, unknown>;
  } else raw = { invalid: value };
  const credit = "ssn" in raw ? 1 : "dob" in raw ? 0.6 : "name" in raw ? 0.3 : 1;
  const claim: IdentityClaim = {};
  let valid = Object.keys(raw).length > 0 && Object.keys(raw).every((key) => ["name", "dob", "ssn"].includes(key));
  if ("name" in raw) {
    valid &&= typeof raw.name === "string" && identityName(raw.name).split(" ").length >= 2;
    if (typeof raw.name === "string") claim.name = identityName(raw.name);
  }
  if ("dob" in raw) {
    valid &&= typeof raw.dob === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.dob)
      && Number.isFinite(Date.parse(raw.dob)) && new Date(raw.dob).toISOString().slice(0, 10) === raw.dob;
    if (typeof raw.dob === "string") claim.dob = raw.dob;
  }
  if ("ssn" in raw) {
    valid &&= typeof raw.ssn === "string" && /^\d{3}-?\d{2}-?\d{4}$/.test(raw.ssn.trim());
    if (typeof raw.ssn === "string") claim.ssn = raw.ssn.replace(/-/g, "").trim();
  }
  valid &&= !!claim.ssn || !!claim.name;
  // DOB by itself is never an identity. Invalid claims remain wrong guesses.
  return { claim, credit, valid, key: valid ? JSON.stringify(claim) : JSON.stringify(raw) };
}


/** Upgrade SSN-only wording without changing SSN starting clues. The wording is in model_visible_text.ts. */
export function identityPrompt(text: string): string {
  for (const [from, to] of BUNDLE.identityWording) text = text.replaceAll(from, to);
  return text.replace(BUNDLE.identityListing[0], BUNDLE.identityListing[1]);
}
