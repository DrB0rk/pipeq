export type TerminalMouseEvent = {
  action: "press" | "release" | "move";
  button: number;
  x: number;
  y: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
};

function decodeMouse(code: number, x: number, y: number, suffix: "m" | "M"): TerminalMouseEvent {
  const isMotion = (code & 32) !== 0;
  const isWheel = (code & 64) !== 0;
  return {
    action: isWheel ? "release" : isMotion ? "move" : suffix === "m" ? "release" : "press",
    button: code & 3,
    x: x - 1,
    y: y - 1,
    shift: (code & 4) !== 0,
    alt: (code & 8) !== 0,
    ctrl: (code & 16) !== 0,
  };
}

export class SgrMouseParser {
  private buffer = "";

  feed(chunk: string): TerminalMouseEvent[] {
    this.buffer += chunk;
    const events: TerminalMouseEvent[] = [];

    while (this.buffer.length > 0) {
      const start = this.buffer.indexOf("\u001B[<");
      if (start < 0) {
        this.buffer = "";
        break;
      }
      if (start > 0) this.buffer = this.buffer.slice(start);

      const match = /^\u001B\[<(\d+);(\d+);(\d+)([mM])/.exec(this.buffer);
      if (!match) break;

      events.push(decodeMouse(Number(match[1]), Number(match[2]), Number(match[3]), match[4] as "m" | "M"));
      this.buffer = this.buffer.slice(match[0].length);
    }

    return events;
  }
}
