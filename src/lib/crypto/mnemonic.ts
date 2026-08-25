/**
 * BIP39 recovery phrases.
 *
 * 12 words / 128 bits of entropy. This is the only way back into a vault whose
 * password has been forgotten, so the UI must make the user confirm they have
 * written it down before the phrase leaves the screen.
 */

import { generateMnemonic, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'

export const RECOVERY_PHRASE_WORDS = 12

export function generateRecoveryPhrase(): string {
  return generateMnemonic(wordlist, 128)
}

export function isValidRecoveryPhrase(phrase: string): boolean {
  return validateMnemonic(normaliseRecoveryPhrase(phrase), wordlist)
}

/**
 * Collapse the ways people retype a phrase: stray case, smart punctuation,
 * newlines from a pasted screenshot, double spaces.
 */
export function normaliseRecoveryPhrase(phrase: string): string {
  return phrase
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .join(' ')
}

export function recoveryPhraseWords(phrase: string): string[] {
  const normalised = normaliseRecoveryPhrase(phrase)
  return normalised === '' ? [] : normalised.split(' ')
}
