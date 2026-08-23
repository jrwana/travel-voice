import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ChangeOption, PublicReservation } from "../../src/shared/contracts.js";
import { reservationSeeds } from "../../src/shared/scenarios.js";

const manageReservationInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("find"),
    confirmationCode: z.string().trim().min(1),
    lastName: z.string().trim().min(1),
  }),
  z.object({
    action: z.literal("quote_date_change"),
    reservationId: z.string().min(1),
    checkIn: z.string().date(),
    checkOut: z.string().date(),
  }),
  z.object({
    action: z.literal("confirm_date_change"),
    quoteToken: z.string().min(1),
    optionId: z.string().min(1),
    idempotencyKey: z.string().min(1),
  }),
]);

export type ManageReservationInput = z.infer<typeof manageReservationInputSchema>;

interface ReservationRecord extends PublicReservation {
  normalizedLastName: string;
  version: number;
}

interface QuoteRecord {
  quoteToken: string;
  reservationId: string;
  reservationVersion: number;
  expiresAtMs: number;
  options: ChangeOption[];
}

export class ReservationToolError extends Error {
  constructor(
    public readonly code:
      | "NOT_FOUND"
      | "INVALID_DATES"
      | "STALE_QUOTE"
      | "OPTION_NOT_FOUND"
      | "CONFLICT"
      | "INTERNAL_ERROR",
    message: string,
  ) {
    super(message);
  }
}

function normalizeCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/[^a-z'-]/g, "");
}

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function stayLength(checkIn: string, checkOut: string): number {
  return (Date.parse(`${checkOut}T00:00:00.000Z`) - Date.parse(`${checkIn}T00:00:00.000Z`)) / 86_400_000;
}

export class MockReservationTool {
  private reservations = new Map<string, ReservationRecord>();
  private quotes = new Map<string, QuoteRecord>();
  private confirmations = new Map<string, Record<string, unknown>>();

  constructor() {
    this.reset();
  }

  reset(): void {
    this.reservations = new Map(
      reservationSeeds.map((seed) => [
        seed.reservationId,
        {
          reservationId: seed.reservationId,
          confirmationCode: seed.confirmationCode,
          travelerDisplayName: `${seed.firstName} ${seed.lastName}`,
          normalizedLastName: normalizeName(seed.lastName),
          guests: seed.guests,
          status: "confirmed" as const,
          stay: structuredClone(seed.stay),
          version: 1,
        },
      ]),
    );
    this.quotes.clear();
    this.confirmations.clear();
  }

  async manageReservation(rawInput: ManageReservationInput): Promise<Record<string, unknown>> {
    const input = manageReservationInputSchema.parse(rawInput);
    if (input.action === "find") return this.find(input.confirmationCode, input.lastName);
    if (input.action === "quote_date_change") {
      return this.quote(input.reservationId, input.checkIn, input.checkOut);
    }
    return this.confirm(input.quoteToken, input.optionId, input.idempotencyKey);
  }

  private find(confirmationCode: string, lastName: string): Record<string, unknown> {
    const reservation = [...this.reservations.values()].find(
      (candidate) =>
        normalizeCode(candidate.confirmationCode) === normalizeCode(confirmationCode) &&
        candidate.normalizedLastName === normalizeName(lastName),
    );
    if (!reservation) throw new ReservationToolError("NOT_FOUND", "No matching synthetic reservation was found.");
    return { action: "find", reservation: this.publicReservation(reservation) };
  }

  private quote(reservationId: string, checkIn: string, checkOut: string): Record<string, unknown> {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) throw new ReservationToolError("NOT_FOUND", "The reservation is no longer available.");
    const nights = stayLength(checkIn, checkOut);
    if (!Number.isFinite(nights) || nights < 1 || nights > 30) {
      throw new ReservationToolError("INVALID_DATES", "Check-out must be after check-in and the stay must be 30 nights or fewer.");
    }

    const quoteToken = `qt_${randomUUID()}`;
    const options: ChangeOption[] = [
      {
        optionId: `opt_${randomUUID()}`,
        label: "Requested dates",
        checkIn,
        checkOut,
        roomType: reservation.stay.roomType,
        priceDeltaCents: 12_000,
        currency: "USD",
        policySummary: "Same room · flexible until 72 hours before arrival",
      },
      {
        optionId: `opt_${randomUUID()}`,
        label: "Room upgrade",
        checkIn,
        checkOut,
        roomType: "Premium terrace king",
        priceDeltaCents: 26_500,
        currency: "USD",
        policySummary: "Upgraded room · flexible until 72 hours before arrival",
      },
      {
        optionId: `opt_${randomUUID()}`,
        label: "Flexible dates",
        checkIn: addDays(checkIn, -1),
        checkOut: addDays(checkOut, -1),
        roomType: "Courtyard queen",
        priceDeltaCents: -4_500,
        currency: "USD",
        policySummary: "One day earlier · flexible until 72 hours before arrival",
      },
    ];
    this.quotes.set(quoteToken, {
      quoteToken,
      reservationId,
      reservationVersion: reservation.version,
      expiresAtMs: Date.now() + 10 * 60_000,
      options,
    });
    return {
      action: "quote_date_change",
      quoteToken,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      options,
    };
  }

  private confirm(quoteToken: string, optionId: string, idempotencyKey: string): Record<string, unknown> {
    const existing = this.confirmations.get(idempotencyKey);
    if (existing) return existing;
    const quote = this.quotes.get(quoteToken);
    if (!quote || quote.expiresAtMs < Date.now()) {
      throw new ReservationToolError("STALE_QUOTE", "The mock quote expired and must be refreshed.");
    }
    const option = quote.options.find((candidate) => candidate.optionId === optionId);
    if (!option) throw new ReservationToolError("OPTION_NOT_FOUND", "That option is not part of this quote.");
    const reservation = this.reservations.get(quote.reservationId);
    if (!reservation || reservation.version !== quote.reservationVersion) {
      throw new ReservationToolError("CONFLICT", "The synthetic reservation changed after the quote was created.");
    }

    const oldStay = structuredClone(reservation.stay);
    reservation.stay = {
      ...reservation.stay,
      checkIn: option.checkIn,
      checkOut: option.checkOut,
      roomType: option.roomType,
      totalPriceCents: reservation.stay.totalPriceCents + option.priceDeltaCents,
    };
    reservation.status = "changed";
    reservation.version += 1;
    const result = {
      action: "confirm_date_change",
      changeId: `chg_${randomUUID()}`,
      mockConfirmationNumber: `MPC-${randomUUID().slice(0, 8).toUpperCase()}`,
      oldStay,
      reservation: this.publicReservation(reservation),
      selectedOption: option,
      disclaimer: "Synthetic change only. No booking or payment was made.",
    };
    this.confirmations.set(idempotencyKey, result);
    return result;
  }

  private publicReservation(record: ReservationRecord): PublicReservation {
    return {
      reservationId: record.reservationId,
      confirmationCode: record.confirmationCode,
      travelerDisplayName: record.travelerDisplayName,
      guests: record.guests,
      status: record.status,
      stay: structuredClone(record.stay),
    };
  }
}
