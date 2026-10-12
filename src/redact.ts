/**
 * Hide secrets and personal details in group messages before they go to the AI as background:
 * API keys and tokens, passwords, server logins, emails, phone numbers and card numbers become
 * "[hidden]". Links are left alone (status ids and paths are long numbers too). The asker's own
 * question is not changed: they chose to send it.
 */

const HIDDEN = "[hidden]";
const URL = /\bhttps?:\/\/\S+/gi;

const SECRETS: [RegExp, string | ((...m: string[]) => string)][] = [
  // Telegram bot tokens: 1234567890:AA…
  [/\b\d{6,12}:AA[\w-]{30,}/g, HIDDEN],
  // Provider keys: sk-…, sk-ant-…, xai-…, tvly-…, GitHub, AWS, Google, Slack; JSON web tokens.
  [/\b(?:sk|pk|rk)-(?:ant-|proj-)?[\w-]{16,}/g, HIDDEN],
  [/\b(?:xai|tvly|tvly-dev|gsk|hf)[-_][\w-]{16,}/gi, HIDDEN],
  [/\b(?:ghp|gho|ghu|ghs|github_pat)_\w{20,}/g, HIDDEN],
  [/\bAKIA[0-9A-Z]{16}\b/g, HIDDEN],
  [/\bAIza[\w-]{35}\b/g, HIDDEN],
  [/\bxox[abposr]-[\w-]{10,}/g, HIDDEN],
  [/\beyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,}/g, HIDDEN],
  [/\bBearer\s+[\w.~+/-]{16,}=*/gi, `Bearer ${HIDDEN}`],
  // "password: x", "密码是 x", "pwd=x": the label stays, the value goes.
  [/(\b(?:password|passwd|passcode|pwd)\s*(?:[:：=]|\s+is\b)\s*)\S+/gi, (_m, label) => `${label}${HIDDEN}`],
  [/((?:密码|密碼|口令)\s*(?:[:：=]|是|为|為)?\s*)\S+/g, (_m, label) => `${label}${HIDDEN}`],
  // Server logins as people paste them: "1.2.3.4 22 root s3cr3t".
  [/(\b\d{1,3}(?:\.\d{1,3}){3}(?:[\s:]+\d{2,5})?\s+(?:root|admin|ubuntu|debian|user)\s+)\S{6,}/gi, (_m, login) => `${login}${HIDDEN}`],
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, HIDDEN],
  // Phone numbers: international (+86 …), mainland mobiles, Taiwan mobiles.
  [/\+\d{1,3}[\s-]?\(?\d{1,4}\)?(?:[\s-]?\d{2,4}){2,4}\b/g, HIDDEN],
  [/(?<!\d)1[3-9]\d{9}(?!\d)/g, HIDDEN],
  [/(?<!\d)09\d{2}[\s-]?\d{3}[\s-]?\d{3}(?!\d)/g, HIDDEN],
];

/** Card numbers: 13–19 digits (spaces or dashes allowed) that pass the Luhn check. */
const CARD = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

function redactPlain(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRETS) out = out.replace(pattern, replacement as string);
  return out.replace(CARD, (match) => (luhn(match.replace(/\D/g, "")) ? HIDDEN : match));
}

export function redactSecrets(text: string): string {
  // Links keep their numbers and paths; everything between them is checked.
  let out = "";
  let last = 0;
  for (const match of text.matchAll(URL)) {
    out += redactPlain(text.slice(last, match.index)) + match[0];
    last = match.index! + match[0].length;
  }
  return out + redactPlain(text.slice(last));
}
