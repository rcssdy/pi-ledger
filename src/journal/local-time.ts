export interface LocalTimestamp {
  occurredAt: string;
  localDate: string;
  localTime: string;
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
