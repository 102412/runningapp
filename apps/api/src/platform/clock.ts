/** Injectable time source so expiry logic is testable without sleeping. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Test clock: starts at a fixed instant and only moves when told to. */
export class ManualClock implements Clock {
  private current: Date;

  constructor(start: Date = new Date()) {
    this.current = start;
  }

  now(): Date {
    return new Date(this.current);
  }

  advanceSeconds(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }

  set(date: Date): void {
    this.current = date;
  }
}
