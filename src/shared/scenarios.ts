import type { DemoScenario, HotelStay } from "./contracts.js";

export interface ReservationSeed {
  reservationId: string;
  confirmationCode: string;
  firstName: string;
  lastName: string;
  guests: number;
  stay: HotelStay;
}

export const reservationSeeds: ReservationSeed[] = [
  {
    reservationId: "res_lisbon_4821",
    confirmationCode: "MPT-4821",
    firstName: "Jordan",
    lastName: "Lee",
    guests: 2,
    stay: {
      hotelName: "The Lume",
      city: "Lisbon",
      checkIn: "2027-10-12",
      checkOut: "2027-10-16",
      roomType: "River king",
      totalPriceCents: 148_000,
      currency: "USD",
    },
  },
  {
    reservationId: "res_kyoto_7315",
    confirmationCode: "MPT-7315",
    firstName: "Priya",
    lastName: "Patel",
    guests: 1,
    stay: {
      hotelName: "Aoki House",
      city: "Kyoto",
      checkIn: "2027-11-03",
      checkOut: "2027-11-07",
      roomType: "Garden queen",
      totalPriceCents: 126_000,
      currency: "USD",
    },
  },
];

export const demoScenarios: DemoScenario[] = [
  {
    id: "happy_exact",
    shortLabel: "Date change",
    title: "Move a Lisbon stay",
    persona: "Jordan Lee",
    confirmationCode: "MPT-4821",
    lastName: "Lee",
    goal: "Move The Lume to October 20–24 and choose the first option.",
    accent: "Successful change",
    expectedOutcome: "changed",
    expectedReasons: [],
    turns: [
      { caller: "My confirmation code is MPT-4821 and the last name is Lee.", expectState: "collecting_dates" },
      { caller: "Move it to October 20, 2027 through October 24, 2027.", expectState: "awaiting_selection" },
      { caller: "I'll take the first option.", expectState: "awaiting_confirmation" },
      { caller: "Yes, confirm it.", expectState: "ended" },
    ],
  },
  {
    id: "happy_correction",
    shortLabel: "Correction",
    title: "Correct dates, then confirm",
    persona: "Priya Patel",
    confirmationCode: "MPT-7315",
    lastName: "Patel",
    goal: "Correct a date request and choose the flexible third option.",
    accent: "Successful change",
    expectedOutcome: "changed",
    expectedReasons: [],
    turns: [
      { caller: "It's MPT-7315, Patel.", expectState: "collecting_dates" },
      { caller: "Change it to November 11 through November 9, 2027.", expectState: "collecting_dates" },
      { caller: "Sorry, November 11 through November 15, 2027.", expectState: "awaiting_selection" },
      { caller: "The third option works.", expectState: "awaiting_confirmation" },
      { caller: "Yes, go ahead and confirm that.", expectState: "ended" },
    ],
  },
  {
    id: "payment_penalty",
    shortLabel: "Payment",
    title: "Dispute a cancellation charge",
    persona: "Jordan Lee",
    confirmationCode: "MPT-4821",
    lastName: "Lee",
    goal: "Dispute a charge connected to a cancellation penalty.",
    accent: "Mandatory escalation",
    expectedOutcome: "escalated",
    expectedReasons: ["payment_dispute", "cancellation_penalty"],
    turns: [{ caller: "I cancelled and you charged me a penalty twice. I dispute that charge.", expectState: "ended" }],
  },
  {
    id: "urgent_disruption",
    shortLabel: "Urgent",
    title: "Stranded tonight",
    persona: "Priya Patel",
    confirmationCode: "MPT-7315",
    lastName: "Patel",
    goal: "Report a same-day hotel closure while stranded.",
    accent: "Urgent escalation",
    expectedOutcome: "escalated",
    expectedReasons: ["urgent_disruption"],
    turns: [{ caller: "My hotel closed tonight and I'm stranded in Kyoto right now.", expectState: "ended" }],
  },
  {
    id: "identity_uncertainty",
    shortLabel: "Uncertainty",
    title: "Identity cannot be verified",
    persona: "Taylor Morgan",
    confirmationCode: "MPT-0000",
    lastName: "Morgan",
    goal: "Fail reservation verification twice to test safe escalation.",
    accent: "Uncertainty escalation",
    expectedOutcome: "escalated",
    expectedReasons: ["uncertainty"],
    turns: [
      { caller: "The code is MPT-0000 and the last name is Morgan.", expectState: "identifying" },
      { caller: "No, that's definitely MPT-0000, Morgan.", expectState: "ended" },
    ],
  },
];

export function scenarioById(id: string): DemoScenario {
  return demoScenarios.find((scenario) => scenario.id === id) ?? demoScenarios[0];
}
