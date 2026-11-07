import { describe, expect, it } from "vitest";
import { IcsError, parseIcs, type ParseOptions } from "../src/calendar/ics.js";

const OPTIONS: ParseOptions = {
  timeZone: "America/Chicago",
  windowStart: new Date("2026-10-01T00:00:00Z"),
  windowEnd: new Date("2027-01-01T00:00:00Z"),
};

function calendar(...lines: string[]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", ...lines, "END:VCALENDAR", ""].join("\r\n");
}

function event(...lines: string[]): string[] {
  return ["BEGIN:VEVENT", ...lines, "END:VEVENT"];
}

const iso = (date: Date) => date.toISOString();

describe("parseIcs", () => {
  it("reads UTC, IANA-zoned and floating times", () => {
    const result = parseIcs(
      calendar(
        "X-WR-CALNAME:Classes",
        ...event("UID:a", "SUMMARY:UTC", "DTSTART:20261106T150000Z", "DTEND:20261106T160000Z"),
        // No VTIMEZONE in the file: the IANA name is enough.
        ...event("UID:b", "SUMMARY:Zoned", "DTSTART;TZID=America/New_York:20261106T090000", "DTEND;TZID=America/New_York:20261106T100000"),
        // Floating: read in the user's zone (Chicago).
        ...event("UID:c", "SUMMARY:Floating", "LOCATION:  Siebel   1404 ", "DTSTART:20261106T090000", "DURATION:PT90M"),
      ),
      OPTIONS,
    );
    expect(result.name).toBe("Classes");
    expect(result.truncated).toBe(false);
    expect(result.events.map((e) => [e.title, iso(e.startAt), iso(e.endAt), e.busy])).toEqual([
      ["Zoned", "2026-11-06T14:00:00.000Z", "2026-11-06T15:00:00.000Z", true],
      ["UTC", "2026-11-06T15:00:00.000Z", "2026-11-06T16:00:00.000Z", true],
      ["Floating", "2026-11-06T15:00:00.000Z", "2026-11-06T16:30:00.000Z", true],
    ]);
    expect(result.events[2]?.location).toBe("Siebel 1404");
  });

  it("uses a time zone the file defines itself", () => {
    const result = parseIcs(
      calendar(
        "BEGIN:VTIMEZONE",
        "TZID:Central Standard Time",
        "BEGIN:STANDARD",
        "DTSTART:16011104T020000",
        "RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=11",
        "TZOFFSETFROM:-0500",
        "TZOFFSETTO:-0600",
        "END:STANDARD",
        "BEGIN:DAYLIGHT",
        "DTSTART:16010311T020000",
        "RRULE:FREQ=YEARLY;BYDAY=2SU;BYMONTH=3",
        "TZOFFSETFROM:-0600",
        "TZOFFSETTO:-0500",
        "END:DAYLIGHT",
        "END:VTIMEZONE",
        ...event(
          "UID:outlook",
          "SUMMARY:Office hours",
          "DTSTART;TZID=Central Standard Time:20261020T130000",
          "DTEND;TZID=Central Standard Time:20261020T140000",
        ),
        ...event("UID:moz", "SUMMARY:Prefixed", "DTSTART;TZID=/mozilla.org/20070129_1/America/Chicago:20261106T130000", "DURATION:PT1H"),
      ),
      OPTIONS,
    );
    expect(result.events.map((e) => [e.title, iso(e.startAt)])).toEqual([
      // 20 October is daylight time (UTC-5).
      ["Office hours", "2026-10-20T18:00:00.000Z"],
      ["Prefixed", "2026-11-06T19:00:00.000Z"],
    ]);
  });

  it("keeps all-day events as dates that don't block study time", () => {
    const result = parseIcs(
      calendar(
        ...event("UID:break", "SUMMARY:Fall break", "DTSTART;VALUE=DATE:20261121", "DTEND;VALUE=DATE:20261130"),
        ...event("UID:holiday", "SUMMARY:Holiday", "DTSTART;VALUE=DATE:20261126"),
      ),
      OPTIONS,
    );
    expect(result.events.map((e) => [e.title, iso(e.startAt), iso(e.endAt), e.allDay, e.busy])).toEqual([
      ["Fall break", "2026-11-21T00:00:00.000Z", "2026-11-30T00:00:00.000Z", true, false],
      ["Holiday", "2026-11-26T00:00:00.000Z", "2026-11-27T00:00:00.000Z", true, false],
    ]);
  });

  it("expands weekly classes with skipped, moved and cancelled meetings, keeping wall-clock time across DST", () => {
    const result = parseIcs(
      calendar(
        ...event(
          "UID:lecture",
          "SUMMARY:CS 409 Lecture",
          "DTSTART;TZID=America/Chicago:20261020T110000",
          "DTEND;TZID=America/Chicago:20261020T121500",
          "RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=6",
          "EXDATE;TZID=America/Chicago:20261027T110000",
        ),
        ...event(
          "UID:lecture",
          "RECURRENCE-ID;TZID=America/Chicago:20261103T110000",
          "SUMMARY:CS 409 Lecture (moved)",
          "DTSTART;TZID=America/Chicago:20261104T150000",
          "DTEND;TZID=America/Chicago:20261104T161500",
        ),
        ...event(
          "UID:lecture",
          "RECURRENCE-ID;TZID=America/Chicago:20261110T110000",
          "STATUS:CANCELLED",
          "SUMMARY:CS 409 Lecture",
          "DTSTART;TZID=America/Chicago:20261110T110000",
          "DTEND;TZID=America/Chicago:20261110T121500",
        ),
      ),
      OPTIONS,
    );
    expect(result.events.map((e) => [e.title, iso(e.startAt)])).toEqual([
      ["CS 409 Lecture", "2026-10-20T16:00:00.000Z"],
      ["CS 409 Lecture (moved)", "2026-11-04T21:00:00.000Z"],
      ["CS 409 Lecture", "2026-11-17T17:00:00.000Z"],
      ["CS 409 Lecture", "2026-11-24T17:00:00.000Z"],
    ]);
  });

  it("drops events outside the window and marks transparent ones free", () => {
    const result = parseIcs(
      calendar(
        ...event("UID:old", "SUMMARY:Old", "DTSTART:20250101T150000Z", "DTEND:20250101T160000Z"),
        ...event("UID:free", "SUMMARY:Optional", "TRANSP:TRANSPARENT", "DTSTART:20261106T150000Z", "DTEND:20261106T160000Z"),
        ...event("UID:daily", "SUMMARY:Daily", "DTSTART:20200101T150000Z", "DTEND:20200101T151500Z", "RRULE:FREQ=DAILY"),
      ),
      { ...OPTIONS, windowStart: new Date("2026-11-06T00:00:00Z"), windowEnd: new Date("2026-11-09T00:00:00Z") },
    );
    expect(result.events.map((e) => [e.title, iso(e.startAt), e.busy])).toEqual([
      ["Optional", "2026-11-06T15:00:00.000Z", false],
      ["Daily", "2026-11-06T15:00:00.000Z", true],
      ["Daily", "2026-11-07T15:00:00.000Z", true],
      ["Daily", "2026-11-08T15:00:00.000Z", true],
    ]);
  });

  it("stops at the event and step limits instead of expanding forever", () => {
    const daily = calendar(...event("UID:d", "SUMMARY:Daily", "DTSTART:20261001T150000Z", "DURATION:PT15M", "RRULE:FREQ=DAILY"));
    const capped = parseIcs(daily, { ...OPTIONS, maxEvents: 10 });
    expect(capped.events).toHaveLength(10);
    expect(capped.truncated).toBe(true);
    const minutely = calendar(...event("UID:m", "SUMMARY:Spam", "DTSTART:19000101T000000Z", "RRULE:FREQ=MINUTELY"));
    expect(parseIcs(minutely, { ...OPTIONS, maxSteps: 500 })).toMatchObject({ events: [], truncated: true });
  });

  it("names a missing title and skips events without a start", () => {
    const result = parseIcs(
      calendar(...event("UID:x", "DTSTART:20261106T150000Z", "DTEND:20261106T160000Z"), ...event("UID:y", "SUMMARY:No start")),
      OPTIONS,
    );
    expect(result.events.map((e) => e.title)).toEqual(["Busy"]);
  });

  it("rejects files that aren't calendars", () => {
    expect(() => parseIcs("hello", OPTIONS)).toThrow(IcsError);
    expect(() => parseIcs("BEGIN:VCARD\r\nVERSION:3.0\r\nEND:VCARD\r\n", OPTIONS)).toThrow(IcsError);
  });
});
