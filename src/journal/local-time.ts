export interface LocalTimestamp {
  occurredAt: string;
  localDate: string;
  localTime: string;
}

export function isLocalDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

/** Capture one instant and the system-local date and time used by the journal. */
export function localTimestamp(date: Date): LocalTimestamp {
  if (Number.isNaN(date.valueOf())) {
    throw new Error("Cannot create a journal timestamp from an invalid date");
  }
  return {
    occurredAt: date.toISOString(),
    localDate: [date.getFullYear(), date.getMonth() + 1, date.getDate()]
      .map((value, index) => String(value).padStart(index === 0 ? 4 : 2, "0"))
      .join("-"),
    localTime: `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`,
  };
}
