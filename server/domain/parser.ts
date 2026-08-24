import { reservationSeeds } from "../../src/shared/scenarios.js";

export interface ParsedTurn {
  confirmationCode?: string;
  lastName?: string;
  checkIn?: string;
  checkOut?: string;
  optionNumber?: 1 | 2 | 3;
  affirmed: boolean;
  denied: boolean;
  wantsDateChange: boolean;
}

const monthNumbers: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

function validIsoDate(year: number, month: number, day: number): string | undefined {
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return undefined;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseDateRange(text: string): { checkIn?: string; checkOut?: string } {
  const isoDates = text.match(/\b20\d{2}-\d{2}-\d{2}\b/g) ?? [];
  if (isoDates.length >= 2) return { checkIn: isoDates[0], checkOut: isoDates[1] };

  const commonYear = Number(text.match(/\b(20\d{2})\b/)?.[1] ?? "2027");
  const expression = new RegExp(
    `\\b(${Object.keys(monthNumbers).join("|")})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?`,
    "gi",
  );
  const dates: string[] = [];
  for (const match of text.matchAll(expression)) {
    const month = monthNumbers[match[1].toLowerCase()];
    const date = validIsoDate(Number(match[3] ?? commonYear), month, Number(match[2]));
    if (date) dates.push(date);
  }
  return { checkIn: dates[0], checkOut: dates[1] };
}

export function parseTurnDeterministic(text: string): ParsedTurn {
  const codeMatch = text.match(/\bMPT[\s-]?(\d{4})\b/i);
  const explicitName = text.match(/(?:last name(?: is)?|surname(?: is)?)\s+([a-z'-]+)/i)?.[1];
  const knownName = reservationSeeds.find((seed) => new RegExp(`\\b${seed.lastName}\\b`, "i").test(text))?.lastName;
  const optionMatch =
    text.match(/\b(?:option|choice|number)\s*(?:number\s*)?([123])\b/i)?.[1] ??
    text.match(/\b(?:take|choose|select|pick|want|prefer)\s+(?:option\s*)?([123])\b/i)?.[1];
  const ordinal = /\bfirst\b/i.test(text) ? 1 : /\bsecond\b/i.test(text) ? 2 : /\bthird\b/i.test(text) ? 3 : undefined;
  const dates = parseDateRange(text);

  return {
    confirmationCode: codeMatch ? `MPT-${codeMatch[1]}` : undefined,
    lastName: explicitName ?? knownName,
    checkIn: dates.checkIn,
    checkOut: dates.checkOut,
    optionNumber: (ordinal ?? (optionMatch ? Number(optionMatch) : undefined)) as 1 | 2 | 3 | undefined,
    affirmed: /\b(yes|confirm|go ahead|that works|do it|sounds good)\b/i.test(text),
    denied: /\b(no|don't|do not|not that|stop)\b/i.test(text),
    wantsDateChange: /\b(change|move|dates?|check[- ]?in|check[- ]?out|extend|shorten)\b/i.test(text),
  };
}
